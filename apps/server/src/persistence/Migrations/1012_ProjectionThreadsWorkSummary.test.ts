// T3-CUSTOM(expbkt3): bulk session manager work summary migration coverage.
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
// T3-CUSTOM(expbkt3): upstream moved the node SQLite client to shared.
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

it.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" })))(
  "1012_ProjectionThreadsWorkSummary",
  (it) => {
    it.effect("adds the nullable work summary column", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 1012 });

        const columns = yield* sql<{
          readonly name: string;
          readonly type: string;
          readonly notnull: number;
        }>`
          PRAGMA table_info(projection_threads)
        `;
        const column = columns.find((entry) => entry.name === "work_summary");
        assert.isDefined(column);
        assert.strictEqual(column?.type, "TEXT");
        // NULL is the "never generated" state and must stay representable.
        assert.strictEqual(column?.notnull, 0);
      }),
    );

    it.effect("is idempotent when the column already exists", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 1012 });
        yield* runMigrations({ toMigrationInclusive: 1012 });

        const columns = yield* sql<{ readonly name: string }>`
          PRAGMA table_info(projection_threads)
        `;
        assert.strictEqual(columns.filter((entry) => entry.name === "work_summary").length, 1);
      }),
    );
  },
);
