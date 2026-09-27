/**
 * T3-CUSTOM(expbkt3): the selection toolbar that makes the panel feel like a
 * document rather than a textarea.
 *
 * Positioning lives in `useSelectionAnchor`, shared with the comment popover so
 * both agree on where "beside the selection" is.
 *
 * Alongside the formatting marks it carries quick labels: a reviewer who only
 * wants to say "yes, this part is fine" or "drop this" should not have to open a
 * composer and type it out.
 */
import {
  BoldPlugin,
  CodePlugin,
  HighlightPlugin,
  ItalicPlugin,
  StrikethroughPlugin,
  UnderlinePlugin,
} from "@platejs/basic-nodes/react";
import {
  BoldIcon,
  CodeIcon,
  HighlighterIcon,
  ItalicIcon,
  MessageSquarePlusIcon,
  StrikethroughIcon,
  ThumbsUpIcon,
  Trash2Icon,
  UnderlineIcon,
} from "lucide-react";
import { useMarkToolbarButton, useMarkToolbarButtonState } from "platejs/react";
import { type ComponentType } from "react";

import { cn } from "../../../lib/utils";
import { useSelectionAnchor } from "./useSelectionAnchor";

/** Canned bodies, so a one-click label still reads as a real comment upstream. */
export const PLAN_REVIEW_QUICK_LABELS = {
  approve: "👍 Looks good",
  remove: "Remove this.",
} as const;

export type PlanReviewQuickLabel = keyof typeof PLAN_REVIEW_QUICK_LABELS;

function MarkButton({
  nodeType,
  label,
  icon: Icon,
}: {
  readonly nodeType: string;
  readonly label: string;
  readonly icon: ComponentType<{ className?: string }>;
}) {
  const state = useMarkToolbarButtonState({ nodeType });
  const { props } = useMarkToolbarButton(state);

  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={props.pressed}
      onClick={props.onClick}
      onMouseDown={props.onMouseDown}
      className={cn(
        "flex size-7 items-center justify-center rounded transition-colors hover:bg-accent",
        props.pressed && "bg-accent text-accent-foreground",
      )}
    >
      <Icon className="size-4" />
    </button>
  );
}

function QuickLabelButton({
  label,
  icon: Icon,
  onClick,
  className,
}: {
  readonly label: string;
  readonly icon: ComponentType<{ className?: string }>;
  readonly onClick: () => void;
  readonly className?: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className={cn(
        "flex size-7 items-center justify-center rounded transition-colors hover:bg-accent",
        className,
      )}
    >
      <Icon className="size-4" />
    </button>
  );
}

export function PlanReviewFloatingToolbar({
  containerRef,
  onComment,
  onQuickLabel,
  readOnly,
  hidden = false,
}: {
  readonly containerRef: React.RefObject<HTMLElement | null>;
  readonly onComment: () => void;
  readonly onQuickLabel: (label: PlanReviewQuickLabel) => void;
  readonly readOnly: boolean;
  /** Suppressed while the comment composer owns the selection. */
  readonly hidden?: boolean;
}) {
  const anchor = useSelectionAnchor({ containerRef });

  if (hidden || anchor === null) return null;

  return (
    <div
      className="pointer-events-auto absolute z-30 -translate-x-1/2 rounded-lg border bg-popover p-0.5 shadow-lg"
      style={{ top: anchor.top, left: anchor.left }}
      // Keep the selection alive: losing it would clear the toolbar mid-click.
      onMouseDown={(event) => event.preventDefault()}
      role="toolbar"
      aria-label="Formatting"
    >
      <div className="flex items-center gap-0.5">
        {readOnly ? null : (
          <>
            <MarkButton nodeType={BoldPlugin.key} label="Bold" icon={BoldIcon} />
            <MarkButton nodeType={ItalicPlugin.key} label="Italic" icon={ItalicIcon} />
            <MarkButton nodeType={UnderlinePlugin.key} label="Underline" icon={UnderlineIcon} />
            <MarkButton
              nodeType={StrikethroughPlugin.key}
              label="Strikethrough"
              icon={StrikethroughIcon}
            />
            <MarkButton nodeType={HighlightPlugin.key} label="Highlight" icon={HighlighterIcon} />
            <MarkButton nodeType={CodePlugin.key} label="Inline code" icon={CodeIcon} />
            <span aria-hidden className="mx-0.5 h-5 w-px bg-border" />
          </>
        )}
        <button
          type="button"
          aria-label="Comment on selection"
          onClick={onComment}
          className="flex h-7 items-center gap-1.5 rounded px-2 text-xs transition-colors hover:bg-accent"
        >
          <MessageSquarePlusIcon className="size-4" />
          Comment
        </button>
        <span aria-hidden className="mx-0.5 h-5 w-px bg-border" />
        <QuickLabelButton
          label="Looks good"
          icon={ThumbsUpIcon}
          onClick={() => onQuickLabel("approve")}
        />
        <QuickLabelButton
          label="Ask to remove this"
          icon={Trash2Icon}
          className="text-destructive"
          onClick={() => onQuickLabel("remove")}
        />
      </div>
    </div>
  );
}
