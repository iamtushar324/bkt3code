/** T3-CUSTOM(expbkt3): agent-created, owner-bound session callback settings. */
import * as Schema from "effect/Schema";
import { ThreadId } from "./baseSchemas.ts";
export const SessionWebhookDelivery = Schema.Struct({
  eventId: Schema.String,
  state: Schema.Literals(["queued", "dispatching", "delivered", "terminal"]),
  attempts: Schema.Number,
  receivedAt: Schema.String,
  updatedAt: Schema.String,
  terminalReason: Schema.NullOr(Schema.String),
});
export const SessionWebhookView = Schema.Struct({
  id: Schema.String,
  threadId: ThreadId,
  instanceId: Schema.String,
  callbackRef: Schema.NullOr(Schema.String),
  status: Schema.Literals(["registering", "active", "disabled", "removed"]),
  revision: Schema.Number,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  terminalReason: Schema.NullOr(Schema.String),
  deliveries: Schema.Array(SessionWebhookDelivery),
});
export type SessionWebhookView = typeof SessionWebhookView.Type;
export const SessionWebhookUpdateInput = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^swh_[a-f0-9]{32}$/)),
  action: Schema.Literals(["disable", "rotate", "remove"]),
  expectedRevision: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
});
export class SessionWebhookError extends Schema.TaggedError<SessionWebhookError>()(
  "SessionWebhookError",
  {
    status: Schema.Number,
    detail: Schema.String,
  },
) {}
