// T3-CUSTOM(expbkt3): the three counters from the desktop sidebar chrome —
// unread, running, unsettled — in the same order, so the two surfaces read the
// same at a glance. Running and settled state come from the shared summary;
// unread comes from the already-resolved row model so it cannot disagree with
// the dots in this mobile list.
import {
  summarizeSidebarSessions,
  type PhaseSidebarRow,
} from "@t3tools/client-runtime/state/phase-sidebar";
import { useMemo } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { cn } from "../../lib/cn";
import { useThreadListNow } from "../threads/use-thread-list-now";
import { countPhaseSidebarUnreadRows } from "./phaseSidebarCounterLogic";

function Counter(props: {
  readonly value: number;
  readonly label: string;
  readonly toneClassName: string;
  readonly textClassName: string;
}) {
  return (
    <View
      accessibilityLabel={`${props.value} ${props.label}`}
      accessibilityRole="text"
      className={cn(
        "h-7 flex-row items-center justify-center gap-1 rounded-lg border px-2",
        props.toneClassName,
      )}
    >
      <Text className={cn("font-t3-bold text-[15px] tabular-nums", props.textClassName)}>
        {props.value}
      </Text>
      <Text className={cn("text-[10px] font-t3-medium", props.textClassName)}>{props.label}</Text>
    </View>
  );
}

export function PhaseSidebarCounters(props: { readonly rows: ReadonlyArray<PhaseSidebarRow> }) {
  const threads = useMemo(() => props.rows.map((row) => row.thread), [props.rows]);
  // Advances each minute and when a snooze wakes, so a woken thread is counted.
  const now = useThreadListNow(threads);
  const counts = useMemo(() => {
    const shared = summarizeSidebarSessions(threads, {
      now,
      snoozeSupported: (thread) =>
        props.rows.find(
          (row) => row.thread.environmentId === thread.environmentId && row.thread.id === thread.id,
        )?.snoozeSupported === true,
    });
    return {
      ...shared,
      unread: countPhaseSidebarUnreadRows(props.rows),
    };
  }, [now, props.rows, threads]);

  return (
    <View accessibilityLabel="Session status summary" className="flex-row items-center gap-1">
      <Counter
        label="unread"
        textClassName={counts.unread > 0 ? "text-adaptive-sky-700-300" : "text-foreground-tertiary"}
        toneClassName={
          counts.unread > 0
            ? "border-adaptive-sky-500-a12-a16 bg-adaptive-sky-500-a12-a16"
            : "border-border/60 bg-subtle/40"
        }
        value={counts.unread}
      />
      <Counter
        label="running"
        textClassName="text-adaptive-emerald-600-400"
        toneClassName="border-adaptive-emerald-500-a12-a16 bg-adaptive-emerald-500-a12-a16"
        value={counts.running}
      />
      <Counter
        label="waiting"
        textClassName={
          counts.nonRunning >= 2 ? "text-adaptive-amber-700-300" : "text-adaptive-emerald-700-300"
        }
        toneClassName={
          counts.nonRunning >= 2
            ? "border-adaptive-amber-500-a12-a16 bg-adaptive-amber-500-a12-a16"
            : "border-adaptive-emerald-500-a12-a16 bg-adaptive-emerald-500-a12-a16"
        }
        value={counts.nonRunning}
      />
    </View>
  );
}
