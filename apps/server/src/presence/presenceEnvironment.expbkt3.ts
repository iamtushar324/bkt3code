/**
 * T3-CUSTOM(expbkt3): tells shell tools inside an agent session where to ask
 * about the human's presence.
 *
 * A provider process already carries `T3_MCP_BEARER_TOKEN`, but the server's
 * base URL only appears inside the provider's MCP config. `BK_T3_PRESENCE_URL`
 * is the full `GET /api/presence` URL for the session, derived from the same
 * MCP endpoint the credential was issued for, so
 *
 *   curl -H "Authorization: Bearer $T3_MCP_BEARER_TOKEN" "$BK_T3_PRESENCE_URL"
 *
 * works unchanged on every deployment. It is injected only where the bearer
 * is (the Claude and Codex adapters); a URL without the credential beside it
 * would be a dead end.
 */
import type { ThreadId } from "@t3tools/contracts";

export const PRESENCE_URL_KEY = "BK_T3_PRESENCE_URL";
export const PRESENCE_ROUTE_PATH = "/api/presence";

/** `http://host:port/mcp` → `http://host:port/api/presence?sessionId=<threadId>`. */
export function presenceUrlForSession(mcpEndpoint: string, threadId: ThreadId): string {
  const base = mcpEndpoint.replace(/\/mcp\/?$/, "");
  return `${base}${PRESENCE_ROUTE_PATH}?sessionId=${encodeURIComponent(String(threadId))}`;
}

/** The one variable to spread into a provider environment next to `T3_MCP_BEARER_TOKEN`. */
export function presenceEnvironmentFor(config: {
  readonly endpoint: string;
  readonly threadId: ThreadId;
}): Readonly<Record<string, string>> {
  return { [PRESENCE_URL_KEY]: presenceUrlForSession(config.endpoint, config.threadId) };
}
