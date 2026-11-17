/** T3-CUSTOM(expbkt3): Credential-free server-owned Toolyard settings. */
import * as Schema from "effect/Schema";
export const ToolyardIntegrationStatus = Schema.Struct({
  revision: Schema.Number,
  revocationPending: Schema.Number,
  enabled: Schema.Boolean,
  removed: Schema.Boolean,
  baseUrl: Schema.NullOr(Schema.String),
  instanceId: Schema.NullOr(Schema.String),
  origin: Schema.NullOr(Schema.String),
  administrator: Schema.Boolean,
  mode: Schema.optional(Schema.Literals(["team", "api-key", "host"])),
  hostConsentAllowed: Schema.optional(Schema.Boolean),
  hostName: Schema.optional(Schema.String),
  agentId: Schema.optional(Schema.NullOr(Schema.String)),
  ownerId: Schema.optional(Schema.NullOr(Schema.String)),
  pendingConnection: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        requestId: Schema.String,
        authorizationUrl: Schema.NullOr(Schema.String),
        expiresAt: Schema.String,
        status: Schema.Literals(["pending", "rejected", "expired", "cancelled", "approved"]),
        lastError: Schema.NullOr(Schema.String),
      }),
    ),
  ),
  apiKeyAllowed: Schema.optional(Schema.Boolean),
  teamAvailable: Schema.optional(Schema.Boolean),
  callbackTransport: Schema.optional(Schema.Literals(["push", "pull"])),
  connection: Schema.Literals(["connected", "not_connected", "unavailable", "revoked", "disabled"]),
  /** Toolyard's code for the last failed attempt on this connection, if one failed. */
  connectionError: Schema.optional(Schema.NullOr(Schema.String)),
  email: Schema.NullOr(Schema.String),
  expiresAt: Schema.NullOr(Schema.String),
  /** The instance this server offers before an administrator saves one. */
  defaultBaseUrl: Schema.optional(Schema.String),
  /** Where the default came from: `T3_TOOLYARD_URL` or the built-in URL. */
  defaultBaseUrlSource: Schema.optional(Schema.Literals(["environment", "built-in"])),
});
export type ToolyardIntegrationStatus = typeof ToolyardIntegrationStatus.Type;
export const ToolyardIntegrationConfigureInput = Schema.Struct({
  expectedRevision: Schema.Number,
  baseUrl: Schema.String,
  origin: Schema.String,
  enabled: Schema.Boolean,
  adminToken: Schema.optional(Schema.String),
  remove: Schema.optional(Schema.Boolean),
  mode: Schema.optional(Schema.Literals(["team", "api-key", "host"])),
  apiKey: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096))),
  hostAction: Schema.optional(Schema.Literals(["begin", "poll", "cancel"])),
  disconnect: Schema.optional(Schema.Boolean),
  /** Ask Toolyard again for the caller's own team connection; no settings change. */
  reconnect: Schema.optional(Schema.Boolean),
});
export const ToolyardDashboardHandoff = Schema.Struct({
  url: Schema.String,
  expiresAt: Schema.String,
});
