/**
 * T3-CUSTOM(expbkt3): single entry point for agent-rendered UI surfaces.
 *
 * Everything the chat timeline needs lives here, so `MessagesTimeline` takes one
 * import and one early return rather than growing surface logic inline. That
 * keeps the next upstream merge cheap.
 *
 * A surface is one `t3_show_ui` tool call: the agent stored a document
 * server-side and the work-log row carries only a short render handle. The card
 * fetches the body on demand and mounts it in a sandboxed iframe, the way MCP
 * Apps hosts render a `ui://` resource.
 */
import {
  AGENT_UI_DEFAULT_HEIGHT,
  AGENT_UI_MAX_HEIGHT,
  AGENT_UI_MIN_HEIGHT,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { Maximize2Icon, XIcon } from "lucide-react";
import { memo, useEffect, useMemo, useState, type ReactNode } from "react";

import { useClientSettings } from "../hooks/useSettings";
import { agentUiEnvironment } from "../state/agentUi";
import {
  selectExpandedAgentUiView,
  useAgentUiExpandedStore,
  type ExpandedAgentUiView,
} from "../agentUiExpandedStore";
import { useEnvironmentQuery } from "../state/query";
import { cn } from "../lib/utils";
import { isAgentUiSurfaceRenderable } from "./agentUiRuntime";

/** The handle `ActivityPayloadProjection` keeps on an MCP tool-call payload. */
export interface AgentUiSurfaceHandle {
  readonly renderId: string;
  readonly kind: "html" | "url";
  readonly height: number;
}

function clampHeight(height: unknown): number {
  if (typeof height !== "number" || !Number.isFinite(height)) return AGENT_UI_DEFAULT_HEIGHT;
  return Math.max(AGENT_UI_MIN_HEIGHT, Math.min(Math.round(height), AGENT_UI_MAX_HEIGHT));
}

/**
 * Reads the render handle off a work-log entry, or null when the row is an
 * ordinary tool call. Pure, so the timeline can call it before any hooks.
 */
export function resolveAgentUiSurface(entry: {
  readonly agentUi?: unknown;
}): AgentUiSurfaceHandle | null {
  const handle = entry.agentUi;
  if (typeof handle !== "object" || handle === null) return null;
  const record = handle as Record<string, unknown>;
  const renderId = record.renderId;
  if (typeof renderId !== "string" || renderId.length === 0) return null;
  return {
    renderId,
    kind: record.kind === "url" ? "url" : "html",
    height: clampHeight(record.height),
  };
}

/** Wraps a bare fragment so an agent can pass markup without a document shell. */
function toSrcDoc(html: string): string {
  if (/<html[\s>]/i.test(html)) return html;
  return [
    "<!doctype html>",
    '<html><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    "<style>body{margin:0;padding:12px;font-family:system-ui,sans-serif}</style>",
    "</head><body>",
    html,
    "</body></html>",
  ].join("");
}

/**
 * Fetches one render and mounts it. Shared by the inline card and the expanded
 * overlay so both agree on sandboxing, loading and failure states — the sandbox
 * rules in particular must never drift between the two.
 */
export const AgentUiRenderFrame = memo(function AgentUiRenderFrame(props: {
  readonly threadRef: ScopedThreadRef;
  readonly renderId: string;
  readonly onTitle?: ((title: string) => void) | undefined;
}) {
  const { environmentId, threadId } = props.threadRef;
  const query = useEnvironmentQuery(
    agentUiEnvironment.render({
      environmentId,
      input: { threadId, renderId: props.renderId },
    }),
  );
  const render = query.data?.render ?? null;

  // An unmodified sandbox gives the document an opaque origin: its scripts run,
  // so charts and interactions work, but it cannot reach this page, our cookies,
  // or the network as the signed-in user.
  const srcDoc = useMemo(
    () => (render?.kind === "html" && render.html ? toSrcDoc(render.html) : null),
    [render?.kind, render?.html],
  );

  const onTitle = props.onTitle;
  const title = render?.title;
  useEffect(() => {
    if (onTitle && title) onTitle(title);
  }, [onTitle, title]);

  if (query.isPending && render === null) {
    return (
      <div className="flex h-full items-center justify-center text-secondary-label text-xs">
        Loading view…
      </div>
    );
  }
  if (render === null) {
    return (
      <div className="flex h-full items-center justify-center px-4 text-center text-secondary-label text-xs">
        {query.error ?? "This view is no longer available."}
      </div>
    );
  }
  if (srcDoc !== null) {
    return (
      <iframe
        // Keying on the render makes the browser build a fresh document; an
        // iframe does not re-run scripts on a srcDoc mutation alone.
        key={render.renderId}
        title={render.title}
        srcDoc={srcDoc}
        className={cn("size-full border-0 bg-white")}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
      />
    );
  }
  if (render.url) {
    // Reached when a stored render turns out to be a URL after all — an older
    // row, or a handle whose kind disagrees with the record.
    return (
      <div className="flex h-full items-center justify-center px-4 text-center text-secondary-label text-xs">
        URL Agent views are temporarily disabled because framed apps cannot always render the
        requested live state reliably.
      </div>
    );
  }
  return null;
});

interface AgentUiSurfaceCardProps {
  readonly threadRef: ScopedThreadRef;
  readonly surface: AgentUiSurfaceHandle;
}

function AgentUiSurfaceCardImpl({ threadRef, surface }: AgentUiSurfaceCardProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [title, setTitle] = useState("Agent view");
  const expand = useAgentUiExpandedStore((state) => state.expand);

  return (
    <div className="mt-1 ms-7 overflow-hidden rounded-lg border border-border/60 bg-card">
      <div className="flex items-center gap-1 px-1.5 py-1">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded px-1.5 py-0.5 text-left hover:bg-accent/20"
          onClick={() => expand({ threadRef, renderId: surface.renderId })}
          aria-label={`Expand ${title}`}
        >
          <span className="min-w-0 flex-1 truncate font-medium text-secondary-label text-xs">
            {title}
          </span>
          <Maximize2Icon className="size-3 shrink-0 text-icon-muted opacity-70" aria-hidden />
        </button>
        <button
          type="button"
          className="shrink-0 rounded px-1.5 py-0.5 text-[0.6875rem] text-secondary-label/70 hover:bg-accent/20 hover:text-secondary-label"
          onClick={() => setCollapsed((value) => !value)}
          aria-expanded={!collapsed}
        >
          {collapsed ? "Show" : "Hide"}
        </button>
      </div>
      {collapsed ? null : (
        <div className="border-border/60 border-t" style={{ height: surface.height }}>
          <AgentUiRenderFrame
            key={surface.renderId}
            threadRef={threadRef}
            renderId={surface.renderId}
            onTitle={setTitle}
          />
        </div>
      )}
    </div>
  );
}

const AgentUiSurfaceCard = memo(AgentUiSurfaceCardImpl);

/**
 * Wraps the timeline's ordinary tool row with the surface it produced.
 *
 * Composition rather than modification: the upstream row renders unchanged as
 * `children`, and turning the setting off leaves exactly that row behind.
 */
export const AgentUiSurfaceRow = memo(function AgentUiSurfaceRow(props: {
  readonly threadRef: ScopedThreadRef | null;
  readonly surface: AgentUiSurfaceHandle;
  readonly children: ReactNode;
}) {
  const enabled = useClientSettings((settings) => settings.agentUiSurfacesEnabled);
  // A kind T3 cannot render truthfully leaves the ordinary tool row behind
  // rather than a box explaining itself on every call.
  if (!enabled || props.threadRef === null || !isAgentUiSurfaceRenderable(props.surface.kind)) {
    return props.children;
  }
  return (
    <div className="flex flex-col">
      {props.children}
      <AgentUiSurfaceCard threadRef={props.threadRef} surface={props.surface} />
    </div>
  );
});

/**
 * The expanded view, filling the message area and leaving the composer usable.
 *
 * Mounted as the last child of the messages wrapper in `ChatView`, which is
 * already `relative` and already excludes the input bar — so `absolute inset-0`
 * covers exactly the transcript and nothing else. It cannot live inside the
 * timeline row that opened it: those rows are virtualized, so they clip and get
 * recycled out from under an overlay.
 */
export const AgentUiExpandedSurface = memo(function AgentUiExpandedSurface({
  threadRef,
}: {
  readonly threadRef: ScopedThreadRef | null;
}) {
  const enabled = useClientSettings((settings) => settings.agentUiSurfacesEnabled);
  const expanded = useAgentUiExpandedStore((state) => selectExpandedAgentUiView(state, threadRef));
  if (!enabled || expanded === null) return null;
  return (
    <ExpandedSurfaceContent
      key={`${scopedThreadKey(expanded.threadRef)}:${expanded.renderId}`}
      expanded={expanded}
    />
  );
});

function ExpandedSurfaceContent({ expanded }: { readonly expanded: ExpandedAgentUiView }) {
  const collapse = useAgentUiExpandedStore((state) => state.collapse);
  const [title, setTitle] = useState("Agent view");

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        collapse(expanded.threadRef);
      }
    };
    // Capture phase: the composer and the timeline both handle Escape, and the
    // expanded view is the frontmost surface, so it answers first.
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [expanded.threadRef, collapse]);

  return (
    <div
      className="absolute inset-0 z-40 flex flex-col bg-background"
      role="dialog"
      aria-label={title}
    >
      <div className="flex items-center gap-2 border-border/60 border-b px-3 py-1.5">
        <span className="min-w-0 flex-1 truncate font-medium text-secondary-label text-xs">
          {title}
        </span>
        <button
          type="button"
          className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[0.6875rem] text-secondary-label/70 hover:bg-accent/20 hover:text-secondary-label"
          onClick={() => collapse(expanded.threadRef)}
          aria-label="Close the expanded view"
        >
          <XIcon className="size-3" aria-hidden />
          Close
        </button>
      </div>
      <div className="min-h-0 flex-1">
        <AgentUiRenderFrame
          key={expanded.renderId}
          threadRef={expanded.threadRef}
          renderId={expanded.renderId}
          onTitle={setTitle}
        />
      </div>
    </div>
  );
}
