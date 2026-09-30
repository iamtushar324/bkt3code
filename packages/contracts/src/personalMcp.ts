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
/** toolyard, the Bifrost-compatible replacement gateway. Opt-in per user. */
export const TOOLYARD_MCP_URL = "https://toolyard.dev.beknown.live/mcp" as const;

/**
 * The only endpoints an `x-bf-vk` integration may target, so a stored virtual
 * key is never sent to an arbitrary URL. The first entry is the default.
 */
export const BIFROST_GATEWAYS = [
  { url: BIFROST_MCP_URL, integrationName: "Bifrost" },
  { url: TOOLYARD_MCP_URL, integrationName: "Bifrost (toolyard)" },
] as const;
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
