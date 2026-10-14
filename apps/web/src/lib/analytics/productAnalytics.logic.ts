/**
 * T3-CUSTOM(expbkt3): pure rules for client product analytics (TEC-1631).
 *
 * Everything that decides *what* leaves the client lives here, so it can be
 * tested without PostHog: the named events, the property allowlist per event,
 * route → view names, palette command ids, and the URL properties PostHog adds
 * on its own that we strip before send. Nothing here sends text, titles,
 * paths, branch or repository names, or setting values.
 *
 * @module productAnalytics.logic
 */

export type ProductAnalyticsSurface = "web" | "desktop";
export type ProductAnalyticsConnectionMode = "local" | "tailnet" | "remote" | "relay" | "ssh";

/** Properties each event may carry. Anything else is dropped before capture. */
export const PRODUCT_ANALYTICS_EVENTS = {
  "app.opened": [],
  "app.foregrounded": [],
  "app.backgrounded": [],
  "view.changed": ["view"],
  "session.opened": ["threadId"],
  "composer.sent": ["threadId", "interactionMode", "hasAttachments", "viaKeyboard"],
  "command_palette.used": ["commandId"],
  "settings.changed": ["settingKey"],
  "approval.answered_in_ui": ["threadId", "kind", "decision"],
  "question.answered_in_ui": ["threadId", "kind"],
  "plan.action": ["threadId", "action", "source"],
} as const satisfies Record<string, ReadonlyArray<string>>;

export type ProductAnalyticsEvent = keyof typeof PRODUCT_ANALYTICS_EVENTS;
export type ProductAnalyticsProperties = Readonly<Record<string, string | number | boolean>>;

/** Longest string value kept. Ids and enum tokens fit; free text does not. */
const MAX_STRING_PROPERTY_LENGTH = 96;

/**
 * Keeps only the allowlisted keys of `event` whose values are short strings,
 * finite numbers or booleans. Unknown events keep nothing.
 */
export function sanitizeAnalyticsProperties(
  event: string,
  properties: Readonly<Record<string, unknown>> | undefined,
): ProductAnalyticsProperties {
  const allowed: ReadonlyArray<string> | undefined =
    PRODUCT_ANALYTICS_EVENTS[event as ProductAnalyticsEvent];
  if (allowed === undefined || properties === undefined) return {};
  const result: Record<string, string | number | boolean> = {};
  for (const key of allowed) {
    const value = properties[key];
    if (typeof value === "boolean") result[key] = value;
    else if (typeof value === "number" && Number.isFinite(value)) result[key] = value;
    else if (
      typeof value === "string" &&
      value.length > 0 &&
      value.length <= MAX_STRING_PROPERTY_LENGTH
    ) {
      result[key] = value;
    }
  }
  return result;
}

/**
 * A view name from a TanStack route id, which is the route *template*
 * (`/_chat/$environmentId/$threadId`), never the visited URL. Pathless layout
 * segments (`_chat`) lose their underscore; params keep only their name.
 */
export function viewNameFromRouteId(routeId: string | null | undefined): string | null {
  if (!routeId) return null;
  if (routeId === "__root__") return "/";
  const segments = routeId
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => (segment.startsWith("_") ? segment.slice(1) : segment))
    .filter((segment) => /^\$?[A-Za-z][\w-]*$/.test(segment));
  return `/${segments.join("/")}`;
}

const COMMAND_SEGMENT = /^[a-z][a-z-]*$/;

/**
 * A stable command id from a palette item `value` such as
 * `action:add-project:<environmentId>:local`. Keeps at most the first two
 * segments, and stops at the first one that is not a plain lowercase word, so
 * ids, paths and search text never leave.
 */
export function commandIdFromPaletteValue(value: string): string | null {
  const kept: string[] = [];
  for (const segment of value.split(":").slice(0, 2)) {
    if (!COMMAND_SEGMENT.test(segment)) break;
    kept.push(segment);
  }
  return kept.length === 0 ? null : kept.join(":");
}

/**
 * The command id for a palette item: its keybinding command when it has one,
 * else the cleaned `value`. Project scripts (`script.<name>.run`) collapse to
 * `script.run`, since the name is the user's own.
 */
export function commandIdForPaletteItem(item: {
  readonly shortcutCommand?: string | undefined;
  readonly value: string;
}): string | null {
  if (item.shortcutCommand !== undefined) {
    return item.shortcutCommand.startsWith("script.") ? "script.run" : item.shortcutCommand;
  }
  return commandIdFromPaletteValue(item.value);
}

