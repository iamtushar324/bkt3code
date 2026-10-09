// T3-CUSTOM(expbkt3): "◌ Working 4m" in the row's time slot, the way upstream's
// sidebar says it (Sidebar.tsx's working top status): a dashed circle, the
// label, then the elapsed time, in the info colour at medium weight. "Goal"
// replaces "Working" while a native /goal keeps the agent going. Which rows
// show it is upstream's rule, through `resolvePhaseSidebarWorkingStatus`.
import type { PhaseSidebarWorkingStatus } from "@t3tools/client-runtime/state/phase-sidebar";
import { CircleDashedIcon } from "lucide-react";

import { PhaseRowWorkingDuration } from "./PhaseRowWorkingDuration";

export function PhaseRowWorkingStatus(props: {
  readonly status: PhaseSidebarWorkingStatus;
  readonly testId?: string;
}) {
  const { status } = props;
  return (
    <span
      data-testid={props.testId}
      className="inline-flex shrink-0 items-center gap-0.5 text-[9px] font-medium leading-none text-info"
    >
      <CircleDashedIcon aria-hidden className="size-2.5 shrink-0" />
      {/* The label alone is the live region, as upstream: a role="status"
          around the ticking duration would announce it every second. */}
      <span role="status">{status.label}</span>
      {status.startedAt !== null ? (
        <span aria-hidden className="tabular-nums">
          <PhaseRowWorkingDuration startedAt={status.startedAt} />
        </span>
      ) : null}
    </span>
  );
}
