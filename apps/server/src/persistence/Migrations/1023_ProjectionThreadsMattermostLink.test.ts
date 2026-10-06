// T3-CUSTOM(expbkt3): durable Mattermost conversation link migration coverage.
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
// T3-CUSTOM(expbkt3): upstream moved the node SQLite client to shared.
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

it.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" })))(
  "1023_ProjectionThreadsMattermostLink",
  (it) => {
    it.effect("adds the nullable Mattermost conversation URL", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 1023 });

        const columns = yield* sql<{ readonly name: string }>`
          PRAGMA table_info(projection_threads)
        `;
        assert.isTrue(columns.some((column) => column.name === "mattermost_thread_url"));
      }),
    );
  },
);
