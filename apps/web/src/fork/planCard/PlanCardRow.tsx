/**
 * T3-CUSTOM(expbkt3): the timeline row seam for plan cards.
 *
 * Wraps upstream's `ProposedPlanCard` to give it the chat's timeline state
 * (see `planCardContext`) and to draw it wide when the reader asks. A wide
 * card leaves the chat column for the free width of the conversation area;
 * the column itself is measured from the DOM, because the timeline centres it
 * inside padding that the chat canvas changes as floating cards come and go.
 */
import type { ReactNode } from "react";
import { useLayoutEffect, useMemo, useRef, useState } from "react";

import { useChatCanvas } from "../../components/chat/ChatCanvasContext";
import { observeResize } from "../../lib/observeResize";
import type { ProposedPlan } from "../../types";
import "./planCard.css";
import { PlanCardContext, type PlanCardTimeline } from "./planCardContext";
import { resolveWidePlanBox, type WidePlanBox } from "./planCardLayout";
import { usePlanCardWidthStore } from "./planCardWidthStore";

// Floating things a wide card must stop before, inside the chat canvas.
const OBSTACLE_SELECTOR = '[data-thread-details-panel="inline"], [data-preview-mini-player]';
// The timeline minimap's clickable strip on the left; it takes clicks over the card.
const MINIMAP_STRIP_SELECTOR = '[data-testid="timeline-minimap"] > div > div';

function sameBox(left: WidePlanBox | null, right: WidePlanBox | null) {
  return left?.offset === right?.offset && left?.width === right?.width;
}

export function PlanCardRow({
  plan,
  itemKey,
  timeline,
  children,
}: {
  readonly plan: ProposedPlan;
  readonly itemKey: string;
  readonly timeline: PlanCardTimeline;
  readonly children: ReactNode;
}) {
  const width = usePlanCardWidthStore((state) => state.width);
  const canvas = useChatCanvas();
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<WidePlanBox | null>(null);

  // The canvas context changes whenever the column, a floating card or the
  // preview moves, so it re-runs the measurement along with resizes.
  useLayoutEffect(() => {
    const element = ref.current;
    const column = element?.parentElement;
    const area = element?.closest<HTMLElement>(".messages-timeline-scroll");
    if (!element || !column || !area) return;
    const measure = () => {
      const columnRect = column.getBoundingClientRect();
      const columnStyle = getComputedStyle(column);
      const areaRect = area.getBoundingClientRect();
      const areaLeft = areaRect.left + area.clientLeft;
      const canvasElement = element.closest("[data-chat-canvas]");
      const obstacles = Array.from(
        canvasElement?.querySelectorAll(OBSTACLE_SELECTOR) ?? [],
        (obstacle) => obstacle.getBoundingClientRect().left,
      );
      const minimap = canvasElement?.querySelector(MINIMAP_STRIP_SELECTOR)?.getBoundingClientRect();
      const leftObstacles = minimap && minimap.width > 0 ? [minimap.right] : [];
      const next = resolveWidePlanBox({
        lane: {
          left: columnRect.left + Number.parseFloat(columnStyle.paddingLeft),
          right: columnRect.right - Number.parseFloat(columnStyle.paddingRight),
        },
        area: { left: areaLeft, right: areaLeft + area.clientWidth },
        padding: canvas?.lane.padding ?? 12,
        obstacles,
        leftObstacles,
      });
      setBox((current) => (sameBox(current, next) ? current : next));
    };
    measure();
    return observeResize([column, area], measure);
  }, [canvas]);

  const wide = width === "wide" && box !== null;
  // Only the fields a plan reads, so other timeline changes do not re-render the card.
  const {
    threadRef,
    citationRequest,
    listRef,
    skills,
    onRunShellCommand,
    onImageExpand,
    onUseArtifactTemplate,
  } = timeline;
  const planTimeline = useMemo<PlanCardTimeline>(
    () => ({
      threadRef,
      citationRequest,
      listRef,
      skills,
      onRunShellCommand,
      onImageExpand,
      onUseArtifactTemplate,
    }),
    [
      threadRef,
      citationRequest,
      listRef,
      skills,
      onRunShellCommand,
      onImageExpand,
      onUseArtifactTemplate,
    ],
  );
  const value = useMemo(
    () => ({ plan, itemKey, timeline: planTimeline, canWiden: box !== null }),
    [plan, itemKey, planTimeline, box],
  );
  return (
    <PlanCardContext value={value}>
      <div
        ref={ref}
        className="min-w-0"
        data-plan-card-width={wide ? "wide" : "compact"}
        style={wide ? { marginLeft: box.offset, width: box.width } : undefined}
      >
        {children}
      </div>
    </PlanCardContext>
  );
}
