// T3-CUSTOM(expbkt3): "Working 4m" in a working row's time slot — what web's
// BK sidebar and upstream's sidebar say. The rule (which rows) and the format
// are client-runtime's, so the phone reads the same as the desktop. It ticks
// on the shared second clock, so only this label re-renders, not the row.
import {
  formatPhaseSidebarWorkingDuration,
  type PhaseSidebarWorkingStatus,
} from "@t3tools/client-runtime/state/phase-sidebar";
import { secondTick } from "@t3tools/client-runtime/clock";
import { useSyncExternalStore } from "react";

import { AppText as Text } from "../../components/ui/AppText";

const subscribeNever = () => () => undefined;

export function PhaseSidebarRowWorkingLabel(props: { readonly status: PhaseSidebarWorkingStatus }) {
  const { label, startedAt } = props.status;
  const startedMs = startedAt === null ? Number.NaN : Date.parse(startedAt);
  const ticking = !Number.isNaN(startedMs);
  const nowMs = useSyncExternalStore(
    ticking ? secondTick.subscribe : subscribeNever,
    secondTick.getSnapshot,
    secondTick.getSnapshot,
  );
  const duration = ticking ? formatPhaseSidebarWorkingDuration(nowMs - startedMs) : null;
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
