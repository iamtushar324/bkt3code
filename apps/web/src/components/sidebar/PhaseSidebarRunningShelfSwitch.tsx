// T3-CUSTOM(expbkt3): the Running shelf switch beside the group-by caption.
// Custom mode only: when it is on, sessions that run with nothing waiting on a
// human leave their groups for the Running shelf in the dock.
import { usePhaseSidebarGroupingStore } from "../../phaseSidebarGroupingStore";
import { Switch } from "../ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function PhaseSidebarRunningShelfSwitch() {
  const enabled = usePhaseSidebarGroupingStore((state) => state.grouping.runningShelf === true);
  const setRunningShelf = usePhaseSidebarGroupingStore((state) => state.setRunningShelf);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <label className="flex cursor-pointer items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70 hover:text-foreground">
            <Switch
              size="sm"
              checked={enabled}
              onCheckedChange={setRunningShelf}
              aria-label="Move running sessions to the Running shelf"
              data-testid="phase-sidebar-running-shelf-switch"
            />
            Running
          </label>
        }
      />
      <TooltipPopup side="bottom">
        Move running sessions without a question to the Running shelf
      </TooltipPopup>
    </Tooltip>
  );
}
