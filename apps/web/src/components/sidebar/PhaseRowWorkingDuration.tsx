// T3-CUSTOM(expbkt3): how long a working session's current work has run — the
// same label as upstream's sidebar. PhaseRowWorkingStatus places it.
import { useEffect, useState } from "react";

import { formatWorkingDurationLabel } from "@t3tools/client-runtime/state/models";

/** Self-ticking, so only this span re-renders each second, not the whole row. */
export function PhaseRowWorkingDuration(props: { readonly startedAt: string }) {
  const startedMs = Date.parse(props.startedAt);
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (Number.isNaN(startedMs)) return;
    const id = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => window.clearInterval(id);
  }, [startedMs]);
  if (Number.isNaN(startedMs)) return null;
  return <>{formatWorkingDurationLabel(nowMs - startedMs)}</>;
}
