// T3-CUSTOM(expbkt3): custom mode's collapse-all button, beside the Running
// switch. One press closes every group and shelf; the next opens them all.
import { ChevronsDownUpIcon, ChevronsUpDownIcon } from "lucide-react";

import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function PhaseSidebarCollapseAllButton(props: {
  readonly allCollapsed: boolean;
  readonly onToggle: () => void;
}) {
  const label = props.allCollapsed ? "Expand all groups" : "Collapse all groups";
  const Icon = props.allCollapsed ? ChevronsUpDownIcon : ChevronsDownUpIcon;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-micro"
            aria-label={label}
            data-testid="phase-sidebar-collapse-all"
            onClick={props.onToggle}
          />
        }
      >
        <Icon aria-hidden />
      </TooltipTrigger>
      <TooltipPopup side="bottom">{label}</TooltipPopup>
    </Tooltip>
  );
}
