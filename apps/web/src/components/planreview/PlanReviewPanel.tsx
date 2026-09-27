/**
 * T3-CUSTOM(expbkt3): the native plan review panel.
 *
 * Default export so `ChatView` can `lazy()` it — Plate is ~200 kB gzip and must
 * not land in the main chunk. Everything the panel needs arrives over the fork
 * `planReview.*` RPCs; the live subscription keeps every open client converged.
 */
import type {
  EnvironmentId,
  PlanReviewSnapshotResult,
  PlanReviewVersion,
} from "@t3tools/contracts";
import {
  CheckIcon,
  ChevronsLeftRightIcon,
  ChevronsRightLeftIcon,
  HistoryIcon,
  MessageSquareIcon,
  MessageSquarePlusIcon,
  SaveIcon,
  SendIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { PlanReviewDiscussions } from "./PlanReviewDiscussions";
import { PlanReviewEditor, type PlanReviewEditorHandle } from "./PlanReviewEditor";
import { PlanReviewHtmlView } from "./PlanReviewHtmlView";
import { PlanReviewOutline } from "./PlanReviewOutline";
import { PlanReviewVersions } from "./PlanReviewVersions";
import {
  canStepPlanContentWidth,
  PLAN_CONTENT_WIDTH_CLASS,
  PLAN_CONTENT_WIDTH_LABEL,
  usePlanContentWidth,
} from "./planReviewContentWidth";
import {
  countPlanOutlineComments,
  parsePlanOutline,
  type PlanOutlineHeading,
} from "@t3tools/client-runtime/state/planReviewMarkdown";
import { locateQuotedLineRange } from "@t3tools/shared/planReview";
import { Button } from "../ui/button";
import { cn } from "../../lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { planReviewEnvironment } from "../../state/planReview";
import { toastManager } from "../ui/toast";
import { useAtomCommand } from "../../state/use-atom-command";
import { useCurrentUserId } from "../../state/identity";
import { useEnvironmentQuery } from "../../state/query";
import {
  PlanReviewConversationComposerTarget,
  usePlanReviewScrollSurfaceRef,
} from "../../fork/planReviewComposerDock";
import { canHidePlanGlobalNote, shouldShowPlanGlobalNote } from "../../fork/planReviewGlobalNote";

interface PlanReviewPanelProps {
  readonly environmentId: EnvironmentId;
  readonly documentId: string;
  readonly onClose: () => void;
  readonly showConversationComposer?: boolean;
}

type PanelTab = "review" | "versions";

const DRAFT_SAVE_DEBOUNCE_MS = 500;

export default function PlanReviewPanel({
  environmentId,
  documentId,
  onClose,
  showConversationComposer = false,
}: PlanReviewPanelProps) {
  const [tab, setTab] = useState<PanelTab>("review");
  const [suggestionMode, setSuggestionMode] = useState(true);
  const [globalComment, setGlobalComment] = useState("");
  // The overall note rests behind a button in the rail; see planReviewGlobalNote.
  const [isGlobalNoteOpen, setIsGlobalNoteOpen] = useState(false);
  // A boolean, not the document: keeping the markdown in state would re-render
  // the panel — and the editor beneath it — on every keystroke.
  const [hasLocalEdits, setHasLocalEdits] = useState(false);
  const [roundTripWarning, setRoundTripWarning] = useState(false);
  const [comparison, setComparison] = useState<{ from: string; to: string } | null>(null);
  // One selected discussion, shared by the document highlight and the rail card,
  // so the two always agree on which comment the reviewer is looking at.
  const [activeDiscussionId, setActiveDiscussionId] = useState<string | null>(null);

  const revisionTokenRef = useRef<string | null>(null);
  const editedMarkdownRef = useRef<string | null>(null);
  const draftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editorHandleRef = useRef<PlanReviewEditorHandle | null>(null);
  const globalNoteRef = useRef<HTMLTextAreaElement | null>(null);
  // Read inside the save callback without making it depend on every snapshot.
  const latestDraftRef = useRef<PlanReviewSnapshotResult["draft"]>(null);

  const initial = useEnvironmentQuery(
    planReviewEnvironment.review({ environmentId, input: { documentId } }),
  );
  const live = useEnvironmentQuery(
    planReviewEnvironment.subscription({ environmentId, input: { documentId } }),
  );

  // The subscription supersedes the one-shot read as soon as it produces a
  // frame, so the panel never renders stale state after another client writes.
  const snapshot: PlanReviewSnapshotResult | null = live.data ?? initial.data ?? null;

  const diffQuery = useEnvironmentQuery(
    comparison === null
      ? null
      : planReviewEnvironment.versionDiff({
          environmentId,
          input: {
            documentId,
            fromVersionId: comparison.from,
            toVersionId: comparison.to,
          },
        }),
  );

  const saveDraft = useAtomCommand(planReviewEnvironment.saveDraft, { reportFailure: false });
  const upsertDiscussion = useAtomCommand(planReviewEnvironment.upsertDiscussion);
  const resolveDiscussion = useAtomCommand(planReviewEnvironment.resolveDiscussion);
  const cutVersion = useAtomCommand(planReviewEnvironment.cutVersion);
  const submit = useAtomCommand(planReviewEnvironment.submit);

  const latestVersion = useMemo(() => snapshot?.versions.at(-1) ?? null, [snapshot?.versions]);

  const viewerUserId = useCurrentUserId();
  // The document column is what the reviewer scrolls while reading, so it is
  // the surface the docked composer's collapse gesture watches.
  const scrollSurfaceRef = usePlanReviewScrollSurfaceRef();
  const [contentWidth, stepContentWidth] = usePlanContentWidth();

  // Adopt a token only from our own save. Taking whatever the last writer
  // produced would make the next save look valid and silently overwrite them.
  useEffect(() => {
    latestDraftRef.current = snapshot?.draft ?? null;
    if (revisionTokenRef.current === null && snapshot?.draft) {
      revisionTokenRef.current = snapshot.draft.revisionToken;
    }
  }, [snapshot?.draft]);

  // A resolved review is history: it stays readable, but nothing can be sent
  // from it twice.
  const isResolved = snapshot !== null && snapshot.document.status !== "open";
  const versionMarkdown = latestVersion?.contentMarkdown ?? "";

  // A saved draft is what this reviewer was last working on, so it — not the
  // committed version — is what the editor should reopen with. Without this the
  // panel silently discards unsaved edits on every close or tab switch.
  const draftMarkdown = useMemo(() => {
    if (!snapshot?.draft || snapshot.draft.baseVersionId !== latestVersion?.versionId) return null;
    try {
      const parsed: unknown = JSON.parse(snapshot.draft.contentValueJson);
      const markdown = (parsed as { markdown?: unknown }).markdown;
      return typeof markdown === "string" && markdown.trim().length > 0 ? markdown : null;
    } catch {
      return null;
    }
  }, [snapshot?.draft, latestVersion?.versionId]);

  // Seeded once per version: re-seeding from the live draft on every frame
  // would fight the reviewer's cursor.
  const [seededDraft, setSeededDraft] = useState<string | null>(null);
  const seededForVersionRef = useRef<string | null>(null);
  useEffect(() => {
    const versionId = latestVersion?.versionId ?? null;
    if (seededForVersionRef.current === versionId) return;
    seededForVersionRef.current = versionId;
    setSeededDraft(draftMarkdown);
  }, [draftMarkdown, latestVersion?.versionId]);

  const canonicalMarkdown = seededDraft ?? versionMarkdown;
  // A restored draft is already ahead of the committed version, so the panel
  // opens dirty even before the reviewer types.
  const isDirty =
    hasLocalEdits || (seededDraft?.trim() ?? versionMarkdown.trim()) !== versionMarkdown.trim();

  /**
   * Typing must not serialize the document or re-render the panel. It flips one
   * boolean the first time and schedules the debounced save, which is the only
   * place the markdown is actually pulled out of the editor.
   */
  const handleEditorChanged = useCallback(() => {
    setHasLocalEdits(true);
    if (draftTimerRef.current !== null) clearTimeout(draftTimerRef.current);
    draftTimerRef.current = setTimeout(() => {
      const markdown = editorHandleRef.current?.getMarkdown() ?? "";
      if (markdown.trim().length === 0) return;
      editedMarkdownRef.current = markdown;

      void saveDraft({
        environmentId,
        input: {
          documentId,
          contentValueJson: JSON.stringify({ markdown }),
          expectedRevisionToken: revisionTokenRef.current,
        },
      }).then((result) => {
        if (result._tag === "Success") {
          revisionTokenRef.current = result.value.revisionToken;
          return;
        }

        // A rejected save only means somebody *else* is editing when the draft
        // on the server belongs to somebody else. Our own saves can land out of
        // order — that is a token to catch up on, not a conflict to report.
        const draft = latestDraftRef.current;
        const owner = draft?.updatedByUserId ?? null;
        const isOurs = owner === null || owner === viewerUserId;
        if (isOurs) {
          if (draft) revisionTokenRef.current = draft.revisionToken;
          return;
        }

        toastManager.add({
          type: "error",
          title: "Someone else edited this plan",
          description: "Reload the panel to pick up their changes before saving again.",
        });
      });
    }, DRAFT_SAVE_DEBOUNCE_MS);
  }, [documentId, environmentId, saveDraft, viewerUserId]);

  // Stable identity: an inline arrow here would defeat the editor's `memo` and
  // re-render the whole Plate tree on every panel state change.
  const handleRoundTripUnstable = useCallback(() => setRoundTripWarning(true), []);

  /** The document as it stands, pulled from the editor only when needed. */
  const readCurrentMarkdown = useCallback(
    () => editorHandleRef.current?.getMarkdown() || editedMarkdownRef.current || canonicalMarkdown,
    [canonicalMarkdown],
  );

  useEffect(
    () => () => {
      if (draftTimerRef.current !== null) clearTimeout(draftTimerRef.current);
    },
    [],
  );

  // Opening the note is the reviewer saying they want to type in it, so the
  // caret goes there rather than making them click the box they just revealed.
  useEffect(() => {
    if (!isGlobalNoteOpen) return;
    globalNoteRef.current?.focus();
  }, [isGlobalNoteOpen]);

  // The editor owns the id so it can highlight the span it still has selected,
  // rather than waiting for the round trip to learn what to mark.
  const handleAddComment = useCallback(
    (discussionId: string, quotedText: string, body: string) => {
      setActiveDiscussionId(discussionId);
      void upsertDiscussion({
        environmentId,
        input: { documentId, discussionId, quotedText, bodyMarkdown: body },
      });
    },
    [documentId, environmentId, upsertDiscussion],
  );

  /** Selecting from either side scrolls the other into view. */
  const handleSelectDiscussion = useCallback((discussionId: string) => {
    setActiveDiscussionId(discussionId);
    editorHandleRef.current?.scrollToDiscussion(discussionId);
  }, []);

  const handleSelectHeading = useCallback((heading: PlanOutlineHeading) => {
    editorHandleRef.current?.scrollToHeading(heading.text);
  }, []);

  const outlineHeadings = useMemo(() => parsePlanOutline(canonicalMarkdown), [canonicalMarkdown]);

  /**
   * Comment counts per section, derived from the same locator the server uses to
   * anchor feedback — so a comment counted here is a comment the agent will be
   * told the line of, and an unlocatable one is silently uncounted in both.
   */
  const outlineCommentCounts = useMemo(() => {
    const openDiscussions = (snapshot?.discussions ?? []).filter(
      (discussion) => !discussion.isResolved,
    );
    return countPlanOutlineComments(
      outlineHeadings,
      openDiscussions.map(
        (discussion) =>
          locateQuotedLineRange(canonicalMarkdown, discussion.quotedText)?.startIndex ?? null,
      ),
    );
  }, [canonicalMarkdown, outlineHeadings, snapshot?.discussions]);

  const editorDiscussions = useMemo(
    () =>
      (snapshot?.discussions ?? []).map((discussion) => ({
        discussionId: discussion.discussionId,
        quotedText: discussion.quotedText,
        isResolved: discussion.isResolved,
      })),
    [snapshot?.discussions],
  );

  const handleResolve = useCallback(
    (discussionId: string, isResolvedNext: boolean) => {
      void resolveDiscussion({
        environmentId,
        input: { documentId, discussionId, isResolved: isResolvedNext },
      });
    },
    [documentId, environmentId, resolveDiscussion],
  );

  const handleSaveVersion = useCallback(() => {
    if (!isDirty) return;
    const contentMarkdown = readCurrentMarkdown();
    void cutVersion({
      environmentId,
      input: {
        documentId,
        contentMarkdown,
        contentValueJson: null,
        summary: null,
      },
    }).then((result) => {
      if (result._tag === "Success") {
        setHasLocalEdits(false);
        editedMarkdownRef.current = null;
        toastManager.add({ type: "success", title: "Saved a new version of the plan" });
      }
    });
  }, [cutVersion, documentId, environmentId, isDirty, readCurrentMarkdown]);

  const handleRestore = useCallback(
    (version: PlanReviewVersion) => {
      // Restoring appends rather than rewriting: history stays append-only.
      void cutVersion({
        environmentId,
        input: {
          documentId,
          contentMarkdown: version.contentMarkdown,
          contentValueJson: null,
          summary: `Restored v${version.revision}`,
        },
      }).then((result) => {
        if (result._tag === "Success") {
          setHasLocalEdits(false);
          editedMarkdownRef.current = null;
          setTab("review");
        }
      });
    },
    [cutVersion, documentId, environmentId],
  );

  const handleSubmit = useCallback(
    (decision: "approved" | "changes-requested" | "discarded") => {
      void submit({
        environmentId,
        input: {
          documentId,
          decision,
          globalComment,
          editedMarkdown: isDirty ? readCurrentMarkdown() : null,
        },
      }).then((result) => {
        if (result._tag !== "Success") return;
        setGlobalComment("");
        setIsGlobalNoteOpen(false);
        setHasLocalEdits(false);
        editedMarkdownRef.current = null;
        if (decision === "approved") {
          toastManager.add({
            type: "success",
            title: "Plan approved",
            description: result.value.resentPlan
              ? "The full plan was re-sent because this session lost it from context."
              : "Implementation started.",
          });
        } else if (decision === "changes-requested") {
          toastManager.add({ type: "success", title: "Feedback sent to the planning agent" });
        }
        onClose();
      });
    },
    [documentId, environmentId, globalComment, isDirty, onClose, readCurrentMarkdown, submit],
  );

  if (snapshot === null) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-4">
        <p className="text-muted-foreground text-sm">
          {initial.error ? "This plan review could not be loaded." : "Loading plan…"}
        </p>
      </div>
    );
  }

  const openDiscussionCount = snapshot.discussions.filter(
    (discussion) => !discussion.isResolved,
  ).length;

  const isHtmlPlan = snapshot.document.format === "html";
  const showOutline = tab === "review" && !isHtmlPlan && outlineHeadings.length > 0;
  const hasFeedbackToSend = openDiscussionCount > 0 || globalComment.trim().length > 0 || isDirty;
  const showGlobalNote = shouldShowPlanGlobalNote({
    isOpen: isGlobalNoteOpen,
    note: globalComment,
  });
  /**
   * A hand edit that is not yet a version. An HTML plan is never editable, so it
   * can never be in this state and must not be gated by it.
   */
  const hasUnsavedEdits = isDirty && !isHtmlPlan;

  return (
    /*
      The document column owns the full height of the panel. Every control —
      the view switch, the notes box and the decisions — lives in the rail, so
      reading the plan is never traded against chrome. This is the layout the
      reviewer asked for after living with a header and a footer eating ~150px
      of a tall, narrow panel.
    */
    <div className="@container/plan-review flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      <div className="flex min-h-0 min-w-0 flex-1 flex-row">
        <main ref={scrollSurfaceRef} className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          {roundTripWarning && !isHtmlPlan ? (
            <p className="border-amber-500/40 border-b bg-amber-500/10 px-3 py-1.5 text-amber-800 text-xs dark:text-amber-300">
              This plan uses markdown the editor cannot reproduce exactly. Edits may reformat parts
              of it — check the diff before sending.
            </p>
          ) : null}

          {/*
            The outline overlays the document from a 1.75rem gutter instead of
            taking a column of its own. At every panel width the plan is what
            the reviewer came for, and nothing reflows when it opens.
          */}
          <div
            className={cn("relative flex min-h-0 min-w-0 flex-1 flex-col", showOutline && "ps-7")}
          >
            {showOutline ? (
              <PlanReviewOutline
                headings={outlineHeadings}
                commentCounts={outlineCommentCounts}
                onSelectHeading={handleSelectHeading}
              />
            ) : null}
            {tab === "versions" ? (
              <PlanReviewVersions
                versions={snapshot.versions}
                diff={diffQuery.data?.diff ?? null}
                isDiffPending={comparison !== null && diffQuery.isPending}
                canRestore={!isResolved && !isHtmlPlan}
                onCompare={(from, to) => setComparison({ from, to })}
                onRestore={handleRestore}
              />
            ) : isHtmlPlan ? (
              <PlanReviewHtmlView html={canonicalMarkdown} title={snapshot.document.title} />
            ) : (
              <PlanReviewEditor
                markdown={canonicalMarkdown}
                readOnly={isResolved}
                suggestionMode={suggestionMode}
                handleRef={editorHandleRef}
                onChanged={handleEditorChanged}
                onAddComment={handleAddComment}
                onRoundTripUnstable={handleRoundTripUnstable}
                discussions={editorDiscussions}
                activeDiscussionId={activeDiscussionId}
                onSelectDiscussion={handleSelectDiscussion}
                contentWidthClassName={PLAN_CONTENT_WIDTH_CLASS[contentWidth]}
              />
            )}
          </div>
        </main>

        <aside
          className="flex min-h-0 w-72 shrink-0 flex-col border-l"
          aria-label="Plan review controls"
        >
          {/*
            In the takeover the close button is a 32px circle pinned to the
            panel's top-right corner at z-50, which lands on top of this header.
            Anything right-aligned here — the width control, the resolved badge —
            is covered by it and swallows its own clicks, so the row ends early.
          */}
          <nav
            className={cn(
              "flex items-center gap-1 border-b px-2 py-1",
              showConversationComposer && "pe-10",
            )}
          >
            <Button
              size="sm"
              variant={tab === "review" ? "secondary" : "ghost"}
              onClick={() => setTab("review")}
              title={snapshot.document.title}
            >
              <MessageSquareIcon className="size-3.5" aria-hidden /> Review
              {openDiscussionCount > 0 ? (
                <span className="ml-1 rounded-full bg-primary/15 px-1.5 text-[11px] tabular-nums">
                  {openDiscussionCount}
                </span>
              ) : null}
            </Button>
            <Button
              size="sm"
              variant={tab === "versions" ? "secondary" : "ghost"}
              onClick={() => setTab("versions")}
            >
              <HistoryIcon className="size-3.5" aria-hidden /> v{snapshot.document.currentRevision}
            </Button>
            {isResolved ? (
              <span className="ml-auto shrink-0 rounded-full bg-muted px-2 py-0.5 text-muted-foreground text-[11px]">
                {snapshot.document.status === "approved" ? "Approved" : snapshot.document.status}
              </span>
            ) : null}
            {/*
              Side margin for the plan itself, as a labelled control rather than
              two bare icons: a reviewer who has not been told it exists has to
              be able to see what it does. A wide monitor gives the document more
              width than prose wants, and only the reviewer knows whether they
              are reading paragraphs or tables.
            */}
            {tab === "review" && !isHtmlPlan ? (
              <div
                className={cn(
                  "flex items-center gap-px rounded-md border bg-muted/40 p-px",
                  isResolved ? "ms-1" : "ms-auto",
                )}
              >
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        className="size-5 rounded-[5px]"
                        disabled={!canStepPlanContentWidth(contentWidth, -1)}
                        onClick={() => stepContentWidth(-1)}
                        aria-label="Less side margin around the plan"
                      />
                    }
                  >
                    <ChevronsLeftRightIcon className="size-3.5" aria-hidden />
                  </TooltipTrigger>
                  <TooltipPopup side="bottom">Less side margin</TooltipPopup>
                </Tooltip>
                <span className="px-1 text-[10px] text-muted-foreground tabular-nums">
                  {PLAN_CONTENT_WIDTH_LABEL[contentWidth]}
                </span>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        className="size-5 rounded-[5px]"
                        disabled={!canStepPlanContentWidth(contentWidth, 1)}
                        onClick={() => stepContentWidth(1)}
                        aria-label="More side margin around the plan"
                      />
                    }
                  >
                    <ChevronsRightLeftIcon className="size-3.5" aria-hidden />
                  </TooltipTrigger>
                  <TooltipPopup side="bottom">More side margin</TooltipPopup>
                </Tooltip>
              </div>
            ) : null}
          </nav>

          {!isResolved && !isHtmlPlan ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <label className="flex items-center gap-1.5 border-b px-3 py-1.5 text-xs">
                    <input
                      type="checkbox"
                      checked={suggestionMode}
                      onChange={(event) => setSuggestionMode(event.target.checked)}
                    />
                    Suggest edits
                  </label>
                }
              />
              <TooltipPopup side="bottom">
                Record your edits as tracked suggestions instead of editing in place
              </TooltipPopup>
            </Tooltip>
          ) : null}

          <div className="min-h-0 flex-1 overflow-auto">
            {isHtmlPlan ? (
              <p className="p-4 text-muted-foreground text-xs">
                This plan is an HTML document, so it is shown as the agent rendered it. Use the
                overall note below to send feedback.
              </p>
            ) : (
              <PlanReviewDiscussions
                discussions={snapshot.discussions}
                comments={snapshot.comments}
                onResolve={handleResolve}
                disabled={isResolved}
                activeDiscussionId={activeDiscussionId}
                onSelectDiscussion={handleSelectDiscussion}
              />
            )}
          </div>

          {isResolved ? null : (
            <div className="border-t p-2">
              {/*
                The overall note is not the chat bar below it: it travels with
                Approve or Send feedback, where a chat message is its own turn.
                It sits collapsed so an unused box stops taking rail height from
                the comment list, and refuses to collapse once it holds text.
              */}
              {showGlobalNote ? (
                <div className="mb-2">
                  <div className="mb-1 flex items-center gap-1">
                    <span className="min-w-0 truncate text-[11px] text-muted-foreground">
                      Overall note, sent with your decision
                    </span>
                    {canHidePlanGlobalNote(globalComment) ? (
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        className="ms-auto size-5"
                        aria-label="Hide the overall note"
                        onClick={() => setIsGlobalNoteOpen(false)}
                      >
                        <XIcon className="size-3" aria-hidden />
                      </Button>
                    ) : null}
                  </div>
                  <textarea
                    ref={globalNoteRef}
                    className="w-full resize-y rounded-md border bg-background p-2 text-sm"
                    rows={3}
                    value={globalComment}
                    placeholder="Overall notes for the agent (optional)"
                    aria-label="Overall review notes"
                    onChange={(event) => setGlobalComment(event.target.value)}
                  />
                </div>
              ) : (
                <Button
                  size="sm"
                  variant="ghost"
                  className="mb-2 w-full justify-start text-muted-foreground"
                  onClick={() => setIsGlobalNoteOpen(true)}
                >
                  <MessageSquarePlusIcon className="size-3.5 shrink-0" aria-hidden />
                  Add an overall note
                </Button>
              )}
              {/*
              Unsaved edits take the whole row. Deciding on a plan whose edits are
              not yet a version is ambiguous — neither the reviewer nor the agent
              can say afterwards which text was approved — so saving is made the
              one available move rather than a third button competing with two.
            */}
              <div className="flex flex-col gap-1.5">
                {hasUnsavedEdits ? (
                  <>
                    <Button size="sm" onClick={handleSaveVersion}>
                      <SaveIcon className="size-3.5" aria-hidden /> Save the plan
                    </Button>
                    <p className="text-muted-foreground text-[11px]">
                      Save your edits as a version to approve or send feedback.
                    </p>
                  </>
                ) : (
                  /* Stacked, not side by side: the rail is 288px and
                   "Approve with comments" was being cut in half by a shared row. */
                  <div className="flex flex-col gap-1.5">
                    {hasFeedbackToSend ? (
                      <Button size="sm" onClick={() => handleSubmit("changes-requested")}>
                        <SendIcon className="size-3.5 shrink-0" aria-hidden /> Send feedback
                        {openDiscussionCount > 0 ? (
                          <span className="ml-1 rounded-full bg-primary-foreground/20 px-1.5 text-[11px] tabular-nums">
                            {openDiscussionCount}
                          </span>
                        ) : null}
                      </Button>
                    ) : null}
                    <Button
                      size="sm"
                      variant={hasFeedbackToSend ? "outline" : "default"}
                      onClick={() => handleSubmit("approved")}
                      title={
                        openDiscussionCount > 0
                          ? "Start implementing, with your open comments sent as refinements"
                          : undefined
                      }
                    >
                      <CheckIcon className="size-3.5 shrink-0" aria-hidden />
                      <span className="truncate">
                        {openDiscussionCount > 0 ? "Approve with comments" : "Approve"}
                      </span>
                    </Button>
                  </div>
                )}
                <div className="flex items-center gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    className="flex-1"
                    onClick={handleSaveVersion}
                    disabled={!isDirty || isHtmlPlan || hasUnsavedEdits}
                  >
                    Save version
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-destructive"
                    onClick={() => handleSubmit("discarded")}
                    aria-label="Discard this review"
                  >
                    <Trash2Icon className="size-3.5" aria-hidden />
                  </Button>
                </div>
              </div>
            </div>
          )}
        </aside>
      </div>
      {/*
        The conversation bar spans the whole panel, the way the composer spans
        the chat pane: at rail width its placeholder truncated and its controls
        had nowhere to go. It rests until the reviewer uses it, so the plan and
        the comment list keep the height.
      */}
      {showConversationComposer ? <PlanReviewConversationComposerTarget /> : null}
    </div>
  );
}
