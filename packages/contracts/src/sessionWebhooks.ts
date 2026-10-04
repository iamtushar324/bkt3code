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
export const SessionWebhookDeliveryAttempt = Schema.Struct({
  attempt: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
  at: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  httpStatus: Schema.NullOr(Schema.Number.check(Schema.isInt())),
  outcome: Schema.String.check(Schema.isMaxLength(500)),
});
export const SessionWebhookDeliveryHistory = Schema.Struct({
  eventId: Schema.String.check(Schema.isMaxLength(256)),
  inboxId: Schema.String.check(Schema.isMaxLength(256)),
  status: Schema.Literals(["pending", "delivering", "delivered", "failed"]),
  attempts: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  terminalReason: Schema.NullOr(Schema.String.check(Schema.isMaxLength(500))),
  history: Schema.Array(SessionWebhookDeliveryAttempt).check(Schema.isMaxLength(256)),
});
export type SessionWebhookDeliveryHistory = typeof SessionWebhookDeliveryHistory.Type;
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
  deliveryHistory: Schema.optional(
    Schema.Array(SessionWebhookDeliveryHistory).check(Schema.isMaxLength(100)),
  ),
  deliveryHistoryError: Schema.optional(Schema.NullOr(Schema.String)),
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
