/**
 * T3-CUSTOM(expbkt3): render mermaid fences as diagrams inside the plan.
 *
 * Agents draw architecture and sequence diagrams constantly; reading them as
 * source defeats the point. Mermaid is loaded lazily so the panel chunk does
 * not carry a diagram engine for plans that have no diagrams, and rendering is
 * cancel-guarded because a plan can be reloaded mid-render.
 */
import { AlertTriangleIcon, CodeIcon, WorkflowIcon } from "lucide-react";
import { memo, useEffect, useId, useRef, useState } from "react";

import { Button } from "../../ui/button";
import { cn } from "../../../lib/utils";

/** Mermaid mutates global state, so one initialization per page is enough. */
let mermaidReady: Promise<typeof import("mermaid").default> | null = null;

function loadMermaid(isDark: boolean) {
  mermaidReady ??= import("mermaid").then((module) => {
    module.default.initialize({
      startOnLoad: false,
      // The plan is authored by an agent, not a trusted human, so never let a
      // diagram inject markup or scripts.
      securityLevel: "strict",
      theme: isDark ? "dark" : "default",
      flowchart: { htmlLabels: true, curve: "basis" },
    });
    return module.default;
  });
  return mermaidReady;
}

interface PlanReviewMermaidProps {
  readonly code: string;
  readonly isDark: boolean;
}

function PlanReviewMermaidImpl({ code, isDark }: PlanReviewMermaidProps) {
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showSource, setShowSource] = useState(false);
  const reactId = useId();
  // Mermaid needs a DOM-safe id; React's contains colons.
  const renderId = useRef(`mermaid-${reactId.replace(/[^a-zA-Z0-9]/g, "")}`);

  useEffect(() => {
    let cancelled = false;
    const trimmed = code.trim();
    if (trimmed.length === 0) {
      setSvg(null);
      setError(null);
      return;
    }

    void loadMermaid(isDark)
      .then((mermaid) => mermaid.render(renderId.current, trimmed))
      .then(({ svg: rendered }) => {
        if (cancelled) return;
        setSvg(rendered);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setSvg(null);
        setError(cause instanceof Error ? cause.message : "This diagram could not be rendered.");
      });

    return () => {
      cancelled = true;
    };
  }, [code, isDark]);

  return (
    <div className="my-3 overflow-hidden rounded-md border bg-muted/30">
      <div className="flex items-center gap-1 border-b bg-muted/40 px-2 py-1">
        <WorkflowIcon className="size-3.5 text-muted-foreground" aria-hidden />
        <span className="text-muted-foreground text-xs">Diagram</span>
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto h-6 px-2 text-xs"
          onClick={() => setShowSource((value) => !value)}
        >
          <CodeIcon className="size-3.5" aria-hidden />
          {showSource ? "Diagram" : "Source"}
        </Button>
      </div>

      {showSource || error !== null ? (
        <div className="p-3">
          {error !== null ? (
            <p className="mb-2 flex items-start gap-1.5 text-amber-600 text-xs dark:text-amber-400">
              <AlertTriangleIcon className="mt-px size-3.5 shrink-0" aria-hidden />
              {error}
            </p>
          ) : null}
          <pre className="overflow-x-auto font-mono text-[13px] leading-relaxed">{code}</pre>
        </div>
      ) : svg === null ? (
        <p className="p-3 text-muted-foreground text-xs">Rendering diagram…</p>
      ) : (
        <div
          className={cn("overflow-x-auto p-3", "[&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-w-full")}
          // Mermaid runs with securityLevel "strict", which strips scripts and
          // event handlers from the SVG it returns.
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      )}
    </div>
  );
}

export const PlanReviewMermaid = memo(PlanReviewMermaidImpl);
