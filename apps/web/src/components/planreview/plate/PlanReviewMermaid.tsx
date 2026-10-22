/**
 * T3-CUSTOM(expbkt3): render mermaid fences as diagrams inside the plan.
 *
 * Agents draw architecture and sequence diagrams constantly; reading them as
 * source defeats the point. The diagram itself is upstream's chat renderer, so
 * plans and chat share one lazily loaded engine and one sanitizer.
 */
import { CodeIcon, WorkflowIcon } from "lucide-react";
import { memo, Suspense, useState } from "react";

import { MermaidDiagram } from "../../chat/MermaidDiagram";
import { RenderErrorBoundary } from "../../RenderErrorBoundary";
import { Button } from "../../ui/button";

interface PlanReviewMermaidProps {
  readonly code: string;
  readonly theme: string | undefined;
}

const openExpandedDiagram = (imageUrl: string) => {
  window.open(imageUrl, "_blank", "noopener,noreferrer");
};

function PlanReviewMermaidImpl({ code, theme }: PlanReviewMermaidProps) {
  const [showSource, setShowSource] = useState(false);
  const source = (
    <pre className="overflow-x-auto p-3 font-mono text-[13px] leading-relaxed">{code}</pre>
  );

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

      {showSource || code.trim().length === 0 ? (
        source
      ) : (
        <div className="overflow-x-auto p-3">
          <RenderErrorBoundary resetKeys={[code, theme]} fallback={source}>
            <Suspense
              fallback={<p className="text-muted-foreground text-xs">Rendering diagram…</p>}
            >
              <MermaidDiagram source={code} onExpand={openExpandedDiagram} />
            </Suspense>
          </RenderErrorBoundary>
        </div>
      )}
    </div>
  );
}

export const PlanReviewMermaid = memo(PlanReviewMermaidImpl);
