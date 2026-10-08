// T3-CUSTOM(expbkt3): how long a running session's current turn has run, in
// the row's time slot — the same label and rule as upstream's sidebar.
import { useEffect, useState } from "react";

import { formatWorkingDurationLabel } from "../Sidebar.logic";

/** Self-ticking, so only this span re-renders each second, not the whole row. */
export function PhaseRowWorkingDuration(props: { readonly startedAt: string }) {
  const startedMs = Date.parse(props.startedAt);
  const [, setTick] = useState(0);
  useEffect(() => {
    if (Number.isNaN(startedMs)) return;
    const id = window.setInterval(() => setTick((tick) => tick + 1), 1_000);
    return () => window.clearInterval(id);
  }, [startedMs]);
  if (Number.isNaN(startedMs)) return null;
  return <>{formatWorkingDurationLabel(Date.now() - startedMs)}</>;
}
