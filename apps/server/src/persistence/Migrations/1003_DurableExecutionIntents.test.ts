import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
// T3-CUSTOM(expbkt3): upstream moved the node SQLite client to shared.
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" })));
const backfillLayer = it.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" })));

layer("1003_DurableExecutionIntents", (it) => {
  it.effect("installs durable work items, leases, exact payload, and attempt audit fields", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 1003 });

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_thread_execution_intents)
      `;
      const names = new Set(columns.map((column) => column.name));

      for (const expected of [
        "work_item_id",
        "thread_id",
        "message_id",
        "command_id",
        "request_event_sequence",
        "message_text",
        "attachments_json",
        "model_selection_json",
        "runtime_mode",
        "interaction_mode",
        "bootstrap_json",
        "source_proposed_plan_json",
        "acting_user_id",
        "desired_state",
        "phase",
        "delivery_certainty",
        "recovery_attempts",
        "next_attempt_at",
        "claim_owner",
        "claim_generation",
        "claim_expires_at",
        "last_failure_type",
        "exhausted_at",
        "dismissed_at",
      ]) {
        assert.isTrue(names.has(expected), `missing ${expected}`);
      }

      const attemptColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(thread_execution_recovery_attempts)
      `;
      assert.isTrue(attemptColumns.some((column) => column.name === "claim_generation"));
      assert.isTrue(attemptColumns.some((column) => column.name === "outcome"));
      const bootstrapColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(thread_execution_bootstrap_operations)
      `;
      const bootstrapNames = new Set(bootstrapColumns.map((column) => column.name));
      assert.isTrue(bootstrapNames.has("worktree_phase"));
      assert.isTrue(bootstrapNames.has("setup_phase"));
      assert.isTrue(bootstrapNames.has("setup_terminal_id"));
    }),
  );
});

backfillLayer("1003_DurableExecutionIntents legacy conversion", (it) => {
  it.effect("backfills exact legacy work and makes exhausted or unresolvable rows stopped", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 1001 });

      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, turn_id, role, text, attachments_json,
          is_streaming, sent_by_user_id, created_at, updated_at
        ) VALUES (
          'message-running', 'thread-running', NULL, 'user', 'exact prompt',
          '[{"id":"attachment-1","type":"image","name":"proof.png","mimeType":"image/png","size":12}]',
          0, 'user-1', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type,
          occurred_at, command_id, causation_event_id, correlation_id,
          actor_kind, payload_json, metadata_json
        ) VALUES (
          'event-running', 'thread', 'thread-running', 1, 'thread.turn-start-requested',
          '2026-01-01T00:00:00.000Z', 'command-running', NULL, 'correlation-running',
          'client',
          '{"threadId":"thread-running","messageId":"message-running","modelSelection":{"instanceId":"codex","model":"gpt-5.6-sol","options":[]},"runtimeMode":"full-access","interactionMode":"default","bootstrap":{"runSetupScript":true},"createdAt":"2026-01-01T00:00:00.000Z"}',
          '{"actorUserId":"user-1"}'
        )
      `;
      yield* sql`
        INSERT INTO session_recovery_state (
          thread_id, desired_state, reason, last_execution_id, attempts,
          last_attempt_at, next_attempt_at, recovered_at, gave_up_at, updated_at
        ) VALUES
          ('thread-running', 'running', 'server-restarted', 'command-running', 3,
           '2026-01-01T00:01:00.000Z', NULL, NULL, NULL, '2026-01-01T00:01:00.000Z'),
          ('thread-exhausted', 'running', 'provider-crashed', 'execution-exhausted', 10,
           '2026-01-01T00:02:00.000Z', NULL, NULL, '2026-01-01T00:02:00.000Z', '2026-01-01T00:02:00.000Z'),
          ('thread-unknown', 'running', 'server-restarted', NULL, 1,
           '2026-01-01T00:03:00.000Z', NULL, NULL, NULL, '2026-01-01T00:03:00.000Z')
      `;

      yield* runMigrations({ toMigrationInclusive: 1003 });

      const rows = yield* sql<{
        readonly threadId: string;
        readonly workItemId: string;
        readonly commandId: string;
        readonly messageText: string | null;
        readonly attachmentsJson: string | null;
        readonly desiredState: string;
        readonly phase: string;
        readonly runnable: number;
        readonly recoveryAttempts: number;
      }>`
        SELECT
          thread_id AS "threadId",
          work_item_id AS "workItemId",
          command_id AS "commandId",
          message_text AS "messageText",
          attachments_json AS "attachmentsJson",
          desired_state AS "desiredState",
          phase,
          runnable,
          recovery_attempts AS "recoveryAttempts"
        FROM projection_thread_execution_intents
        ORDER BY thread_id
      `;

      assert.lengthOf(rows, 3);

      const running = rows.find((row) => row.threadId === "thread-running");
      assert.strictEqual(running?.workItemId, "command-running");
      assert.strictEqual(running?.commandId, "command-running");
      assert.strictEqual(running?.messageText, "exact prompt");
      assert.match(running?.attachmentsJson ?? "", /attachment-1/);
      assert.strictEqual(running?.desiredState, "running");
      assert.strictEqual(running?.phase, "recovering");
      assert.strictEqual(running?.runnable, 1);
      assert.strictEqual(running?.recoveryAttempts, 3);

      const exhausted = rows.find((row) => row.threadId === "thread-exhausted");
      assert.strictEqual(exhausted?.desiredState, "stopped");
      assert.strictEqual(exhausted?.phase, "recovery-exhausted");
      assert.strictEqual(exhausted?.runnable, 0);

      const unknown = rows.find((row) => row.threadId === "thread-unknown");
      assert.strictEqual(unknown?.desiredState, "stopped");
      assert.strictEqual(unknown?.phase, "recovery-exhausted");
      assert.strictEqual(unknown?.runnable, 0);
    }),
  );
});
