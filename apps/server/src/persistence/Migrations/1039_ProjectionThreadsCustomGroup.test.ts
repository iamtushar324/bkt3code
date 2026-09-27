// T3-CUSTOM(expbkt3): custom sidebar group migration coverage.
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

it.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" })))(
  "1039_ProjectionThreadsCustomGroup",
  (it) => {
    it.effect("adds the nullable custom group column", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 1039 });

        const columns = yield* sql<{ readonly name: string }>`
          PRAGMA table_info(projection_threads)
        `;
        assert.isTrue(columns.some((column) => column.name === "custom_group"));
      }),
    );

    it.effect("is idempotent when the column already exists", () =>
      Effect.gen(function* () {
        yield* runMigrations({ toMigrationInclusive: 1039 });
        yield* runMigrations({ toMigrationInclusive: 1039 });
        const columns = yield* SqlClient.SqlClient.pipe(
          Effect.flatMap(
            (sql) => sql<{ readonly name: string }>`PRAGMA table_info(projection_threads)`,
          ),
        );
        assert.strictEqual(columns.filter((column) => column.name === "custom_group").length, 1);
      }),
    );
  },
);
