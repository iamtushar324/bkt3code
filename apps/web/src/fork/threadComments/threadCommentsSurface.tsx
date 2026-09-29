/**
 * T3-CUSTOM(expbkt3): single entry point for review comments in upstream files.
 *
 * `ChatView`, `RightPanelTabs`, `ChatComposer` and `MessagesTimeline` each take
 * one import from here and a one-line seam; every decision (setting on,
 * capability advertised, counts, strip copy, empty-send rule) is made in fork
 * code so the next upstream merge stays cheap.
 */
import type { ScopedThreadRef } from "@t3tools/contracts";
import { MessageSquareTextIcon } from "lucide-react";
import { useCallback, useMemo } from "react";

import type { ComposerBannerStackItem } from "../../components/chat/ComposerBannerStack";
import { Button } from "../../components/ui/button";
import { useRightPanelStore } from "../../rightPanelStore";
import {
  useThreadCommentsActiveSummary,
  useThreadCommentsCommands,
  useThreadCommentsEnabled,
  useThreadCommentsSnapshot,
} from "./hooks";
import { composerStripText, countComments } from "./model";
import { useActiveThreadCommentsOpenCount } from "./uiStore";

export { ThreadCommentsPanel } from "./ThreadCommentsPanel";
export { ThreadCommentMarks } from "./ThreadCommentMarks";
export { ThreadCommentsSelectionActions } from "./ThreadCommentsSelectionActions";
export type { AssistantSelectionToolbarExtras } from "./selectionToolbarExtras";
export { threadCommentsEmptySendAllowed, useThreadCommentsEmptySendAllowed } from "./hooks";
export { THREAD_COMMENT_PLACEHOLDER, THREAD_COMMENTS_EMPTY_SEND_TEXT } from "./model";

/** The right-panel kind; a singleton per thread like `diff`. */
export const THREAD_COMMENTS_SURFACE_KIND = "comments" as const;

/** Props the tab bar needs; spread into both `RightPanelTabs` mounts. */
export interface ThreadCommentsTabProps {
  readonly onAddComments?: (() => void) | undefined;
  readonly commentsAvailable?: boolean | undefined;
}

/**
 * Everything `ChatView` needs: whether to offer the surface, how to open it,
 * and the composer banner stack with the comments strip appended. Also
 * publishes the active thread's summary for readers without a thread ref.
 */
export function useThreadCommentsChatView({
  threadRef,
  bannerItems,
}: {
  readonly threadRef: ScopedThreadRef | null;
  readonly bannerItems: ReadonlyArray<ComposerBannerStackItem>;
}): {
  readonly tabProps: ThreadCommentsTabProps;
  readonly bannerItems: ReadonlyArray<ComposerBannerStackItem>;
  readonly openSurface: () => void;
} {
  const enabled = useThreadCommentsEnabled(threadRef?.environmentId);
  const snapshot = useThreadCommentsSnapshot(threadRef, enabled);
  useThreadCommentsActiveSummary(threadRef, enabled, snapshot);
  const commands = useThreadCommentsCommands();
  const openCount = snapshot === null ? 0 : countComments(snapshot.comments).open;
  const deliveryPaused = snapshot?.deliveryPaused ?? false;

  const openSurface = useCallback(() => {
    if (threadRef === null) return;
    useRightPanelStore.getState().open(threadRef, THREAD_COMMENTS_SURFACE_KIND);
  }, [threadRef]);

  const setPaused = useCallback(
    (paused: boolean) => {
      if (threadRef === null) return;
      void commands.setDeliveryPaused({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId, paused },
      });
    },
    [commands, threadRef],
  );

  const stripText = enabled ? composerStripText({ openCount, deliveryPaused }) : null;
  const strip = useMemo<ComposerBannerStackItem | null>(() => {
    if (stripText === null || threadRef === null) return null;
    return {
      id: `thread-comments:${threadRef.environmentId}:${threadRef.threadId}`,
      variant: deliveryPaused ? "default" : "warning",
      priority: "notice",
      icon: <MessageSquareTextIcon />,
      title: stripText,
      actions: (
        <>
          <Button size="xs" variant="ghost" onClick={openSurface}>
            Review
          </Button>
          {deliveryPaused ? (
            <Button size="xs" variant="ghost" onClick={() => setPaused(false)}>
              Resume
            </Button>
          ) : (
            <Button size="xs" variant="ghost" onClick={() => setPaused(true)}>
              Don&apos;t send
            </Button>
          )}
        </>
      ),
    };
  }, [deliveryPaused, openSurface, setPaused, stripText, threadRef]);

  const bannerItemsWithStrip = useMemo(
    () => (strip === null ? bannerItems : [...bannerItems, strip]),
    [bannerItems, strip],
  );

  const tabProps = useMemo<ThreadCommentsTabProps>(
    () =>
      enabled && threadRef !== null ? { onAddComments: openSurface, commentsAvailable: true } : {},
    [enabled, openSurface, threadRef],
  );

  return { tabProps, bannerItems: bannerItemsWithStrip, openSurface };
}

/** The "Comments" entry for the tab bar's "+" menu and the empty-state launcher. */
export function useThreadCommentsSurfaceActions(props: ThreadCommentsTabProps) {
  const openCount = useActiveThreadCommentsOpenCount();
  const onAddComments = props.onAddComments;
  return useMemo(
    () =>
      props.commentsAvailable && onAddComments
        ? [
            {
              label: "Comments",
              icon: MessageSquareTextIcon,
              shortcut: "C",
              available: true as const,
              disabledReason: "Available from a thread.",
              onClick: onAddComments,
              badgeCount: openCount,
            },
          ]
        : [],
    [onAddComments, openCount, props.commentsAvailable],
  );
}

/** Tab icon with the open count, for the surface's tab in the tab bar. */
export function ThreadCommentsSurfaceIcon() {
  const openCount = useActiveThreadCommentsOpenCount();
  return (
    <span className="relative inline-flex shrink-0">
      <MessageSquareTextIcon className="size-3 shrink-0" />
      {openCount > 0 ? (
        <span
          aria-label={`${openCount} open`}
          className="absolute -top-1.5 -right-2 flex h-3 min-w-3 items-center justify-center rounded-full bg-warning px-0.5 text-[8px] font-semibold tabular-nums text-black/80"
        >
          {openCount}
        </span>
      ) : null}
    </span>
  );
}

/** Open comments make an empty prompt sendable; the server appends them. */
export function withThreadCommentsSendable<S extends { hasSendableContent: boolean }>(
  state: S,
  allowed: boolean,
): S {
  return allowed && !state.hasSendableContent ? { ...state, hasSendableContent: true } : state;
}
