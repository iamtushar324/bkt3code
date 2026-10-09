import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { migrationManifest, runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" })));

layer("055_OrchestrationV2", (it) => {
  it.effect("keeps frozen fork IDs and appends V2 above the deployed ledger", () =>
    Effect.sync(() => {
      assert.deepStrictEqual(
        migrationManifest.map(([id]) => id),
        [
          ...Array.from({ length: 45 }, (_, index) => index + 1),
          // T3-CUSTOM(expbkt3): append the session webhook ledger entry at 1045,
          // upstream's scheduled-task webhook migrations (57-58) at 1046-1047, the
          // review comment send-once mark at 1048 and upstream's MCP app context and
          // snapshot indexes (59-60) at 1049-1050, and scheduled task custom
          // groups at 1051.
          ...Array.from({ length: 52 }, (_, index) => 1000 + index),
        ],
      );
    }),
  );

  it.effect("upgrades the deployed fork ledger through the native V2 migrations", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 1042 });

      const executed = yield* runMigrations();
      assert.deepStrictEqual(executed, [
        [1043, "OrchestrationV2"],
        [1044, "RemoveRedundantProjectionIndexes"],
        [1045, "SessionWebhooks"], // T3-CUSTOM(expbkt3): durable callback schema.
        [1046, "ScheduledTaskWebhooks"],
        [1047, "WebhookRelayDeliveries"],
        [1048, "ThreadCommentLastSent"], // T3-CUSTOM(expbkt3): comment send-once mark.
        // T3-CUSTOM(expbkt3): upstream 59-60 remapped to 1049-1050.
        [1049, "McpAppModelContext"],
        [1050, "ThreadSnapshotWindowIndexes"],
        [1051, "ScheduledTaskCustomGroups"], // T3-CUSTOM(expbkt3): scheduled task custom groups.
      ]);
      assert.deepStrictEqual(yield* runMigrations(), []);

      const migrations = yield* sql<{
        readonly migration_id: number;
        readonly name: string;
      }>`
        SELECT migration_id, name
        FROM effect_sql_migrations
        WHERE migration_id >= 1031
        ORDER BY migration_id
      `;
      assert.deepStrictEqual(migrations, [
        { migration_id: 1031, name: "ProjectionThreadBranchPullRequest" },
        { migration_id: 1032, name: "ProjectionThreadsActiveOrderKey" },
        { migration_id: 1033, name: "ProjectionThreadPullRequests" },
        { migration_id: 1034, name: "ProjectionThreadMessageContext" },
        { migration_id: 1035, name: "ThreadWorkspaceGroups" },
        { migration_id: 1036, name: "ProjectionThreadTitleState" },
        { migration_id: 1037, name: "PullRequestFilesViewed" },
        { migration_id: 1038, name: "ProjectionThreadsAutoSettleDisabledAt" },
        { migration_id: 1039, name: "ProjectionThreadsCustomGroup" },
        { migration_id: 1040, name: "ThreadComments" },
        { migration_id: 1041, name: "ThreadClaudeAccount" },
        { migration_id: 1042, name: "ClaudeAccountProfileAccess" },
        { migration_id: 1043, name: "OrchestrationV2" },
        { migration_id: 1044, name: "RemoveRedundantProjectionIndexes" },
        { migration_id: 1045, name: "SessionWebhooks" }, // T3-CUSTOM(expbkt3): append, never rewrite.
        { migration_id: 1046, name: "ScheduledTaskWebhooks" },
        { migration_id: 1047, name: "WebhookRelayDeliveries" },
        { migration_id: 1048, name: "ThreadCommentLastSent" }, // T3-CUSTOM(expbkt3)
        // T3-CUSTOM(expbkt3): upstream 59-60 remapped to 1049-1050.
        { migration_id: 1049, name: "McpAppModelContext" },
        { migration_id: 1050, name: "ThreadSnapshotWindowIndexes" },
        { migration_id: 1051, name: "ScheduledTaskCustomGroups" }, // T3-CUSTOM(expbkt3)
      ]);

      // T3-CUSTOM(expbkt3): verify callback destinations and durable deliveries after the full upgrade.
      const tables = yield* sql<{ readonly name: string }>`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table'
          AND name IN (
            'orchestration_v2_projection_threads',
            'orchestration_v2_projection_subagents',
            'orchestration_v2_effect_outbox',
            'orchestration_v2_turn_item_positions',
            'orchestration_v2_projection_metadata',
            'orchestration_v2_projection_provider_session_bindings',
            'orchestration_v2_thread_launch_workflows',
            'orchestration_v2_legacy_imports',
            'scheduled_tasks',
            'session_webhooks',
            'session_webhook_events'
          )
        ORDER BY name
      `;
      assert.deepStrictEqual(
        tables.map(({ name }) => name),
        [
          "orchestration_v2_effect_outbox",
          "orchestration_v2_legacy_imports",
          "orchestration_v2_projection_metadata",
          "orchestration_v2_projection_provider_session_bindings",
          "orchestration_v2_projection_subagents",
          "orchestration_v2_projection_threads",
          "orchestration_v2_thread_launch_workflows",
          "orchestration_v2_turn_item_positions",
          "scheduled_tasks",
          "session_webhook_events",
          "session_webhooks",
        ],
      );

      const eventColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(orchestration_events)
      `;
      const receiptColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(orchestration_command_receipts)
      `;
      const threadColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(orchestration_v2_projection_threads)
      `;
      const subagentColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(orchestration_v2_projection_subagents)
      `;
      assert.ok(eventColumns.some(({ name }) => name === "application_event_version"));
      assert.ok(receiptColumns.some(({ name }) => name === "command_type"));
      assert.ok(threadColumns.some(({ name }) => name === "provider_instance_id"));
      assert.ok(subagentColumns.some(({ name }) => name === "driver"));
      assert.ok(subagentColumns.some(({ name }) => name === "provider_instance_id"));

      // T3-CUSTOM(expbkt3): the new tables retain fixed routing, remote revisions and deduplication keys.
      const webhookColumns = yield* sql<{
        readonly name: string;
      }>`PRAGMA table_info(session_webhooks)`;
      const webhookEventColumns = yield* sql<{
        readonly name: string;
        readonly pk: number;
      }>`PRAGMA table_info(session_webhook_events)`;
      for (const name of [
        "owner_user_id",
        "thread_id",
        "instance_id",
        "trust_binding",
        "callback_ref",
        "receiver_revision",
        "pending_action",
      ])
        assert.ok(
          webhookColumns.some((column) => column.name === name),
          `missing webhook column ${name}`,
        );
      assert.deepStrictEqual(
        webhookEventColumns.filter(({ pk }) => pk > 0).map(({ name, pk }) => [name, pk]),
        [
          ["webhook_id", 1],
          ["event_id", 2],
        ],
      );
      for (const name of ["fingerprint", "payload", "command_id", "state", "next_attempt_at"])
        assert.ok(
          webhookEventColumns.some((column) => column.name === name),
          `missing delivery column ${name}`,
        );

      const indexes = yield* sql<{ readonly name: string }>`
        SELECT name
        FROM sqlite_master
        WHERE type = 'index'
          AND name IN (
            'idx_orchestration_events_application_high_water',
            'orchestration_events_v2_created_threads_idx',
            'orchestration_v2_projection_turn_items_shell_pending_idx'
          )
        ORDER BY name
      `;
      assert.deepStrictEqual(
        indexes.map(({ name }) => name),
        [
          "idx_orchestration_events_application_high_water",
          "orchestration_events_v2_created_threads_idx",
          "orchestration_v2_projection_turn_items_shell_pending_idx",
        ],
      );
    }),
  );
});
