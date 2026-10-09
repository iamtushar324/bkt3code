// T3-CUSTOM(expbkt3): "Working 4m" in a working row's time slot — what web's
// BK sidebar and upstream's sidebar say. The rule (which rows) and the format
// are client-runtime's, so the phone reads the same as the desktop. It ticks
// on its own, so only this label re-renders each second, not the row.
import {
  formatPhaseSidebarWorkingDuration,
  type PhaseSidebarWorkingStatus,
} from "@t3tools/client-runtime/state/phase-sidebar";
import { useEffect, useState } from "react";

import { AppText as Text } from "../../components/AppText";

export function PhaseSidebarRowWorkingLabel(props: { readonly status: PhaseSidebarWorkingStatus }) {
  const { label, startedAt } = props.status;
  const startedMs = startedAt === null ? Number.NaN : Date.parse(startedAt);
  const [, setTick] = useState(0);
  useEffect(() => {
    if (Number.isNaN(startedMs)) return;
    const timer = setInterval(() => setTick((tick) => tick + 1), 1_000);
    return () => clearInterval(timer);
  }, [startedMs]);
  const duration = Number.isNaN(startedMs)
    ? null
    : formatPhaseSidebarWorkingDuration(Date.now() - startedMs);
  return (
    <Text
      // The label only: a ticking number would be read out again every second.
      accessibilityLabel={label}
      className="shrink-0 font-t3-mono text-[11px] tabular-nums text-adaptive-sky-600-400"
    >
      {duration === null ? label : `${label} ${duration}`}
    </Text>
  );
}
