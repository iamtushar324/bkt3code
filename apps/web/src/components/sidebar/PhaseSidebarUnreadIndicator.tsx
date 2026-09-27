import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

interface PhaseSidebarUnreadIndicatorProps {
  readonly isUnread: boolean;
  readonly threadId: string;
}

export function PhaseSidebarUnreadIndicator({
  isUnread,
  threadId,
}: PhaseSidebarUnreadIndicatorProps) {
  if (!isUnread) {
    return (
      <span
        aria-hidden="true"
        className="inline-flex size-3.5 shrink-0"
        data-testid={`phase-thread-unread-slot-${threadId}`}
      />
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            aria-label="Unread session"
            className="inline-flex size-3.5 shrink-0 items-center justify-center text-emerald-600 dark:text-emerald-300/90"
            data-testid={`phase-thread-unread-${threadId}`}
            role="img"
          />
        }
      >
        <span
          aria-hidden="true"
          className="size-[9px] rounded-full bg-emerald-500 dark:bg-emerald-300/90"
        />
      </TooltipTrigger>
      <TooltipPopup side="top">Unread</TooltipPopup>
    </Tooltip>
  );
}
