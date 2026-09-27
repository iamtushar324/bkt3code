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
