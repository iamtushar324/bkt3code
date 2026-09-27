/**
 * T3-CUSTOM(expbkt3): scope gate for agent-rendered chat surfaces.
 *
 * URL targets stay blocked. A framed collaboration app can decline to join the
 * room named by the URL and render unrelated origin-local state instead, so T3
 * cannot claim the box shows what the agent asked for.
 *
 * Agent-authored HTML has none of that problem: the document *is* what the
 * agent produced, and it mounts from `srcDoc` in an opaque-origin sandbox that
 * can reach neither T3 nor the network as the signed-in user. It is therefore
 * gated by the client setting alone, the way every other experiment is.
 */
export type AgentUiSurfaceKind = "html" | "url";

/** Whether T3 can render this kind of surface truthfully today. */
export function isAgentUiSurfaceRenderable(kind: AgentUiSurfaceKind): boolean {
  return kind === "html";
}
