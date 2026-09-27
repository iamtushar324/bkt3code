// T3-CUSTOM(expbkt3): expandable workspace checklist that stands in for "Thinking"
// until the agent actually has the prompt.
import type {
  WorkspacePreparationStepStatus,
  WorkspacePreparationView,
} from "@t3tools/client-runtime/state/workspace-preparation";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  CircleIcon,
  MinusIcon,
  TerminalIcon,
} from "lucide-react";
import { type ReactNode, useState } from "react";

import { Button } from "../ui/button";

function StepIcon({ status }: { status: WorkspacePreparationStepStatus }) {
  switch (status) {
    case "done":
      return <CheckIcon className="size-3.5 text-success-foreground" aria-hidden />;
    case "skipped":
      return <MinusIcon className="size-3.5 text-muted-foreground/60" aria-hidden />;
    case "failed":
      return <CircleAlertIcon className="size-3.5 text-destructive" aria-hidden />;
    case "running":
      return <CircleIcon className="size-3 fill-current text-primary" aria-hidden />;
    case "pending":
      return <CircleIcon className="size-3 text-muted-foreground/60" aria-hidden />;
  }
}

export function WorkspacePreparationRow({
  view,
  onShowOutput,
  renderActiveLabel,
}: {
  readonly view: WorkspacePreparationView;
  readonly onShowOutput?: ((terminalId: string) => void) | undefined;
  /** Lets the timeline apply its own shimmer to the in-progress label. */
  readonly renderActiveLabel: (label: string) => ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const open = expanded || view.state === "failed";
  const terminalId = view.setupTerminalId;
  const headerIcon =
    view.state === "ready" ? (
      <CheckIcon className="size-3.5 text-success-foreground" aria-hidden />
    ) : view.state === "failed" ? (
      <CircleAlertIcon className="size-3.5 text-destructive" aria-hidden />
    ) : open ? (
      <ChevronDownIcon className="size-3.5" aria-hidden />
    ) : (
      <ChevronRightIcon className="size-3.5" aria-hidden />
    );

  return (
    <div className="px-1 text-sm text-muted-foreground">
      <button
        type="button"
        className="flex h-6 min-w-0 cursor-pointer items-center gap-1.5 leading-relaxed hover:text-foreground"
        aria-expanded={open}
        onClick={() => setExpanded((value) => !value)}
      >
        {headerIcon}
        {view.state === "preparing" ? (
          <>
            <span className="text-foreground/80">Setting up workspace</span>
            <span aria-hidden>·</span>
            {renderActiveLabel(view.label)}
          </>
        ) : (
          <span>{view.label}</span>
        )}
      </button>
      {open ? (
        <ul className="mt-1 mb-1 space-y-0.5 pl-5">
          {view.steps.map((step) => (
            <li key={step.key} className="flex min-h-6 items-center gap-2">
              <StepIcon status={step.status} />
              <span className={step.status === "running" ? "text-foreground" : undefined}>
                {step.label}
              </span>
              {step.key === "setup" && terminalId && onShowOutput ? (
                <Button
                  size="xs"
                  variant="ghost"
                  className="ml-auto"
                  onClick={() => onShowOutput(terminalId)}
                >
                  <TerminalIcon className="size-3.5" />
                  Show output
                </Button>
              ) : null}
            </li>
          ))}
          {view.state === "failed" && view.failureDetail ? (
            <li className="pl-5.5 text-xs text-destructive">{view.failureDetail}</li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}
