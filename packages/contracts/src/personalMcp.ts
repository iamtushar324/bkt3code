/**
 * T3-CUSTOM(expbkt3): Per-user T3 automation and MCP integration contracts.
 *
 * These schemas deliberately contain credential metadata only. Credential
 * values are accepted by update inputs, written to the server secret store,
 * and never returned to a client.
 */
import * as Schema from "effect/Schema";

import { IsoDateTime, TrimmedNonEmptyString, TrimmedString, UserId } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const PersonalMcpAuthMode = Schema.Literals([
  "bearer",
  "x-bf-vk",
  "x-api-key",
  "custom-header",
]);
export type PersonalMcpAuthMode = typeof PersonalMcpAuthMode.Type;

export const PersonalMcpIntegrationId = TrimmedNonEmptyString;
export type PersonalMcpIntegrationId = typeof PersonalMcpIntegrationId.Type;

export const BIFROST_MCP_INTEGRATION_ID = "bifrost" as const;
export const BIFROST_MCP_URL = "https://bk-toolhub.beknown.live/mcp" as const;
/**
 * toolyard, the built-in per-user gateway. Every signed-in user gets a
 * `toolyard` integration that T3 connects on their behalf through the Clerk
 * sign-in both apps share; nobody pastes a key.
 */
export const TOOLYARD_MCP_INTEGRATION_ID = "toolyard" as const;
/**
 * The Toolyard instance a server uses when nothing else names one. A server
 * overrides it with `T3_TOOLYARD_URL`, and an administrator's saved instance
 * (Settings → BK Add-ons → Toolyard) wins over both. Clients never use this
 * value to connect; they read the effective URL from the Toolyard status RPC.
 */
export const DEFAULT_TOOLYARD_BASE_URL = "https://toolyard.beknown.live" as const;
export const TOOLYARD_MCP_URL = `${DEFAULT_TOOLYARD_BASE_URL}/mcp` as const;
/**
 * Toolyard endpoints earlier builds used. Recognised (never connected to) so
 * a stored entry that points at one is still treated as Toolyard's, and its
 * key is never re-pointed at another gateway.
 */
export const LEGACY_TOOLYARD_MCP_URLS = ["https://toolyard.dev.beknown.live/mcp"] as const;
/** Every Toolyard MCP endpoint a client can recognise without asking a server. */
export const KNOWN_TOOLYARD_MCP_URLS: ReadonlyArray<string> = [
  TOOLYARD_MCP_URL,
  ...LEGACY_TOOLYARD_MCP_URLS,
];
/** Display name of the built-in integration; also its MCP server name (`mcp__toolyard__*`). */
export const TOOLYARD_MCP_INTEGRATION_NAME = "toolyard" as const;

/**
 * The only endpoints an `x-bf-vk` integration may target, so a stored virtual
 * key is never sent to an arbitrary URL. The first entry is the default.
 */
export const BIFROST_GATEWAYS = [{ url: BIFROST_MCP_URL, integrationName: "Bifrost" }] as const;
export type BifrostGateway = (typeof BIFROST_GATEWAYS)[number];

const normalizeGatewayUrl = (value: string): string | undefined => {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return undefined;
  }
  // The WHATWG parser already lowercases scheme and host, drops the default
  // port, and resolves dot segments; anything beyond scheme, host and path
  // (credentials, a port, a query, a fragment) disqualifies the URL.
  if (url.username || url.password || url.port || url.search || url.hash) return undefined;
  const pathname = url.pathname.replace(/\/+$/, "").toLowerCase();
  return `${url.protocol}//${url.host}${pathname}`;
};

/**
 * The allowlisted gateway `url` names, matched exactly after normalisation
 * (case, trailing slash). Returns the canonical entry, never the input.
 */
export const resolveBifrostGateway = (url: string): BifrostGateway | undefined => {
  const normalized = normalizeGatewayUrl(url);
  if (normalized === undefined) return undefined;
  return BIFROST_GATEWAYS.find((gateway) => normalizeGatewayUrl(gateway.url) === normalized);
};

export const isAllowedBifrostGatewayUrl = (url: string): boolean =>
  resolveBifrostGateway(url) !== undefined;

/**
 * Whether `url` is a toolyard MCP endpoint, matched like the gateway
 * allowlist. A server passes its effective endpoints (the configured instance
 * and its default); without them the known endpoints apply.
 */
export const isToolyardGatewayUrl = (
  url: string,
  gatewayUrls: ReadonlyArray<string> = KNOWN_TOOLYARD_MCP_URLS,
): boolean => {
  const normalized = normalizeGatewayUrl(url);
  return (
    normalized !== undefined &&
    gatewayUrls.some((gatewayUrl) => normalizeGatewayUrl(gatewayUrl) === normalized)
  );
};

/**
 * The endpoint that exchanges a Clerk session token for a toolyard agent
 * token: `POST <toolyard origin>/v1/connect/t3`. Each successful call rotates
 * the person's toolyard token, so T3 calls it only when it has none.
 */
