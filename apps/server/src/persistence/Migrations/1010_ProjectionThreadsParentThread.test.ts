// T3-CUSTOM(expbkt3): session lineage migration coverage.
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
// T3-CUSTOM(expbkt3): upstream moved the node SQLite client to shared.
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

it.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" })))(
  "1010_ProjectionThreadsParentThread",
  (it) => {
    it.effect("adds the nullable parent thread column", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 1010 });

        const columns = yield* sql<{ readonly name: string; readonly notnull: number }>`
          PRAGMA table_info(projection_threads)
        `;
        const parentColumn = columns.find((column) => column.name === "parent_thread_id");
        assert.isDefined(parentColumn);
        // Existing rows predate lineage, so the column must accept NULL.
        assert.strictEqual(parentColumn?.notnull, 0);
      }),
    );

    it.effect("indexes children so the cycle guard never scans the projection", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 1010 });

        const indexes = yield* sql<{ readonly name: string }>`
          PRAGMA index_list(projection_threads)
        `;
        assert.isTrue(
          indexes.some((index) => index.name === "idx_projection_threads_parent_thread_id"),
        );
      }),
    );
  },
);
