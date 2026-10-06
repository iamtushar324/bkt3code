// T3-CUSTOM(expbkt3): thread review comments migration coverage.
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const tableColumns = (table: string) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql<{ readonly name: string }>`PRAGMA table_info(${sql.literal(table)})`,
  );

it.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" })))(
  "1040_ThreadComments",
  (it) => {
    it.effect("creates the comment and per-thread settings tables", () =>
      Effect.gen(function* () {
        yield* runMigrations({ toMigrationInclusive: 1040 });

        const comments = yield* tableColumns("thread_comments");
        const names = comments.map((column) => column.name);
        for (const expected of [
          "comment_id",
          "thread_id",
          "number",
          "kind",
          "anchor_json",
          "body",
          "status",
          "author_user_id",
          "author_label",
          "replies_json",
          "created_at",
          "updated_at",
          "resolved_at",
        ]) {
          assert.include(names, expected);
        }

        const settings = yield* tableColumns("thread_comment_settings");
        assert.deepStrictEqual(
          settings.map((column) => column.name),
          ["thread_id", "delivery_paused", "next_number"],
        );
      }),
    );

    it.effect("is idempotent", () =>
      Effect.gen(function* () {
        yield* runMigrations({ toMigrationInclusive: 1040 });
        yield* runMigrations({ toMigrationInclusive: 1040 });
        const comments = yield* tableColumns("thread_comments");
        assert.strictEqual(comments.filter((column) => column.name === "comment_id").length, 1);
      }),
    );
  },
);
