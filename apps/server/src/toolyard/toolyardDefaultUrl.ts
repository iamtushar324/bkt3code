// T3-CUSTOM(expbkt3): the Toolyard instance offered before an admin saves one.
// Precedence: the saved, verified instance > `T3_TOOLYARD_URL` > the built-in
// DEFAULT_TOOLYARD_BASE_URL. The default only pre-fills setup; registering
// trust still needs an administrator.
import { DEFAULT_TOOLYARD_BASE_URL, KNOWN_TOOLYARD_MCP_URLS } from "@t3tools/contracts";

export const TOOLYARD_URL_ENV = "T3_TOOLYARD_URL";

export type ToolyardDefaultUrlSource = "environment" | "built-in";

export interface ToolyardDefaultUrl {
  /** An https origin, no path. */
  readonly url: string;
  readonly source: ToolyardDefaultUrlSource;
  /** The environment named a value this server cannot use; `url` is the built-in default. */
  readonly rejected?: string;
}

/**
 * The https origin of an operator-supplied Toolyard URL. A trailing `/mcp`
 * (the endpoint people copy) and trailing slashes are accepted; anything else
 * beyond the origin is refused.
 */
export function toolyardOriginFromConfig(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  const path = url.pathname.replace(/\/+$/, "");
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (path !== "" && path.toLowerCase() !== "/mcp")
  )
    return null;
  return url.origin;
}

export function resolveToolyardDefaultUrl(raw: string | undefined): ToolyardDefaultUrl {
  const trimmed = raw?.trim() ?? "";
  if (trimmed === "") return { url: DEFAULT_TOOLYARD_BASE_URL, source: "built-in" };
  const origin = toolyardOriginFromConfig(trimmed);
  return origin === null
    ? { url: DEFAULT_TOOLYARD_BASE_URL, source: "built-in", rejected: trimmed }
    : { url: origin, source: "environment" };
}

/**
 * The MCP endpoints of the given instance origins plus `known` endpoints
 * (by default every endpoint a client recognises, earlier builds' included).
 */
export function toolyardMcpUrlCandidates(
  origins: ReadonlyArray<string | null | undefined>,
  known: ReadonlyArray<string> = KNOWN_TOOLYARD_MCP_URLS,
): ReadonlyArray<string> {
  return [
    ...new Set([
      ...origins.filter((origin): origin is string => !!origin).map((origin) => `${origin}/mcp`),
      ...known,
    ]),
  ];
}
