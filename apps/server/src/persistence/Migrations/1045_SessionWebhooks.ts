/** T3-CUSTOM(expbkt3): durable owner-bound callback destinations and dispatch receipts. */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE session_webhooks (
    id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL, thread_id TEXT NOT NULL,
    instance_id TEXT NOT NULL, trust_binding TEXT NOT NULL, callback_ref TEXT, receiver_revision INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL CHECK(status IN ('registering','active','disabled','removed')),
    revision INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    terminal_reason TEXT, pending_action TEXT CHECK(pending_action IN ('rotate','disable','remove')),
    sync_attempts INTEGER NOT NULL DEFAULT 0, next_sync_at TEXT
  )`;
  yield* sql`CREATE INDEX session_webhooks_owner ON session_webhooks(owner_user_id, created_at)`;
  yield* sql`CREATE TABLE session_webhook_events (
    webhook_id TEXT NOT NULL REFERENCES session_webhooks(id), event_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL, payload TEXT NOT NULL, command_id TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL CHECK(state IN ('queued','dispatching','delivered','terminal')),
    received_at TEXT NOT NULL, updated_at TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
    terminal_reason TEXT, result_sequence INTEGER, next_attempt_at TEXT,
    PRIMARY KEY(webhook_id,event_id)
  )`;
  yield* sql`CREATE INDEX session_webhook_events_queue ON session_webhook_events(state,received_at)`;
});
