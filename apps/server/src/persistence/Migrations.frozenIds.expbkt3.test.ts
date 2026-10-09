// T3-CUSTOM(expbkt3): retained BK behavior at the native V2 boundary.
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as SqlClient from "effect/sql/SqlClient";
import { migrationManifest, runMigrations } from "./Migrations.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))("fork migration ledger", (it) => {
  it.effect("runs the new V2 migrations after frozen applied fork identities", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 1042 });
      const sql = yield* SqlClient.SqlClient;
      const before = yield* sql<{
        migration_id: number;
        name: string;
      }>`SELECT migration_id,name FROM effect_sql_migrations ORDER BY migration_id`;
      const executed = yield* runMigrations();
      assert.deepStrictEqual(executed, [
        [1043, "OrchestrationV2"],
        [1044, "RemoveRedundantProjectionIndexes"],
        [1045, "SessionWebhooks"],
        [1046, "ScheduledTaskWebhooks"],
        [1047, "WebhookRelayDeliveries"],
        [1048, "ThreadCommentLastSent"],
        // Upstream 59-60, remapped into the 1000+ lane.
        [1049, "McpAppModelContext"],
        [1050, "ThreadSnapshotWindowIndexes"],
        // BK sidebar custom group for scheduled task threads.
        [1051, "ScheduledTaskCustomGroups"],
      ]);
      const after = yield* sql<{
        migration_id: number;
        name: string;
      }>`SELECT migration_id,name FROM effect_sql_migrations WHERE migration_id<=1042 ORDER BY migration_id`;
      assert.deepStrictEqual(after, before);
      assert.deepStrictEqual(
        migrationManifest.filter(
          ([id]) => id === 33 || id === 34 || id === 1040 || id === 1041 || id === 1042,
        ),
        [
          [33, "ProjectionOwnershipMembership"],
          [34, "ProjectionThreadMessageSender"],
          [1040, "ThreadComments"],
          [1041, "ThreadClaudeAccount"],
          [1042, "ClaudeAccountProfileAccess"],
        ],
      );
      assert.deepStrictEqual(yield* runMigrations(), []);
    }),
  );
});
