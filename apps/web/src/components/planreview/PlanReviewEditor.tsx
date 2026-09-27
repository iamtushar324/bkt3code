/**
 * T3-CUSTOM(expbkt3): the Plate editing surface for a plan document.
 *
 * Suggestion mode is on by default, so every human edit is an attributed
 * insert/delete the reviewer can accept or reject before it becomes a version.
 * The editor owns no persistence: it reports serialized markdown upward and
 * the panel decides when that becomes a draft or a version.
 */
import { CommentPlugin } from "@platejs/comment/react";
import { MarkdownPlugin } from "@platejs/markdown";
import { SuggestionPlugin } from "@platejs/suggestion/react";
import {
  BlockquoteRules,
  BoldRules,
  CodeRules,
  HeadingRules,
  HighlightRules,
  HorizontalRuleRules,
  ItalicRules,
  StrikethroughRules,
} from "@platejs/basic-nodes";
import {
  BlockquotePlugin,
  BoldPlugin,
  CodePlugin,
  H1Plugin,
  H2Plugin,
  H3Plugin,
  H4Plugin,
  H5Plugin,
  H6Plugin,
  HighlightPlugin,
  HorizontalRulePlugin,
  ItalicPlugin,
  KbdPlugin,
  StrikethroughPlugin,
  UnderlinePlugin,
} from "@platejs/basic-nodes/react";
import { CodeBlockRules } from "@platejs/code-block";
import { CodeBlockPlugin, CodeLinePlugin } from "@platejs/code-block/react";
import { LinkPlugin } from "@platejs/link/react";
import { BulletedListRules, OrderedListRules, TaskListRules } from "@platejs/list-classic";
import {
  BulletedListPlugin,
  ListItemContentPlugin,
  ListItemPlugin,
  ListPlugin,
  NumberedListPlugin,
  TaskListPlugin,
} from "@platejs/list-classic/react";
import {
  TableCellHeaderPlugin,
  TableCellPlugin,
  TablePlugin,
  TableRowPlugin,
} from "@platejs/table/react";
import { getCommentKey, getDraftCommentKey } from "@platejs/comment";
import { TextApi } from "platejs";
import { ParagraphPlugin, Plate, PlateContent, usePlateEditor } from "platejs/react";
import remarkGfm from "remark-gfm";
import {
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";

import { PlanReviewCommentComposer } from "./plate/PlanReviewCommentComposer";
import {
  PLAN_REVIEW_QUICK_LABELS,
  PlanReviewFloatingToolbar,
  type PlanReviewQuickLabel,
} from "./plate/PlanReviewFloatingToolbar";
import {
  BlockquoteElement,
  BulletedListElement,
  CodeBlockElement,
  CodeLeaf,
  CodeLineElement,
  H1Element,
  H2Element,
  H3Element,
  H4Element,
  H5Element,
  H6Element,
  HighlightLeaf,
  HorizontalRuleElement,
  KbdLeaf,
  LinkElement,
  ListItemElement,
  NumberedListElement,
  ParagraphElement,
  TableCellElement,
  TableCellHeaderElement,
  TableElement,
  TableRowElement,
  TaskListElement,
} from "./plate/PlanReviewNodes";
import {
  collectPlanReviewBlocks,
  locatePlanReviewQuoteRange,
  stripPlanReviewCommentMarks,
  type PlanReviewNodeLike,
} from "./plate/planReviewCommentMarks";
import {
  CommentLeaf,
  PlanReviewMarkStateProvider,
  SuggestionLeaf,
} from "./plate/PlanReviewReviewMarks";
import {
  hasPlanReviewEditorChange,
  nextPlanDiscussionId,
  normalizeQuotedText,
  resolveSubmittedPlanMarkdown,
} from "@t3tools/client-runtime/state/planReviewMarkdown";
import { replacePlanReviewEditorValue } from "./planReviewEditorValue";
import { cn } from "../../lib/utils";

/**
 * Scoped to what agent plans actually contain — headings, marks, lists, code,
 * tables, links, quotes — plus comments and suggestions. Every plugin carries
 * its component: a registered node type with no component renders as an
 * unstyled block, which is what makes an editor look like a textarea.
 *
 * Kept module-local and unexported: an exported plugin array would force
 * TypeScript to name Plate's internal option types across package boundaries.
 */
const PLAN_REVIEW_PLUGINS = [
  ParagraphPlugin.withComponent(ParagraphElement),
  // `rules.break.empty: "reset"` makes Enter on an empty heading fall back to a
  // paragraph, which is what every markdown editor does.
  H1Plugin.configure({
    inputRules: [HeadingRules.markdown()],
    rules: { break: { empty: "reset" } },
  }).withComponent(H1Element),
  H2Plugin.configure({
    inputRules: [HeadingRules.markdown()],
    rules: { break: { empty: "reset" } },
  }).withComponent(H2Element),
  H3Plugin.configure({
    inputRules: [HeadingRules.markdown()],
    rules: { break: { empty: "reset" } },
  }).withComponent(H3Element),
  H4Plugin.configure({
    inputRules: [HeadingRules.markdown()],
    rules: { break: { empty: "reset" } },
  }).withComponent(H4Element),
  H5Plugin.withComponent(H5Element),
  H6Plugin.withComponent(H6Element),
  BlockquotePlugin.configure({ inputRules: [BlockquoteRules.markdown()] }).withComponent(
    BlockquoteElement,
  ),
  HorizontalRulePlugin.configure({
    inputRules: [
      HorizontalRuleRules.markdown({ variant: "-" }),
      HorizontalRuleRules.markdown({ variant: "_" }),
    ],
  }).withComponent(HorizontalRuleElement),
  CodeBlockPlugin.configure({
    inputRules: [CodeBlockRules.markdown({ on: "match" })],
  }).withComponent(CodeBlockElement),
  CodeLinePlugin.withComponent(CodeLineElement),
  LinkPlugin.withComponent(LinkElement),

  // Classic ul/ol/li lists map straight from markdown, and carry task lists.
  ListPlugin.configure({
    inputRules: [
      BulletedListRules.markdown({ variant: "-" }),
      BulletedListRules.markdown({ variant: "*" }),
      OrderedListRules.markdown({ variant: "." }),
      OrderedListRules.markdown({ variant: ")" }),
      TaskListRules.markdown({ checked: false }),
      TaskListRules.markdown({ checked: true }),
    ],
  }),
  ListItemContentPlugin,
  ListItemPlugin.withComponent(ListItemElement),
  BulletedListPlugin.withComponent(BulletedListElement),
  NumberedListPlugin.withComponent(NumberedListElement),
  TaskListPlugin.withComponent(TaskListElement),

  TablePlugin.withComponent(TableElement),
  TableRowPlugin.withComponent(TableRowElement),
  TableCellPlugin.withComponent(TableCellElement),
  TableCellHeaderPlugin.withComponent(TableCellHeaderElement),

  BoldPlugin.configure({
    inputRules: [BoldRules.markdown({ variant: "*" }), BoldRules.markdown({ variant: "_" })],
  }),
  ItalicPlugin.configure({
    inputRules: [ItalicRules.markdown({ variant: "*" }), ItalicRules.markdown({ variant: "_" })],
  }),
  UnderlinePlugin,
  StrikethroughPlugin.configure({ inputRules: [StrikethroughRules.markdown()] }),
  HighlightPlugin.configure({
    inputRules: [HighlightRules.markdown({ variant: "==" })],
  }).withComponent(HighlightLeaf),
  CodePlugin.configure({ inputRules: [CodeRules.markdown()] }).withComponent(CodeLeaf),
  KbdPlugin.withComponent(KbdLeaf),

  CommentPlugin.withComponent(CommentLeaf),
  SuggestionPlugin.withComponent(SuggestionLeaf),

  // Markdown last: it reads the node types the plugins above registered.
  MarkdownPlugin.configure({ options: { remarkPlugins: [remarkGfm] } }),
];

/**
 * Pull-based access to the document.
 *
 * Serializing the whole tree to markdown costs a full walk plus a
 * remark-stringify pass, so the panel asks for it when it actually needs it —
 * on the debounced save and on submit — rather than on every keystroke.
 */
export interface PlanReviewEditorHandle {
  readonly getMarkdown: () => string;
  /** Brings a commented span into view. Used when the rail card is clicked. */
  readonly scrollToDiscussion: (discussionId: string) => void;
  /** Brings a heading into view. Used by the outline rail. */
  readonly scrollToHeading: (text: string) => void;
}

/** The anchor and resolution state the editor needs to restore a highlight. */
export interface PlanReviewEditorDiscussion {
  readonly discussionId: string;
  readonly quotedText: string;
  readonly isResolved: boolean;
}

interface PlanReviewEditorProps {
  /** Canonical markdown for the version being reviewed. */
  readonly markdown: string;
  readonly readOnly: boolean;
  readonly suggestionMode: boolean;
  readonly handleRef: React.RefObject<PlanReviewEditorHandle | null>;
  /** Cheap notification that the reviewer changed something. */
  readonly onChanged: () => void;
  /**
   * Fires when the reviewer comments on a selection. The editor owns the id so
   * it can mark the span it still has selected, rather than waiting for a round
   * trip to learn what to highlight.
   */
  readonly onAddComment: (discussionId: string, quotedText: string, body: string) => void;
  /** Reports whether Plate's markdown round trip reached a fixed point. */
  readonly onRoundTripUnstable: () => void;
  /** Every discussion on this plan, so their spans can be highlighted. */
  readonly discussions: ReadonlyArray<PlanReviewEditorDiscussion>;
  readonly activeDiscussionId: string | null;
  readonly onSelectDiscussion: (discussionId: string) => void;
  /** Side margin the reviewer chose for the document, as a max-width class. */
  readonly contentWidthClassName: string;
}

function PlanReviewEditorImpl({
  markdown,
  readOnly,
  suggestionMode,
  handleRef,
  onChanged,
  onAddComment,
  onRoundTripUnstable,
  discussions,
  activeDiscussionId,
  onSelectDiscussion,
  contentWidthClassName,
}: PlanReviewEditorProps) {
  const editor = usePlateEditor({ plugins: PLAN_REVIEW_PLUGINS });
  const [pendingQuote, setPendingQuote] = useState<string | null>(null);
  const [commentBody, setCommentBody] = useState("");
  const loadedMarkdownRef = useRef<string | null>(null);
  const baselineEditorMarkdownRef = useRef<string | null>(null);
  const hasReviewerEditsRef = useRef(false);
  // Loading a version fires Plate's onChange; that is not a reviewer edit.
  const loadingRef = useRef(false);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  // The selection the open popover is about, held across the focus change that
  // opening it causes.
  const pendingRangeRef = useRef<object | null>(null);

  const resolvedDiscussionIds = useMemo(
    () =>
      new Set(
        discussions
          .filter((discussion) => discussion.isResolved)
          .map((discussion) => discussion.discussionId),
      ),
    [discussions],
  );

  /**
   * Applies a comment transform without it reading as a reviewer edit.
   *
   * Comment marks are leaf properties that the markdown serializer drops, so
   * `handleChange`'s own comparison would already ignore them — but only until
   * the reviewer's first real edit, after which every change notifies the panel
   * and schedules a draft save. Suppressing the notification outright keeps
   * commenting free of write traffic either way.
   */
  const withoutReportingChange = useCallback((apply: () => void) => {
    const wasLoading = loadingRef.current;
    loadingRef.current = true;
    try {
      apply();
    } finally {
      // Restore on the next frame: Plate's onChange for this transform has not
      // fired yet, and clearing the flag synchronously would let it through.
      requestAnimationFrame(() => {
        loadingRef.current = wasLoading;
      });
    }
  }, []);

  // Load canonical markdown into the editor whenever the reviewed version
  // changes. Guarded by the last-loaded value so our own edits do not reload.
  useEffect(() => {
    if (loadedMarkdownRef.current === markdown) return;
    loadedMarkdownRef.current = markdown;

    try {
      loadingRef.current = true;
      const value = editor.api.markdown.deserialize(markdown);
      const once = editor.api.markdown.serialize({ value });
      const twice = editor.api.markdown.serialize({
        value: editor.api.markdown.deserialize(once),
      });
      baselineEditorMarkdownRef.current = once;
      hasReviewerEditsRef.current = false;
      replacePlanReviewEditorValue(editor, value);
      requestAnimationFrame(() => {
        loadingRef.current = false;
      });

      // Round-trip check: an unstable document would make every later diff
      // full of formatting noise the reviewer never typed.
      if (once !== twice) onRoundTripUnstable();
    } catch {
      loadingRef.current = false;
      onRoundTripUnstable();
    }
  }, [editor, markdown, onRoundTripUnstable]);

  useEffect(() => {
    // Suggestion mode is a plugin option rather than editor state, so it can be
    // toggled without rebuilding the editor and losing the selection.
    editor.setOption(SuggestionPlugin, "isSuggesting", suggestionMode && !readOnly);
  }, [editor, suggestionMode, readOnly]);

  /**
   * Serializes the plan as if it carried no comments.
   *
   * Plate turns a commented leaf into an MDX JSX element that the markdown
   * stringifier cannot handle — in a table cell it throws — and the change
   * handler below reads a failed serialize as a reviewer edit. Highlighting a
   * sentence would then mark the plan dirty and make the panel send the agent the
   * whole document as an edit. Comments are review state, never document content.
   */
  const serializePlan = useCallback(
    () =>
      editor.api.markdown.serialize({
        value: stripPlanReviewCommentMarks(editor.children) as never,
      }),
    [editor],
  );

  /** Marks a located span as belonging to a saved discussion. */
  const markDiscussion = useCallback(
    (discussionId: string, at: object) => {
      // `comment` and the per-id key must be set together: the plugin's
      // normalizer strips a bare `comment` mark that carries no id.
      editor.tf.setNodes(
        { comment: true, [getCommentKey(discussionId)]: true } as never,
        { at, match: TextApi.isText, split: true } as never,
      );
    },
    [editor],
  );

  /** Clears the in-progress draft highlight, wherever it ended up. */
  const clearDraftMark = useCallback(() => {
    const draftKey = getDraftCommentKey();
    withoutReportingChange(() => {
      // Only the draft key is unset; the normalizer removes the now-orphaned
      // `comment` mark, and leaves it alone on a span that also carries a
      // saved id — which is what overlapping comments need.
      editor.tf.unsetNodes([draftKey], {
        at: [],
        match: (node: object) =>
          TextApi.isText(node) && (node as never as Record<string, unknown>)[draftKey] === true,
      } as never);
    });
  }, [editor, withoutReportingChange]);

  /**
   * Restores highlights for discussions this editor has not marked yet.
   *
   * A comment made in this session is marked from the live selection and needs
   * nothing here. This covers the rest: reopening the panel, and a teammate's
   * comment arriving over the subscription.
   */
  useEffect(() => {
    if (discussions.length === 0) return;
    const missing = discussions.filter(
      (discussion) => !editor.api.comment.has({ id: discussion.discussionId }),
    );
    if (missing.length === 0) return;

    const blocks = collectPlanReviewBlocks(
      editor.children as unknown as ReadonlyArray<PlanReviewNodeLike>,
    );
    if (blocks.length === 0) return;

    withoutReportingChange(() => {
      for (const discussion of missing) {
        const range = locatePlanReviewQuoteRange(blocks, discussion.quotedText);
        // A quote whose text the agent has since rewritten simply has no
        // highlight; the rail still carries the comment.
        if (range === null) continue;
        markDiscussion(discussion.discussionId, range);
      }
    });
  }, [discussions, editor, markDiscussion, withoutReportingChange]);

  useImperativeHandle(
    handleRef,
    () => ({
      getMarkdown: () => {
        try {
          const editorMarkdown = serializePlan();
          return resolveSubmittedPlanMarkdown({
            canonicalMarkdown: loadedMarkdownRef.current ?? markdown,
            editorMarkdown,
            hasReviewerEdits: hasReviewerEditsRef.current,
          });
        } catch {
          // A tree mid-edit can be transiently invalid; the caller falls back
          // to the last known good document rather than saving nonsense.
          return "";
        }
      },
      scrollToDiscussion: (discussionId: string) => {
        // The leaf renders its discussion id, so the highlight can be found
        // without a Plate-to-DOM lookup.
        surfaceRef.current
          ?.querySelector(`[data-plan-discussion-id="${CSS.escape(discussionId)}"]`)
          ?.scrollIntoView({ block: "center", behavior: "smooth" });
      },
      scrollToHeading: (text: string) => {
        const surface = surfaceRef.current;
        if (surface === null) return;
        // Matched on rendered text, which is what the outline was parsed into.
        const heading = Array.from(surface.querySelectorAll("h1, h2, h3, h4, h5, h6")).find(
          (element) => element.textContent?.trim() === text,
        );
        heading?.scrollIntoView({ block: "start", behavior: "smooth" });
      },
    }),
    [editor, markdown, serializePlan],
  );

  const handleChange = useCallback(() => {
    if (loadingRef.current) return;
    if (!hasReviewerEditsRef.current) {
      try {
        const baselineEditorMarkdown = baselineEditorMarkdownRef.current;
        if (
          baselineEditorMarkdown !== null &&
          !hasPlanReviewEditorChange({
            baselineEditorMarkdown,
            editorMarkdown: serializePlan(),
          })
        ) {
          return;
        }
      } catch {
        // Treat an editor tree that cannot be serialized as changed so the
        // existing save path can retain its last known good markdown.
      }
      hasReviewerEditsRef.current = true;
    }
    onChanged();
  }, [onChanged, serializePlan]);

  /**
   * Marks the current selection and returns its range, so the span can be
   * promoted to a saved discussion after the reviewer commits.
   *
   * The range is captured before the popover opens, because focusing its
   * textarea collapses the DOM selection and the editor's own selection moves
   * with it.
   */
  const captureSelection = useCallback(() => {
    const quote = normalizeQuotedText(window.getSelection()?.toString() ?? "");
    if (quote.length === 0) return null;
    const range = editor.selection;
    if (!range) return null;
    return { quote, range };
  }, [editor]);

  const startComment = useCallback(() => {
    const captured = captureSelection();
    if (captured === null) return;
    // Highlight immediately: the reviewer sees what they are about to comment on
    // for as long as they are composing it.
    withoutReportingChange(() => editor.tf.comment.setDraft({ at: captured.range } as never));
    pendingRangeRef.current = captured.range;
    setPendingQuote(captured.quote);
    setCommentBody("");
  }, [captureSelection, editor, withoutReportingChange]);

  const cancelComment = useCallback(() => {
    clearDraftMark();
    pendingRangeRef.current = null;
    setPendingQuote(null);
    setCommentBody("");
  }, [clearDraftMark]);

  /** Promotes the draft highlight to a saved discussion and reports it up. */
  const commitComment = useCallback(
    (quotedText: string, body: string, range: object | null) => {
      const discussionId = nextPlanDiscussionId();
      if (range !== null) {
        withoutReportingChange(() => markDiscussion(discussionId, range));
      }
      clearDraftMark();
      onAddComment(discussionId, quotedText, body);
    },
    [clearDraftMark, markDiscussion, onAddComment, withoutReportingChange],
  );

  const submitComment = useCallback(() => {
    if (pendingQuote === null) return;
    const body = commentBody.trim();
    if (body.length === 0) return;
    commitComment(pendingQuote, body, pendingRangeRef.current);
    pendingRangeRef.current = null;
    setPendingQuote(null);
    setCommentBody("");
  }, [commentBody, commitComment, pendingQuote]);

  /** One click, one canned body, no composer. */
  const addQuickLabel = useCallback(
    (label: PlanReviewQuickLabel) => {
      const captured = captureSelection();
      if (captured === null) return;
      commitComment(captured.quote, PLAN_REVIEW_QUICK_LABELS[label], captured.range);
    },
    [captureSelection, commitComment],
  );

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={surfaceRef}
        className="relative min-h-0 flex-1 cursor-text select-text overflow-y-auto caret-primary selection:bg-primary/25"
      >
        <Plate editor={editor} onChange={handleChange}>
          <PlanReviewMarkStateProvider
            resolvedDiscussionIds={resolvedDiscussionIds}
            activeDiscussionId={activeDiscussionId}
            onSelectDiscussion={onSelectDiscussion}
          >
            <PlateContent
              className={cn(
                "mx-auto min-h-full w-full px-5 pt-3 pb-24 text-[15px] text-foreground leading-relaxed outline-none",
                contentWidthClassName,
              )}
              readOnly={readOnly}
              placeholder="This plan is empty."
              aria-label="Plan document"
            />
          </PlanReviewMarkStateProvider>
        </Plate>
        <PlanReviewFloatingToolbar
          containerRef={surfaceRef}
          onComment={startComment}
          onQuickLabel={addQuickLabel}
          readOnly={readOnly}
          hidden={pendingQuote !== null}
        />
      </div>

      {/*
        Outside the scroll container on purpose: as a child it scrolled the plan
        when it took focus, which threw the reviewer back to the top of a long
        document the moment they started writing.
      */}
      {pendingQuote !== null ? (
        <PlanReviewCommentComposer
          quotedText={pendingQuote}
          body={commentBody}
          onBodyChange={setCommentBody}
          onSubmit={submitComment}
          onCancel={cancelComment}
        />
      ) : null}
    </div>
  );
}

export const PlanReviewEditor = memo(PlanReviewEditorImpl);
