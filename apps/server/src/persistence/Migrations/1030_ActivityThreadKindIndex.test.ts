// T3-CUSTOM(expbkt3): upgrading an existing activity ledger adds the sync index without rewriting history.
import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))("1030_ActivityThreadKindIndex", (it) => {
  it.effect("preserves existing activity rows when adding the thread/kind index", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 1029 });
      yield* sql`INSERT INTO projection_thread_activities
        (activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at)
        VALUES ('existing', 'thread', NULL, 'info', 'approval.requested', 'Approve',
          '{"requestId":"existing"}', 17, '2026-09-09T00:00:00.000Z')`;
      const before = yield* sql`SELECT * FROM projection_thread_activities`;
      yield* runMigrations({ toMigrationInclusive: 1030 });
      assert.deepStrictEqual(yield* sql`SELECT * FROM projection_thread_activities`, before);
      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA index_info(idx_projection_thread_activities_thread_kind)`;
      assert.deepStrictEqual(
        columns.map((column) => column.name),
        ["thread_id", "kind"],
      );
      yield* runMigrations({ toMigrationInclusive: 1030 });
      assert.deepStrictEqual(yield* sql`SELECT * FROM projection_thread_activities`, before);
    }),
  );
});
