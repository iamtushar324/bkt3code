/**
 * T3-CUSTOM(expbkt3): the right-panel "Comments" surface.
 *
 * Cards group under the message they quote. Hovering a card emphasises its
 * highlight in the chat; clicking one navigates the transcript to the quote
 * through upstream's citation navigation, so the scroll-and-pulse behaviour is
 * the one users already know from citation chips.
 */
import { useNavigate } from "@tanstack/react-router";
import type { ScopedThreadRef, ThreadComment } from "@t3tools/contracts";
import {
  CheckCheckIcon,
  CheckIcon,
  EllipsisIcon,
  MessageSquareIcon,
  MessageSquareTextIcon,
  PauseIcon,
  PlayIcon,
  RotateCcwIcon,
  Trash2Icon,
} from "lucide-react";
import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

import ChatMarkdown from "../../components/ChatMarkdown";

import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../../components/ui/empty";
import { Kbd } from "../../components/ui/kbd";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../../components/ui/menu";
import { Textarea } from "../../components/ui/textarea";
import { userDisplayName } from "../../components/ui/avatar";
import { assistantCitationNavigation } from "../../lib/assistantCitationNavigation";
import { cn } from "../../lib/utils";
import { useThread } from "../../state/entities";
import { useCurrentUserId } from "../../state/identity";
import { useOrgMembers } from "../../state/orgMembers";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import {
  useThreadCommentsCommands,
  useThreadCommentsEnabled,
  useThreadCommentsSnapshot,
} from "./hooks";
import { applyMarkdownShortcutToTextarea, markdownShortcutForKey } from "./markdownShortcuts";
import {
  countComments,
  deriveCommentDisplayState,
  filterComments,
  filterCount,
  formatCommentsHeader,
  groupCommentsByMessage,
  matchesCommentsFilter,
  quotePreview,
  THREAD_COMMENT_FILTERS,
  THREAD_COMMENT_KIND_LABEL,
  THREAD_COMMENT_KIND_NOTE,
  THREAD_COMMENT_STATE_LABEL,
  type ThreadCommentDisplayState,
  type ThreadCommentsFilter,
} from "./model";
import { useThreadCommentsUiStore } from "./uiStore";

const PIN_KIND_CLASS: Record<ThreadComment["kind"], string> = {
  comment: "bg-warning text-black/80",
  good: "bg-success text-white",
  okay: "bg-muted-foreground text-background",
  remove: "bg-destructive text-white",
};

const QUOTE_KIND_CLASS: Record<ThreadComment["kind"], string> = {
  comment: "border-warning/70",
  good: "border-success/70",
  okay: "border-muted-foreground/60",
  remove: "border-destructive/70",
};

const STATE_BADGE_VARIANT: Record<ThreadCommentDisplayState, "warning" | "info" | "success"> = {
  open: "warning",
  "agent-replied": "info",
  addressed: "info",
  resolved: "success",
};

/** Comment bodies render like chat messages, in a tighter rhythm for a card. */
function CommentMarkdown({ text, threadRef }: { text: string; threadRef: ScopedThreadRef }) {
  return (
    // A link inside a comment opens like a chat link; it must not also count as
    // a click on the card, which would scroll the transcript.
    <div
      onClick={(event) => {
        if ((event.target as Element).closest("a")) event.stopPropagation();
      }}
    >
      <ChatMarkdown
        text={text}
        cwd={undefined}
        threadRef={threadRef}
        lineBreaks
        className="text-sm leading-snug [&_blockquote]:my-1 [&_ol]:my-1 [&_p]:my-1 [&_pre]:my-1 [&_ul]:my-1"
      />
    </div>
  );
}

/** Cmd/Ctrl+B / I / E / K wrap the textarea selection; returns true when handled. */
function handleMarkdownShortcut(
  event: ReactKeyboardEvent,
  textarea: HTMLTextAreaElement | null,
  onChange: (value: string) => void,
): boolean {
  const action = markdownShortcutForKey(event);
  if (action === null || textarea === null) return false;
  event.preventDefault();
  onChange(applyMarkdownShortcutToTextarea(textarea, action));
  return true;
}

const FOCUS_RING_MS = 1_600;

