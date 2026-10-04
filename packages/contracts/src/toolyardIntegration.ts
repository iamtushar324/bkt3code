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
  connection: Schema.Literals(["connected", "not_connected", "unavailable", "revoked", "disabled"]),
  email: Schema.NullOr(Schema.String),
  expiresAt: Schema.NullOr(Schema.String),
});
export type ToolyardIntegrationStatus = typeof ToolyardIntegrationStatus.Type;
export const ToolyardIntegrationConfigureInput = Schema.Struct({
  expectedRevision: Schema.Number,
  baseUrl: Schema.String,
  origin: Schema.String,
  enabled: Schema.Boolean,
  adminToken: Schema.optional(Schema.String),
  remove: Schema.optional(Schema.Boolean),
});
export const ToolyardDashboardHandoff = Schema.Struct({
  url: Schema.String,
  expiresAt: Schema.String,
});