/** Settings keys are camelCase identifiers; anything else is not a key. */
export function isAnalyticsSettingKey(key: string): boolean {
  return /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(key);
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** How this client reaches its primary environment, from the primary target. */
export function resolveConnectionMode(
  target:
    | { readonly _tag: "PrimaryConnectionTarget"; readonly httpBaseUrl: string }
    | { readonly _tag: "RelayConnectionTarget" }
    | { readonly _tag: "BearerConnectionTarget" }
    | { readonly _tag: "SshConnectionTarget" }
    | null,
): ProductAnalyticsConnectionMode | null {
  if (target === null) return null;
  switch (target._tag) {
    case "RelayConnectionTarget":
      return "relay";
    case "SshConnectionTarget":
      return "ssh";
    case "BearerConnectionTarget":
      return "remote";
    case "PrimaryConnectionTarget": {
      let hostname: string;
      try {
        hostname = new URL(target.httpBaseUrl).hostname.toLowerCase();
      } catch {
        return null;
      }
      if (LOOPBACK_HOSTS.has(hostname)) return "local";
      if (hostname.endsWith(".ts.net") || isTailnetIpv4(hostname)) return "tailnet";
      return "remote";
    }
  }
}

function isTailnetIpv4(hostname: string): boolean {
  const match = /^100\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(hostname);
  if (!match) return false;
  const second = Number(match[1]);
  return second >= 64 && second <= 127;
}

/**
 * Properties PostHog adds on its own that carry the visited URL (thread ids,
 * `?repository=owner/repo`), the host, the referrer or the window title
 * (thread titles). They are removed in `before_send`, from event properties
 * and from `$set` / `$set_once`. Checked against posthog-js 1.438.
 */
export const STRIPPED_POSTHOG_PROPERTIES = [
  "$current_url",
  "$pathname",
  "$host",
  "$title",
  "$referrer",
  "$referring_domain",
  "$external_click_url",
  "$el_text",
  "$elements",
  "$elements_chain",
  // Campaign and click ids are read from the URL query string.
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "utm_term",
  "gad_source",
  "mc_cid",
  "gclid",
  "gclsrc",
  "dclid",
  "gbraid",
  "wbraid",
  "fbclid",
  "msclkid",
  "twclid",
  "li_fat_id",
  "igshid",
  "ttclid",
  "rdt_cid",
  "epik",
  "qclid",
  "sccid",
  "oppref",
  "irclid",
  "_kx",
] as const;

/**
 * Prefixes of PostHog property families built from the URL or referrer:
 * `$initial_*` (first-touch person info), `$session_entry_*` (the session's
 * entry URL, path, host and referrer), `$prev_pageview_*` (the previous path).
 */
export const STRIPPED_POSTHOG_PROPERTY_PREFIXES = [
  "$initial_",
  "$session_entry_",
  "$prev_pageview_",
] as const;

const STRIPPED_PROPERTY_SET: ReadonlySet<string> = new Set(STRIPPED_POSTHOG_PROPERTIES);

function isStrippedProperty(key: string): boolean {
  return (
    STRIPPED_PROPERTY_SET.has(key) ||
    STRIPPED_POSTHOG_PROPERTY_PREFIXES.some((prefix) => key.startsWith(prefix))
  );
}

export function stripUrlProperties<T extends Record<string, unknown>>(properties: T): T {
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(properties)) {
    if (!isStrippedProperty(key)) next[key] = value;
  }
  return next as T;
}

/**
 * Reports app visibility once it has been stable for `delayMs`. A quick
 * hide-then-show (window switch, tab peek) sends nothing; a real change sends
 * one event, and the same state is never sent twice in a row.
 */
export function createVisibilityReporter(input: {
  readonly delayMs: number;
  readonly emit: (state: "foreground" | "background") => void;
  readonly setTimer?: (callback: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
}) {
  const setTimer =
    input.setTimer ?? ((callback: () => void, ms: number) => globalThis.setTimeout(callback, ms));
  const clearTimer =
    input.clearTimer ??
    ((handle: unknown) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>));
  let lastEmitted: "foreground" | "background" = "foreground";
  let timer: unknown = null;
  return {
    update(state: "foreground" | "background"): void {
      if (timer !== null) {
        clearTimer(timer);
        timer = null;
      }
      if (state === lastEmitted) return;
      timer = setTimer(() => {
        timer = null;
        lastEmitted = state;
        input.emit(state);
      }, input.delayMs);
    },
    dispose(): void {
      if (timer !== null) clearTimer(timer);
      timer = null;
    },
  };
}

/** True at most once per `windowMs` for each key. */
export function createKeyThrottle(windowMs: number, now: () => number = Date.now) {
  const lastByKey = new Map<string, number>();
  return (key: string): boolean => {
    const at = now();
    const last = lastByKey.get(key);
    if (last !== undefined && at - last < windowMs) return false;
    lastByKey.set(key, at);
    return true;
  };
}
