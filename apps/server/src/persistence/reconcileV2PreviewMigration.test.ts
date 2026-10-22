// T3-CUSTOM(expbkt3): BEGIN — BK never shipped upstream's V2 previews at IDs 53/54.
// Its released V1 ledger is frozen; V2 must append at 1043 without rewriting it.
import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as SqlClient from "effect/sql/SqlClient";

import { migrationManifest, runMigrations } from "./Migrations.ts";

const database = NodeSqliteClient.layer({ filename: ":memory:" });
const pendingV2Migrations = [
  [1043, "OrchestrationV2"],
  [1044, "RemoveRedundantProjectionIndexes"],
  [1045, "SessionWebhooks"],
  [1046, "ScheduledTaskWebhooks"],
  [1047, "WebhookRelayDeliveries"],
  [1048, "ThreadCommentLastSent"],
  [1049, "McpAppModelContext"],
  [1050, "ThreadSnapshotWindowIndexes"],
  [1051, "ScheduledTaskCustomGroups"],
  [1052, "ScheduledTaskForkOptions"],
  [1053, "ThreadClaudeAccountWait"],
  // Upstream 61, 62 and 64, remapped into the 1000+ lane (63 stays unregistered).
  [1054, "PullRequestReviewGuides"],
  [1055, "ThreadFailureLookupIndex"],
  [1056, "CanonicalizeThreadPullRequestLinks"],
  // Upstream 65-66, remapped into the 1000+ lane.
  [1057, "CodexUsageNativeTurnIndex"],
  [1058, "RepairClientSettlementTimestamps"],
  // Upstream 67, remapped into the 1000+ lane.
  [1059, "WebhookDedupe"],
] as const;

describe("fork V2 ledger upgrade", () => {
  it.effect("appends V2 without changing the released V1 ledger", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 1042 });
      const original = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
      assert.deepStrictEqual(yield* runMigrations(), pendingV2Migrations);
      assert.deepStrictEqual(yield* runMigrations(), []);
      assert.deepStrictEqual(
        yield* sql`SELECT * FROM effect_sql_migrations WHERE migration_id <= 1042 ORDER BY migration_id`,
        original,
      );
      const history = yield* sql<{ readonly migration_id: number; readonly name: string }>`
        SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
      `;
      assert.deepStrictEqual(
        history.map((row) => [row.migration_id, row.name] as const),
        migrationManifest,
      );
    }).pipe(Effect.provide(database)),
  );

  it.effect("keeps existing V2 import progress when applying index cleanup and webhooks", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 1043 });
      yield* sql`
        INSERT INTO orchestration_v2_legacy_imports
          (thread_id, source_updated_at, shell_imported_at, transcript_imported_at, imported_message_count)
        VALUES ('imported-thread', '2026-09-15', '2026-09-15', '2026-09-16', 42)
      `;
      const imports = yield* sql`SELECT * FROM orchestration_v2_legacy_imports`;
      const original = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
      assert.deepStrictEqual(yield* runMigrations(), pendingV2Migrations.slice(1));
      assert.deepStrictEqual(yield* runMigrations(), []);
      assert.deepStrictEqual(yield* sql`SELECT * FROM orchestration_v2_legacy_imports`, imports);
      assert.deepStrictEqual(
        yield* sql`SELECT * FROM effect_sql_migrations WHERE migration_id <= 1043 ORDER BY migration_id`,
        original,
      );
    }).pipe(Effect.provide(database)),
  );

  it.effect("rolls back schema and ledger together on failure and can retry", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 1042 });
      const original = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
      // Effect 4.0.1's Migrator treats a constraint error on its ledger insert as "another run
      // holds the lock" and returns no migrations, and RAISE(ABORT) is a constraint error. A
      // trigger that writes to a missing table fails the insert with a plain SQL error instead.
      yield* sql`
        CREATE TRIGGER fail_v2_upgrade BEFORE INSERT ON effect_sql_migrations
        WHEN NEW.name = 'OrchestrationV2'
        BEGIN INSERT INTO injected_failure_missing_table VALUES (1); END
      `;
      assert.ok(Exit.isFailure(yield* Effect.exit(runMigrations())));
      assert.deepStrictEqual(
        yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`,
        original,
      );
      assert.deepStrictEqual(
        yield* sql`SELECT name FROM sqlite_master WHERE name = 'orchestration_v2_legacy_imports'`,
        [],
      );
      yield* sql`DROP TRIGGER fail_v2_upgrade`;
      assert.deepStrictEqual(yield* runMigrations(), pendingV2Migrations);
    }).pipe(Effect.provide(database)),
  );

  // Upstream's guard against a ledger that would skip a V2 migration, on the fork's ids.
  it.effect("refuses unexpected later migrations without modifying their history", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 1042 });
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (1044, 'UnknownFork')`;
      const history = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
      assert.ok(Exit.isFailure(yield* Effect.exit(runMigrations())));
      assert.deepStrictEqual(
        yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`,
        history,
      );
    }).pipe(Effect.provide(database)),
  );
});
// T3-CUSTOM(expbkt3): END
