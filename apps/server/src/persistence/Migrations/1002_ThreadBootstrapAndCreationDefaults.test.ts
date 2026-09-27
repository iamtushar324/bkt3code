import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
// T3-CUSTOM(expbkt3): upstream moved the node SQLite client to shared.
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" })));

layer("1002_ThreadBootstrapAndCreationDefaults", (it) => {
  it.effect("adds inherited project defaults and durable bootstrap storage", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 1001 });
      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          owner_user_id,
          created_at,
          updated_at,
          deleted_at
        ) VALUES (
          'project-existing',
          'Existing project',
          '/repo/existing',
          '{"instanceId":"codex","model":"gpt-5.6-sol","options":[{"id":"reasoningEffort","value":"high"}]}',
          '[{"id":"setup","name":"Setup","command":"./tools/setup.sh","icon":"configure","runOnWorktreeCreate":true}]',
          NULL,
          '2026-08-01T00:00:00.000Z',
          '2026-08-01T00:00:00.000Z',
          NULL
        )
      `;
      yield* runMigrations({ toMigrationInclusive: 1002 });

      const columns = yield* sql<{
        readonly name: string;
        readonly notnull: number;
        readonly dflt_value: string | null;
      }>`PRAGMA table_info(projection_projects)`;
      const defaultsColumn = columns.find(
        (column) => column.name === "thread_creation_defaults_json",
      );
      assert.isDefined(defaultsColumn);
      assert.strictEqual(defaultsColumn.notnull, 1);
      assert.strictEqual(
        defaultsColumn.dflt_value,
        `'{"environmentMode":null,"worktreeBaseRef":null,"runtimeMode":null,"interactionMode":null}'`,
      );

      const bootstrapColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_thread_bootstraps)
      `;
      assert.deepStrictEqual(
        bootstrapColumns.map((column) => column.name),
        [
          "thread_id",
          "bootstrap_id",
          "status",
          "public_state_json",
          "request_json",
          "created_at",
          "updated_at",
        ],
      );

      const preserved = yield* sql<{
        readonly defaultModelSelection: string | null;
        readonly scripts: string;
        readonly defaults: string;
      }>`
        SELECT
          default_model_selection_json AS "defaultModelSelection",
          scripts_json AS "scripts",
          thread_creation_defaults_json AS "defaults"
        FROM projection_projects
        WHERE project_id = 'project-existing'
      `;
      assert.strictEqual(preserved.length, 1);
      assert.strictEqual(
        preserved[0]!.defaultModelSelection,
        '{"instanceId":"codex","model":"gpt-5.6-sol","options":[{"id":"reasoningEffort","value":"high"}]}',
      );
      assert.strictEqual(
        preserved[0]!.scripts,
        '[{"id":"setup","name":"Setup","command":"./tools/setup.sh","icon":"configure","runOnWorktreeCreate":true}]',
      );
      assert.strictEqual(
        preserved[0]!.defaults,
        '{"environmentMode":null,"worktreeBaseRef":null,"runtimeMode":null,"interactionMode":null}',
      );
    }),
  );
});
