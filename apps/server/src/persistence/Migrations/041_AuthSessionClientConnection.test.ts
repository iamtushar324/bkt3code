import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" })));

layer("041_AuthSessionClientConnection", (it) => {
  it.effect("adds nullable client surface and app version columns to auth sessions", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      // T3-CUSTOM(expbkt3): upstream's 040/041 register as 1018/1019 in the fork lane.
      yield* runMigrations({ toMigrationInclusive: 1018 });
      yield* runMigrations({ toMigrationInclusive: 1019 });

      const columns = yield* sql<{ readonly name: string; readonly notnull: number }>`
        PRAGMA table_info(auth_sessions)
      `;
      const surface = columns.find((column) => column.name === "client_surface");
      const appVersion = columns.find((column) => column.name === "client_app_version");

      assert.equal(surface?.name, "client_surface");
      assert.equal(surface?.notnull, 0);
      assert.equal(appVersion?.name, "client_app_version");
      assert.equal(appVersion?.notnull, 0);
    }),
  );
});
