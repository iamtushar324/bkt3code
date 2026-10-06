import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
// T3-CUSTOM(expbkt3): upstream moved the node SQLite client to shared.
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" })));

layer("037_ThreadExecutions", (it) => {
  it.effect("installs the durable authority, generation, revision, and turn fields", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 37 });

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_thread_executions)
      `;
      const names = new Set(columns.map((column) => column.name));

      for (const expected of [
        "thread_id",
        "authority_epoch",
        "revision",
        "provider_generation",
        "execution_id",
        "provider_turn_id",
        "turn_state",
        "stop_requested_at",
      ]) {
        assert.isTrue(names.has(expected), `missing ${expected}`);
      }

      const eventColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(thread_execution_events)
      `;
      assert.isTrue(eventColumns.some((column) => column.name === "event_type"));
    }),
  );
});
