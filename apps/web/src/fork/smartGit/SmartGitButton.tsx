// T3-CUSTOM(expbkt3): fork-owned — the chat header's smart git button.
//
// Stands in for upstream's quick git action while the worktree needs a commit,
// a push or a new change request: a click asks the agent to do it (see
// useSmartGitAction). Upstream's dropdown keeps every direct git action.
import { CloudUploadIcon, GitCommitIcon } from "lucide-react";

import { Button } from "~/components/ui/button";
import { MenuItem, MenuItemLabel } from "~/components/ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

import type { SmartGitAction } from "./useSmartGitAction";

function SmartGitIcon({ action, className }: { action: SmartGitAction; className: string }) {
  const { intent, SourceControlIcon } = action;
  if (intent.intent === "commit") return <GitCommitIcon aria-hidden className={className} />;
  if (intent.intent === "push") return <CloudUploadIcon aria-hidden className={className} />;
  return <SourceControlIcon className={className} />;
}

function tooltipText(action: SmartGitAction): string {
  const why = action.intent.hint ? `${action.intent.hint}. ` : "";
  return `${why}Click to ask the agent to do it in this thread.`;
}

export function SmartGitButton({
  action,
  presentation,
}: {
  action: SmartGitAction;
  presentation: "toolbar" | "menu";
}) {
  if (!action.visible) return null;
  if (presentation === "menu") {
    return (
      <MenuItem density="touch" onClick={action.run}>
        <SmartGitIcon action={action} className="size-4" />
        <MenuItemLabel>{action.intent.label}</MenuItemLabel>
        {action.intent.hint ? (
          <span className="ms-auto truncate text-muted-foreground text-xs">
            {action.intent.hint}
          </span>
        ) : null}
      </MenuItem>
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="xs"
            variant={action.intent.highlighted ? "default" : "outline"}
            onClick={action.run}
            aria-label={`${action.intent.label}: ask the agent`}
          />
        }
      >
        <SmartGitIcon action={action} className="size-3.5" />
        <span className="sr-only @3xl/header-actions:not-sr-only @3xl/header-actions:ml-0.5">
          {action.intent.label}
        </span>
      </TooltipTrigger>
      <TooltipPopup side="bottom">{tooltipText(action)}</TooltipPopup>
    </Tooltip>
  );
}
