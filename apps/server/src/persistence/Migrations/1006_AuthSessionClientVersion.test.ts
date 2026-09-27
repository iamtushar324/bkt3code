import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
// T3-CUSTOM(expbkt3): upstream moved the node SQLite client to shared.
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" })));

layer("1006_AuthSessionClientVersion", (it) => {
  it.effect("adds client_app_version after the existing migration history", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 1005 });

      const before = yield* sql<{ readonly name: string }>`PRAGMA table_info(auth_sessions)`;
      assert.isFalse(before.some((column) => column.name === "client_app_version"));

      yield* runMigrations();
      const after = yield* sql<{ readonly name: string }>`PRAGMA table_info(auth_sessions)`;
      assert.isTrue(after.some((column) => column.name === "client_app_version"));
    }),
  );
});
