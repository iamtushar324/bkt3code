/**
 * T3-CUSTOM(expbkt3): Comment / Good / Okay / Remove beside upstream's Cite.
 *
 * Rendered inside the selection toolbar's group element, so upstream's
 * `observeSelectionActions` already treats these buttons and the inline editor
 * as "the toolbar": clicking or typing in them does not dismiss the captured
 * selection. The three reactions file in one click; Comment opens a small
 * editor quoting the selection.
 */
import { THREAD_COMMENT_MAX_QUOTE_LENGTH, type ThreadCommentKind } from "@t3tools/contracts";
import { MehIcon, MessageSquarePlusIcon, ThumbsUpIcon, Trash2Icon } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";

import { observeAssistantCitationCommentSource } from "../../components/chat/AssistantCitationSource";
import { Button } from "../../components/ui/button";
import { Kbd } from "../../components/ui/kbd";
import { Textarea } from "../../components/ui/textarea";
import { toastManager } from "../../components/ui/toast";
import { cn } from "../../lib/utils";
import { useThreadCommentsCommands, useThreadCommentsEnabled } from "./hooks";
import { applyMarkdownShortcutToTextarea, markdownShortcutForKey } from "./markdownShortcuts";
import { buildCommentAnchor, quotePreview, THREAD_COMMENT_KIND_LABEL } from "./model";
import type { AssistantSelectionToolbarExtrasProps } from "./selectionToolbarExtras";

const isApplePlatform =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.platform);

export function ThreadCommentsSelectionActions({
  citation,
  sourceAnchor,
  threadRef,
  dismiss,
}: AssistantSelectionToolbarExtrasProps) {
  const enabled = useThreadCommentsEnabled(threadRef.environmentId);
  const commands = useThreadCommentsCommands();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [body, setBody] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const tooLong = citation.text.length > THREAD_COMMENT_MAX_QUOTE_LENGTH;

  // While the editor is open the quote keeps a mark, native selection or not.
  useEffect(() => {
    if (!editing) return;
    return observeAssistantCitationCommentSource({
      anchor: sourceAnchor,
      citation,
      onUnavailable: () => {
        setEditing(false);
        toastManager.add({
          type: "warning",
          title: "The quoted text changed",
          description: "Select it again to comment.",
        });
      },
    });
  }, [citation, editing, sourceAnchor]);

  useEffect(() => {
    if (editing) textareaRef.current?.focus({ preventScroll: true });
  }, [editing]);

  if (!enabled) return null;

  const submit = async (kind: ThreadCommentKind, text: string) => {
    if (busy || tooLong) return;
    setBusy(true);
    const result = await commands.add({
      environmentId: threadRef.environmentId,
      input: {
        threadId: threadRef.threadId,
        kind,
        anchor: buildCommentAnchor(citation.messageId, citation),
        body: text,
      },
    });
    setBusy(false);
    if (result._tag !== "Success") return;
    window.getSelection()?.removeAllRanges();
    dismiss();
  };

  const reaction = (kind: Exclude<ThreadCommentKind, "comment">, Icon: typeof ThumbsUpIcon) => (
    <Button
      key={kind}
      type="button"
      size="xs"
      variant="glass"
      disabled={busy || tooLong}
      aria-label={`${THREAD_COMMENT_KIND_LABEL[kind]}: ${
        kind === "good"
          ? "keep this as it is"
          : kind === "okay"
            ? "acceptable, no change needed"
            : "remove this"
      }`}
      className={cn(
        kind === "good" && "text-success",
        kind === "okay" && "text-muted-foreground",
        kind === "remove" && "text-destructive",
      )}
      onPointerDown={(event) => event.preventDefault()}
      onClick={() => void submit(kind, "")}
      onKeyDown={handleButtonKeyDown}
    >
      <Icon aria-hidden="true" className="size-3.5" />
      {THREAD_COMMENT_KIND_LABEL[kind]}
    </Button>
  );

  function handleButtonKeyDown(event: ReactKeyboardEvent) {
    event.stopPropagation();
    if (event.key === "Escape" && !event.nativeEvent.isComposing) {
      event.preventDefault();
      dismiss();
    }
  }

  return (
    <>
      <Button
        type="button"
        size="xs"
        variant="glass"
        disabled={busy || tooLong}
        aria-label={tooLong ? "Selection is too long to comment on" : "Comment on selection"}
        aria-pressed={editing}
        onPointerDown={(event) => event.preventDefault()}
        onClick={() => setEditing((open) => !open)}
        onKeyDown={handleButtonKeyDown}
      >
        <MessageSquarePlusIcon aria-hidden="true" className="size-3.5" />
        Comment
      </Button>
      {reaction("good", ThumbsUpIcon)}
      {reaction("okay", MehIcon)}
      {reaction("remove", Trash2Icon)}
      {editing ? (
        <div
          data-thread-comment-editor
          // Upstream's sidebar Mod+B toggle yields to elements marked this way, so
          // Ctrl/Cmd+B makes text bold here instead of hiding the sidebar.
          data-composer-rich-text="true"
          // `contain: inline-size` keeps the editor out of the toolbar's max-content
          // width, so it wraps below the buttons at exactly their width instead of
          // stretching the (w-max) group to buttons + editor side by side.
          className="basis-full rounded-lg border border-border bg-popover p-2 shadow-md [contain:inline-size]"
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.nativeEvent.isComposing) return;
            const shortcut = markdownShortcutForKey(event);
            // The ui Textarea does not reliably forward its ref; use the key's target.
            const field =
              textareaRef.current ??
              (event.target instanceof HTMLTextAreaElement ? event.target : null);
            if (shortcut !== null && field) {
              event.preventDefault();
              setBody(applyMarkdownShortcutToTextarea(field, shortcut));
              return;
            }
            if (event.key === "Escape") {
              event.preventDefault();
              setEditing(false);
              return;
            }
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              if (body.trim().length > 0) void submit("comment", body.trim());
            }
          }}
        >
          <blockquote className="mb-1.5 truncate border-warning/70 border-l-2 pl-2 text-muted-foreground text-xs">
            {quotePreview(citation.text)}
          </blockquote>
          <Textarea
            ref={textareaRef}
            size="sm"
            value={body}
            placeholder="What should change here?"
            aria-label="Comment"
            disabled={busy}
            onChange={(event) => setBody(event.target.value)}
          />
          <div className="mt-1.5 flex items-center gap-2">
            <span className="flex flex-wrap items-center gap-1 text-3xs text-muted-foreground">
              Markdown supported
              <span aria-hidden>·</span>
              <Kbd>{isApplePlatform ? "⌘" : "Ctrl"}↵</Kbd> add
              <span aria-hidden>·</span>
              <Kbd>Esc</Kbd> cancel
            </span>
            <span className="ms-auto flex items-center gap-1">
              <Button
                type="button"
                size="xs"
                variant="outline"
                disabled={busy}
                onClick={() => setEditing(false)}
              >
                Cancel
              </Button>
              <Button
                type="button"
                size="xs"
                variant="default"
                disabled={busy || body.trim().length === 0}
                onClick={() => void submit("comment", body.trim())}
              >
                Add comment
              </Button>
            </span>
          </div>
        </div>
      ) : null}
    </>
  );
}
