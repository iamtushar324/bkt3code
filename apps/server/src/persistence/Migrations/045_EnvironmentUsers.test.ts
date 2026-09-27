import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
// T3-CUSTOM(expbkt3): upstream moved the node SQLite client to shared.
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" })));

layer("045_EnvironmentUsers", (it) => {
  it.effect("adds durable Clerk users and identity-bound auth sessions", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 45 });

      const tables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'table'
      `;
      const userColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(environment_users)
      `;
      const sessionColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(auth_sessions)
      `;

      assert.isTrue(tables.some((table) => table.name === "environment_users"));
      for (const column of [
        "user_id",
        "display_name",
        "primary_email",
        "avatar_url",
        "role",
        "status",
        "first_seen_at",
        "last_seen_at",
      ]) {
        assert.isTrue(
          userColumns.some((entry) => entry.name === column),
          column,
        );
      }
      assert.isTrue(sessionColumns.some((column) => column.name === "user_id"));
    }),
  );
});