export const toolyardConnectUrl = (mcpUrl: string = TOOLYARD_MCP_URL): string =>
  `${new URL(mcpUrl).origin}/v1/connect/t3`;

export const PersonalMcpIntegration = Schema.Struct({
  id: PersonalMcpIntegrationId,
  name: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  enabled: Schema.Boolean,
  authMode: PersonalMcpAuthMode,
  customHeaderName: TrimmedString,
  credentialConfigured: Schema.Boolean,
  providerInstanceIds: Schema.Array(ProviderInstanceId),
  allowedTools: Schema.Array(TrimmedNonEmptyString),
  /**
   * Set by the server when it connected the integration itself (toolyard):
   * the account it connected as and when. Credential-free; a client cannot
   * write them.
   */
  connectedEmail: Schema.optional(TrimmedString),
  connectedAt: Schema.optional(IsoDateTime),
  /** T3-CUSTOM(expbkt3): server-owned non-secret readiness key for provider refresh. */
  configurationKey: Schema.optional(TrimmedString),
});
export type PersonalMcpIntegration = typeof PersonalMcpIntegration.Type;

export const PersonalMcpIntegrationUpdate = Schema.Struct({
  id: PersonalMcpIntegrationId,
  name: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  enabled: Schema.Boolean,
  authMode: PersonalMcpAuthMode,
  customHeaderName: TrimmedString,
  /** Undefined preserves the existing secret; empty removes it. */
  credential: Schema.optional(Schema.String),
  providerInstanceIds: Schema.Array(ProviderInstanceId),
  allowedTools: Schema.Array(TrimmedNonEmptyString),
});
export type PersonalMcpIntegrationUpdate = typeof PersonalMcpIntegrationUpdate.Type;

export const PersonalMcpProfile = Schema.Struct({
  userId: UserId,
  externalAccessEnabled: Schema.Boolean,
  externalTokenConfigured: Schema.Boolean,
  externalTokenPrefix: TrimmedString,
  integrations: Schema.Array(PersonalMcpIntegration),
  updatedAt: IsoDateTime,
});
export type PersonalMcpProfile = typeof PersonalMcpProfile.Type;

export const PersonalMcpProfileUpdate = Schema.Struct({
  externalAccessEnabled: Schema.Boolean,
  integrations: Schema.Array(PersonalMcpIntegrationUpdate),
});
export type PersonalMcpProfileUpdate = typeof PersonalMcpProfileUpdate.Type;

export const PersonalMcpTokenResult = Schema.Struct({
  profile: PersonalMcpProfile,
  /** Present only for the rotate response. T3 never persists the raw token. */
  token: Schema.optional(TrimmedNonEmptyString),
});
export type PersonalMcpTokenResult = typeof PersonalMcpTokenResult.Type;

/** A fresh Clerk session JWT from the browser; consumed once, never stored. */
export const PersonalMcpToolyardConnectInput = Schema.Struct({
  clerkToken: TrimmedNonEmptyString,
});
export type PersonalMcpToolyardConnectInput = typeof PersonalMcpToolyardConnectInput.Type;

/**
 * Error codes of `personalMcp.connectToolyard`. The first eight are toolyard's
 * own (`{"error": code}` responses; it also answers 500 `internal_error`); the
 * rest name what T3 saw instead of an answer, or why it refused to ask: an
 * unbound connection (`not_signed_in`) or a token issued to someone other than
 * the connection's user (`identity_mismatch`). Kept as a plain string on the
 * wire so a code this list does not know still reaches the client unchanged.
 */
export const TOOLYARD_CONNECT_ERROR_CODES = [
  "bad_request",
  "invalid_token",
  "not_org_member",
  "user_disabled",
  "agent_disabled",
  "connect_disabled",
  "rate_limited",
  "clerk_unavailable",
  "unreachable",
  "timeout",
  "unexpected_response",
  "store_failed",
  "not_signed_in",
  "identity_mismatch",
  "connection_unavailable",
] as const;
export type ToolyardConnectErrorCode = (typeof TOOLYARD_CONNECT_ERROR_CODES)[number];

/** Credential-free outcome: the toolyard agent token never leaves the server. */
export const PersonalMcpToolyardConnectResult = Schema.Struct({
  connected: Schema.Boolean,
  email: Schema.optional(TrimmedString),
  error: Schema.optional(TrimmedNonEmptyString),
});
export type PersonalMcpToolyardConnectResult = typeof PersonalMcpToolyardConnectResult.Type;

export class PersonalMcpSettingsError extends Schema.TaggedError<PersonalMcpSettingsError>()(
  "PersonalMcpSettingsError",
  {
    operation: TrimmedNonEmptyString,
    message: TrimmedNonEmptyString,
  },
) {}

export const emptyPersonalMcpProfile = (userId: UserId, updatedAt: string): PersonalMcpProfile => ({
  userId,
  externalAccessEnabled: false,
  externalTokenConfigured: false,
  externalTokenPrefix: "",
  integrations: [],
  updatedAt: IsoDateTime.make(updatedAt),
});
