/**
 * T3-CUSTOM(expbkt3): the left side of a plan card's header.
 *
 * Replaces upstream's "Plan" badge and title with an icon, the title, the
 * plan's state, its size, and the control that widens or narrows the card.
 * It takes the header's free width, so the width control sits just before
 * upstream's actions menu.
 */
import { FoldHorizontalIcon, ListChecksIcon, UnfoldHorizontalIcon } from "lucide-react";
import { use, useMemo } from "react";

import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";
import { PlanCardContext } from "./planCardContext";
import { usePlanCardWidthStore } from "./planCardWidthStore";
import {
  PLAN_STATUS_LABEL,
  PLAN_STATUS_VARIANT,
  planCardTitle,
  summarizePlan,
} from "./planSummary";

export function PlanCardHeading({
  planMarkdown,
  title,
}: {
  readonly planMarkdown: string;
  readonly title: string;
}) {
  const card = use(PlanCardContext);
  const summary = useMemo(() => summarizePlan(planMarkdown), [planMarkdown]);
  const status = card?.plan.status;
  return (
    <div className="flex min-w-0 flex-1 items-center gap-3">
      <span
        aria-hidden="true"
        className="flex size-8 shrink-0 items-center justify-center rounded-xl bg-info/10 text-info-foreground"
      >
        <ListChecksIcon className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        {/* Same heading level as the message author headings in the timeline,
            so a plan's own headings nest beneath it in the outline. */}
        <h3 className="truncate font-semibold text-foreground text-sm" data-thread-find-text="true">
          {planCardTitle(planMarkdown, title)}
        </h3>
        <p className="flex min-w-0 items-center gap-1.5 truncate text-muted-foreground text-xs">
          <span>Plan</span>
          {summary.steps > 0 ? (
            <span>
              · {summary.steps} {summary.steps === 1 ? "step" : "steps"}
            </span>
          ) : null}
          <span>· {summary.readMinutes} min read</span>
        </p>
      </div>
      {status ? (
        <Badge variant={PLAN_STATUS_VARIANT[status]}>{PLAN_STATUS_LABEL[status]}</Badge>
      ) : null}
      {card ? <PlanCardWidthToggle canWiden={card.canWiden} /> : null}
    </div>
  );
}

function PlanCardWidthToggle({ canWiden }: { readonly canWiden: boolean }) {
  const width = usePlanCardWidthStore((state) => state.width);
  const toggle = usePlanCardWidthStore((state) => state.toggle);
  const wide = width === "wide";
  // A narrow window has no room beside the chat column, so there is nothing to toggle.
  if (!wide && !canWiden) return null;
  const label = wide ? "Fit plan to the chat column" : "Widen plan";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={label}
            aria-pressed={wide}
            size="icon-xs"
            variant="ghost"
            data-scroll-anchor-ignore
            onClick={toggle}
          />
        }
      >
        {wide ? (
          <FoldHorizontalIcon aria-hidden="true" className="size-4" />
        ) : (
          <UnfoldHorizontalIcon aria-hidden="true" className="size-4" />
        )}
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}
