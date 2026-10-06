import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" })));

layer("040_ProjectionProjectFaviconPath", (it) => {
  it.effect("adds the nullable favicon path to project projections", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      // T3-CUSTOM(expbkt3): upstream's 039/040 register as 1017/1018 in the fork lane.
      yield* runMigrations({ toMigrationInclusive: 1017 });
      yield* runMigrations({ toMigrationInclusive: 1018 });

      const columns = yield* sql<{ readonly name: string; readonly notnull: number }>`
        PRAGMA table_info(projection_projects)
      `;
      const faviconPath = columns.find((column) => column.name === "favicon_path");

      assert.equal(faviconPath?.name, "favicon_path");
      assert.equal(faviconPath?.notnull, 0);
    }),
  );
});
