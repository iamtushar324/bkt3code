/**
 * T3-CUSTOM(expbkt3): the review-comment chip in the chat box's action row.
 *
 * Comments not sent yet live in the strip above the chat box. Once they go,
 * the strip leaves and this chip keeps the rest in view: blue while the agent
 * has them, green once it has addressed some. Its menu sends the open ones
 * again, asks for an update, opens the panel, resolves what is addressed, and
 * pauses sending. It reads the active thread from the comments UI store, so
 * the composer seam is one line with no props.
 */
import { ChevronDownIcon, MessageSquareTextIcon } from "lucide-react";
import { useCallback } from "react";

import { Badge } from "../../components/ui/badge";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "../../components/ui/menu";
import { useRightPanelStore } from "../../rightPanelStore";
import { useThreadCommentsCommands } from "./hooks";
import { composerChipLabel, composerChipTone } from "./model";
import { THREAD_COMMENTS_SURFACE_KIND } from "./threadCommentsSurface";
import { useThreadCommentsUiStore } from "./uiStore";
import { useCommentSendActions } from "./useCommentSendActions";

/** Blue while the agent has the comments, green once it has addressed some. */
const TONE_VARIANT = { sent: "info", addressed: "success" } as const;

export function ThreadCommentsComposerChip() {
  const active = useThreadCommentsUiStore((state) => (state.active?.enabled ? state.active : null));
  const threadRef = active?.threadRef ?? null;
  const actions = useCommentSendActions(threadRef);
  const commands = useThreadCommentsCommands();

  const openPanel = useCallback(() => {
    if (threadRef === null) return;
    useRightPanelStore.getState().open(threadRef, THREAD_COMMENTS_SURFACE_KIND);
  }, [threadRef]);

  if (active === null || threadRef === null) return null;
  const counts = {
    unsent: active.unsentCount,
    sent: active.sentCount,
    addressed: active.addressedCount,
  };
  const label = composerChipLabel(counts);
  if (label === null) return null;
  const openCount = counts.unsent + counts.sent;
  // While paused nothing is appended, so a re-send would go out without comments.
  const canResend = openCount > 0 && !active.deliveryPaused;
  const target = { environmentId: threadRef.environmentId };

  return (
    // Inline in the chat box's action row, just before the send button: the one
    // row both composer layouts keep, so it never covers the draft.
    <div className="flex shrink-0 items-center">
      <Menu>
        <MenuTrigger
          render={
            <Badge
              size="lg"
              variant={TONE_VARIANT[composerChipTone(counts)]}
              render={<button type="button" aria-label={`Review comments: ${label}`} />}
            />
          }
        >
          <MessageSquareTextIcon aria-hidden className="size-3.5" />
          {label}
          <ChevronDownIcon aria-hidden className="size-3.5 opacity-70" />
        </MenuTrigger>
        <MenuPopup align="end" side="bottom" sideOffset={4}>
          <MenuGroup>
            <MenuGroupLabel>
              {openCount} open · {counts.addressed} addressed
            </MenuGroupLabel>
            <MenuItem disabled={!canResend} onClick={actions.addressRemaining}>
              Address remaining
            </MenuItem>
            <MenuItem disabled={!canResend} onClick={actions.askForUpdate}>
              Ask for an update
            </MenuItem>
          </MenuGroup>
          <MenuSeparator />
          <MenuItem onClick={openPanel}>Review comments</MenuItem>
          <MenuItem
            disabled={counts.addressed === 0}
            onClick={() =>
              void commands.resolveAll({
                ...target,
                input: { threadId: threadRef.threadId, only: "addressed" },
              })
            }
          >
            Resolve addressed
          </MenuItem>
          <MenuItem
            onClick={() =>
              void commands.setDeliveryPaused({
                ...target,
                input: { threadId: threadRef.threadId, paused: !active.deliveryPaused },
              })
            }
          >
            {active.deliveryPaused ? "Resume sending" : "Pause sending"}
          </MenuItem>
        </MenuPopup>
      </Menu>
    </div>
  );
}