export function ThreadCommentsPanel({ threadRef }: { threadRef: ScopedThreadRef }) {
  const enabled = useThreadCommentsEnabled(threadRef.environmentId);
  const snapshot = useThreadCommentsSnapshot(threadRef, enabled);
  const thread = useThread(threadRef);
  const commands = useThreadCommentsCommands();
  const [filter, setFilter] = useState<ThreadCommentsFilter>("open");
  const [busy, setBusy] = useState(false);
  const focusRequest = useThreadCommentsUiStore((state) => state.focusRequest);
  const listRef = useRef<HTMLDivElement>(null);

  const comments = snapshot?.comments ?? [];
  const counts = useMemo(() => countComments(comments), [comments]);
  const messages = thread?.messages;
  const groups = useMemo(
    () => groupCommentsByMessage(filterComments(comments, filter), messages ?? []),
    [comments, filter, messages],
  );

  // A pin click names a card; make sure the filter shows it, scroll it into
  // view and ring it briefly. The request is consumed once: cleared when the
  // ring ends, or on unmount if it is still ours, so a remount cannot replay it.
  const focusTargetStatus =
    focusRequest === null
      ? null
      : (comments.find((entry) => entry.commentId === focusRequest.commentId)?.status ?? null);
  const focusedCommentId =
    focusRequest !== null && focusTargetStatus !== null ? focusRequest.commentId : null;
  useEffect(() => {
    if (focusRequest === null || focusTargetStatus === null) return;
    const { commentId, nonce } = focusRequest;
    const clearIfOurs = () => {
      const store = useThreadCommentsUiStore.getState();
      if (store.focusRequest?.nonce === nonce) store.clearFocus();
    };
    let scrollFrame: number | null = null;
    const frame = requestAnimationFrame(() => {
      setFilter((current) =>
        matchesCommentsFilter({ status: focusTargetStatus }, current) ? current : "all",
      );
      scrollFrame = requestAnimationFrame(() => {
        listRef.current
          ?.querySelector(`[data-thread-comment-card="${CSS.escape(commentId)}"]`)
          ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      });
    });
    const timer = setTimeout(clearIfOurs, FOCUS_RING_MS);
    return () => {
      cancelAnimationFrame(frame);
      if (scrollFrame !== null) cancelAnimationFrame(scrollFrame);
      clearTimeout(timer);
      clearIfOurs();
    };
  }, [focusRequest, focusTargetStatus]);

  /** Runs one command at a time; resolves true only when the server accepted it. */
  const run = async (operation: () => Promise<{ readonly _tag: string }>): Promise<boolean> => {
    if (busy) return false;
    setBusy(true);
    try {
      return (await operation())._tag === "Success";
    } finally {
      setBusy(false);
    }
  };

  const environmentId = threadRef.environmentId;
  const threadId = threadRef.threadId;

  // Off (setting or capability): the surface is being closed by ChatView's hook;
  // render nothing rather than a panel of dead controls.
  if (!enabled) return null;

  return (
    <div className="flex h-full min-h-0 flex-col" data-thread-comments-panel>
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
        <MessageSquareTextIcon className="size-4 text-muted-foreground" aria-hidden />
        <span className="min-w-0 flex-1 truncate font-medium text-sm">
          {formatCommentsHeader(counts)}
        </span>
        {counts.addressed > 0 ? (
          <Button
            size="xs"
            variant="outline"
            disabled={busy}
            onClick={() =>
              void run(() =>
                commands.resolveAll({ environmentId, input: { threadId, only: "addressed" } }),
              )
            }
          >
            <CheckIcon aria-hidden />
            Resolve addressed
          </Button>
        ) : null}
        <Button
          size="xs"
          variant="outline"
          disabled={busy || counts.open + counts.addressed === 0}
          onClick={() =>
            void run(() => commands.resolveAll({ environmentId, input: { threadId } }))
          }
        >
          <CheckCheckIcon aria-hidden />
          Resolve all
        </Button>
      </div>
      {snapshot?.deliveryPaused ? (
        <div className="flex shrink-0 items-center gap-2 border-b bg-muted/40 px-3 py-1.5 text-muted-foreground text-xs">
          <PauseIcon className="size-3.5" aria-hidden />
          <span className="min-w-0 flex-1">
            Open comments are paused and not sent to the agent.
          </span>
          <Button
            size="xs"
            variant="ghost"
            disabled={busy}
            onClick={() =>
              void run(() =>
                commands.setDeliveryPaused({ environmentId, input: { threadId, paused: false } }),
              )
            }
          >
            <PlayIcon aria-hidden />
            Resume
          </Button>
        </div>
      ) : null}
      <div
        className="flex shrink-0 flex-wrap items-center gap-1 px-3 py-2"
        role="tablist"
        aria-label="Filter comments"
      >
        {THREAD_COMMENT_FILTERS.map((entry) => {
          const count = filterCount(counts, entry.id);
          return (
            <Button
              key={entry.id}
              role="tab"
              aria-selected={filter === entry.id}
              size="xs"
              variant={filter === entry.id ? "secondary" : "ghost-muted"}
              onClick={() => setFilter(entry.id)}
            >
              {entry.label}
              {count > 0 ? (
                <Badge size="sm" variant={entry.id === "resolved" ? "success" : "warning"}>
                  {count}
                </Badge>
              ) : null}
            </Button>
          );
        })}
      </div>
      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        {comments.length === 0 ? (
          <Empty size="compact">
            <MessageSquareIcon className="size-5 text-muted-foreground" aria-hidden />
            <EmptyHeader>
              <EmptyTitle>No comments yet</EmptyTitle>
              <EmptyDescription>
                Select text in an agent message and choose Comment, Good, Okay or Remove. Open
                comments travel with every message you send until you resolve them.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : groups.length === 0 ? (
          <p className="px-1 py-6 text-center text-muted-foreground text-sm">
            {filter === "resolved"
              ? "Nothing resolved yet."
              : filter === "addressed"
                ? "Nothing addressed yet."
                : "Nothing open."}
          </p>
        ) : (
          groups.map((group) => (
            <section key={group.messageId} className="mb-3">
              <h3 className="mb-1.5 px-1 font-medium text-3xs text-muted-foreground uppercase tracking-wide">
                {group.label}
              </h3>
              <ul className="flex flex-col gap-2">
                {group.comments.map((comment) => (
                  <ThreadCommentCard
                    key={comment.commentId}
                    threadRef={threadRef}
                    comment={comment}
                    busy={busy}
                    focused={focusedCommentId === comment.commentId}
                    onReply={(body) =>
                      run(() =>
                        commands.reply({
                          environmentId,
                          input: { threadId, commentId: comment.commentId, body },
                        }),
                      )
                    }
                    onSetStatus={(status) =>
                      run(() =>
                        commands.setStatus({
                          environmentId,
                          input: { threadId, commentId: comment.commentId, status },
                        }),
                      )
                    }
                    onRemove={() =>
                      run(() =>
                        commands.remove({
                          environmentId,
                          input: { threadId, commentId: comment.commentId },
                        }),
                      )
                    }
                  />
                ))}
              </ul>
            </section>
          ))
        )}
      </div>
    </div>
  );
}

const ThreadCommentCard = memo(function ThreadCommentCard({
  threadRef,
  comment,
  busy,
  focused,
  onReply,
  onSetStatus,
  onRemove,
}: {
  threadRef: ScopedThreadRef;
  comment: ThreadComment;
  busy: boolean;
  focused: boolean;
  onReply: (body: string) => Promise<boolean>;
  onSetStatus: (status: "open" | "resolved") => Promise<boolean>;
  onRemove: () => Promise<boolean>;
}) {
  const navigate = useNavigate();
  const { resolveUser } = useOrgMembers();
  const viewerUserId = useCurrentUserId();
  const [replying, setReplying] = useState(false);
  const [reply, setReply] = useState("");
  const replyRef = useRef<HTMLTextAreaElement>(null);
  const state = deriveCommentDisplayState(comment);
  const resolved = state === "resolved";
  const authorLabel =
    comment.authorUserId !== null && comment.authorUserId === viewerUserId
      ? "You"
      : (comment.authorLabel ??
        (comment.authorUserId === null
          ? "You"
          : userDisplayName(resolveUser(comment.authorUserId))));
  const body =
    comment.body.trim().length > 0 ? comment.body : THREAD_COMMENT_KIND_NOTE[comment.kind];

  const scrollToQuote = () => {
    void navigate(
      assistantCitationNavigation({
        version: 1,
        environmentId: threadRef.environmentId,
        threadId: threadRef.threadId,
        messageId: comment.anchor.messageId,
        text: comment.anchor.text,
        start: comment.anchor.start,
        end: comment.anchor.end,
        prefix: comment.anchor.prefix,
        suffix: comment.anchor.suffix,
      }),
    );
  };

  const submitReply = async () => {
    const text = reply.trim();
    if (text.length === 0) return;
    // A failed or skipped send keeps the draft where the user can retry it.
    if (!(await onReply(text))) return;
    setReply("");
    setReplying(false);
  };

  return (
    <li
      data-thread-comment-card={comment.commentId}
      onClick={scrollToQuote}
      onMouseEnter={() => useThreadCommentsUiStore.getState().setHovered(comment.commentId)}
      onMouseLeave={() => useThreadCommentsUiStore.getState().setHovered(null)}
      className={cn(
        "cursor-pointer rounded-md border p-2 transition-colors hover:bg-accent/40",
        resolved ? "border-border/50 opacity-70" : "border-border",
        focused && "border-primary/70 ring-2 ring-primary/30",
      )}
    >
      <div className="flex items-center gap-1.5 text-xs">
        <span
          aria-label={`${THREAD_COMMENT_KIND_LABEL[comment.kind]} #${comment.number}`}
          className={cn(
            "flex size-4 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold tabular-nums",
            resolved ? "bg-muted text-muted-foreground" : PIN_KIND_CLASS[comment.kind],
          )}
        >
          {comment.number}
        </span>
        <span className="truncate font-medium">{authorLabel}</span>
        <span className="shrink-0 text-muted-foreground">
          · {formatRelativeTimeLabel(comment.createdAt)}
        </span>
        <span className="ms-auto flex shrink-0 items-center gap-1">
          <Badge size="sm" variant={STATE_BADGE_VARIANT[state]}>
            {state === "resolved" || state === "addressed" ? (
              <CheckIcon aria-hidden />
            ) : (
              <span aria-hidden className="size-1.5 rounded-full bg-current" />
            )}
            {THREAD_COMMENT_STATE_LABEL[state]}
          </Badge>
          <Menu>
            <MenuTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost-muted"
                  aria-label="Comment actions"
                  onClick={(event) => event.stopPropagation()}
                />
              }
            >
              <EllipsisIcon />
            </MenuTrigger>
            <MenuPopup align="end" side="bottom" sideOffset={4}>
              <MenuItem
                disabled={busy}
                onClick={(event) => {
                  event.stopPropagation();
                  void onRemove();
                }}
              >
                <Trash2Icon />
                Delete comment #{comment.number}
              </MenuItem>
            </MenuPopup>
          </Menu>
        </span>
      </div>
      <blockquote
        className={cn(
          "mt-1.5 truncate border-l-2 pl-2 text-muted-foreground text-xs",
          QUOTE_KIND_CLASS[comment.kind],
        )}
      >
        {quotePreview(comment.anchor.text)}
      </blockquote>
      <div className="mt-1.5">
        <CommentMarkdown text={body} threadRef={threadRef} />
      </div>
      {comment.replies.length > 0 ? (
        <ul className="mt-2 flex flex-col gap-1.5">
          {comment.replies.map((entry) => (
            <li
              key={entry.replyId}
              className={cn(
                "rounded-md px-2 py-1.5 text-sm",
                entry.author === "agent" ? "border border-border bg-muted/40" : "bg-accent/30",
              )}
            >
              <span className="font-medium text-xs">
                {entry.author === "agent"
                  ? (entry.authorLabel ?? "Agent")
                  : entry.authorUserId !== null && entry.authorUserId === viewerUserId
                    ? "You"
                    : (entry.authorLabel ??
                      (entry.authorUserId === null
                        ? "You"
                        : userDisplayName(resolveUser(entry.authorUserId))))}
              </span>
              <CommentMarkdown text={entry.body} threadRef={threadRef} />
            </li>
          ))}
        </ul>
      ) : null}
      {replying ? (
        <div
          className="mt-2"
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.nativeEvent.isComposing) return;
            if (handleMarkdownShortcut(event, replyRef.current, setReply)) return;
            if (event.key === "Escape") {
              event.preventDefault();
              setReplying(false);
              setReply("");
            } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void submitReply();
            }
          }}
        >
          <Textarea
            ref={replyRef}
            autoFocus
            size="sm"
            value={reply}
            placeholder="Reply…"
            aria-label={`Reply to comment #${comment.number}`}
            disabled={busy}
            onChange={(event) => setReply(event.target.value)}
          />
          <div className="mt-1.5 flex items-center gap-1">
            <span className="text-3xs text-muted-foreground">
              Markdown supported · <Kbd>⌘/Ctrl B</Kbd> <Kbd>I</Kbd> <Kbd>E</Kbd> <Kbd>K</Kbd> ·{" "}
              <Kbd>⌘/Ctrl ↵</Kbd> send
            </span>
            <span className="ms-auto flex gap-1">
              <Button size="xs" variant="ghost" disabled={busy} onClick={() => setReplying(false)}>
                Cancel
              </Button>
              <Button
                size="xs"
                variant="default"
                disabled={busy || reply.trim().length === 0}
                onClick={() => void submitReply()}
              >
                Reply
              </Button>
            </span>
          </div>
        </div>
      ) : null}
      <div className="mt-2 flex items-center gap-1">
        {!replying ? (
          <Button
            size="xs"
            variant="outline"
            disabled={busy}
            onClick={(event) => {
              event.stopPropagation();
              setReplying(true);
            }}
          >
            Reply
          </Button>
        ) : null}
        <span className="ms-auto">
          {resolved ? (
            <Button
              size="xs"
              variant="ghost"
              disabled={busy}
              onClick={(event) => {
                event.stopPropagation();
                void onSetStatus("open");
              }}
            >
              <RotateCcwIcon aria-hidden />
              Reopen
            </Button>
          ) : (
            <Button
              size="xs"
              variant={state === "addressed" ? "default" : "outline"}
              disabled={busy}
              onClick={(event) => {
                event.stopPropagation();
                void onSetStatus("resolved");
              }}
            >
              <CheckIcon aria-hidden />
              Resolve
            </Button>
          )}
        </span>
      </div>
    </li>
  );
});
