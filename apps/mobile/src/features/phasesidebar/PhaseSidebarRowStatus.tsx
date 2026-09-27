// T3-CUSTOM(expbkt3): the row's status glyph — what the desktop sidebar says
// in words ("Running", "Monitoring", "Needs input", "Plan ready"), as an icon,
// because a phone row has no room for the word. A running row pulses; the
// pulse is a reanimated opacity loop on one 12px glyph, mounted only while the
// agent is actually working, so it costs nothing on an idle list.
import {
  resolvePhaseSidebarWorkBadge,
  type PhaseSidebarRow,
} from "@t3tools/client-runtime/state/phase-sidebar";
import { useEffect, type ComponentProps } from "react";
import { View } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from "react-native-reanimated";

import { SymbolView } from "../../components/AppSymbol";

type Glyph = {
  readonly icon: ComponentProps<typeof SymbolView>["name"];
  readonly color: string;
  readonly label: string;
  readonly pulse: boolean;
};

/** What the row is doing, or null when it is simply idle and read. */
export function resolvePhaseSidebarRowGlyph(row: PhaseSidebarRow): Glyph | null {
  const thread = row.thread;
  if (row.phaseId === "needs_input") {
    return {
      icon: "exclamationmark.bubble.fill",
      color: "#e11d48",
      label: "Needs input",
      pulse: false,
    };
  }
  // T3-CUSTOM(expbkt3): a question asked mid-run. Checked before the work badge
  // because the agent is usually still working — the bolt would hide it. Same
  // glyph as Needs Input in amber rather than rose: it is the same request for
  // a human, minus the parked agent.
  if (row.phaseId === "ask") {
    return {
      icon: "exclamationmark.bubble.fill",
      color: "#d97706",
      label: "Question waiting",
      pulse: false,
    };
  }
  const workBadge = resolvePhaseSidebarWorkBadge({
    phaseId: row.phaseId,
    backgroundLiveness: thread.backgroundLiveness ?? null,
    // The agent is working while its provider session runs a turn.
    executionPresentation: {
      active: thread.session?.status === "running" || thread.session?.status === "starting",
      label: thread.session?.status === "starting" ? "Starting" : "Running",
    },
  });
  if (workBadge !== null) {
    return workBadge.monitoring
      ? { icon: "eye.fill", color: "#0284c7", label: "Monitoring", pulse: false }
      : { icon: "bolt.fill", color: "#0ea5e9", label: workBadge.label, pulse: true };
  }
  if (row.phaseId === "plan_ready") {
    return { icon: "doc.text.fill", color: "#7c3aed", label: "Plan ready", pulse: false };
  }
  return null;
}

function PulsingGlyph(props: { readonly glyph: Glyph }) {
  const progress = useSharedValue(1);
  useEffect(() => {
    if (!props.glyph.pulse) {
      cancelAnimation(progress);
      progress.value = 1;
      return;
    }
    progress.value = withRepeat(
      withSequence(
        withTiming(0.35, { duration: 650, easing: Easing.inOut(Easing.quad) }),
        withTiming(1, { duration: 650, easing: Easing.inOut(Easing.quad) }),
      ),
      -1,
      false,
    );
    return () => cancelAnimation(progress);
  }, [progress, props.glyph.pulse]);
  const style = useAnimatedStyle(() => ({ opacity: progress.value }));
  return (
    <Animated.View style={style}>
      <SymbolView
        name={props.glyph.icon}
        size={12}
        tintColor={props.glyph.color}
        type="monochrome"
      />
    </Animated.View>
  );
}

export function PhaseSidebarRowStatus(props: { readonly row: PhaseSidebarRow }) {
  const glyph = resolvePhaseSidebarRowGlyph(props.row);
  if (glyph === null) return null;
  return (
    <View accessibilityLabel={glyph.label} className="shrink-0 items-center justify-center">
      <PulsingGlyph glyph={glyph} />
    </View>
  );
}
