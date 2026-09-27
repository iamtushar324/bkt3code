// T3-CUSTOM(expbkt3): manual-title ownership column.
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
// T3-CUSTOM(expbkt3): upstream moved the node SQLite client to shared.
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" })));

layer("1013_ProjectionThreadsTitleManual", (it) => {
  it.effect("adds title_manually_set, defaulted off for existing rows", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 1012 });
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode,
          interaction_mode, branch, worktree_path, latest_turn_id, created_at,
          updated_at, archived_at, settled_override, settled_at, pinned_at,
          latest_user_message_at, pending_approval_count, pending_user_input_count,
          has_actionable_proposed_plan, rolling_summary, deleted_at
        ) VALUES (
          'thread-1', 'project-1', 'Existing title', '{}', 'full-access',
          'default', NULL, NULL, NULL, '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z', NULL, NULL, NULL, NULL,
          NULL, 0, 0, 0, NULL, NULL
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 1013 });

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      assert.ok(new Set(columns.map((column) => column.name)).has("title_manually_set"));

      // Existing sessions keep today's behavior — the cadence may still
      // retitle them — until something records an owner.
      const rows = yield* sql<{ readonly title_manually_set: number }>`
        SELECT title_manually_set FROM projection_threads WHERE thread_id = 'thread-1'
      `;
      assert.strictEqual(rows[0]?.title_manually_set, 0);
    }),
  );
});
