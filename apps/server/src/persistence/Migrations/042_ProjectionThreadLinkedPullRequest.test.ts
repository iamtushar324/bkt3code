import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" })));

layer("042_ProjectionThreadLinkedPullRequest", (it) => {
  it.effect("adds the linked pull request column", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      // T3-CUSTOM(expbkt3): upstream's 041/042 register as 1019/1020 in the fork lane.
      yield* runMigrations({ toMigrationInclusive: 1019 });
      yield* runMigrations({ toMigrationInclusive: 1020 });

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      assert.ok(columns.some((column) => column.name === "linked_pull_request_json"));
    }),
  );
});
