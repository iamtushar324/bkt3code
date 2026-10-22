import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as SqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import { readOffEventLoop } from "./offLoopReads.ts";

const withReaderClient = <A, E>(
  use: (sql: SqlClient.SqlClient) => Effect.Effect<A, E, SqlClient.SqlClient>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-toolkit-reads-" });
    const filename = path.join(directory, "state.sqlite");
    return yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA journal_mode = WAL`;
      yield* sql`CREATE TABLE entries(name TEXT NOT NULL)`;
      yield* sql`INSERT INTO entries VALUES ('first')`;
      return yield* use(sql);
    }).pipe(Effect.provide(SqliteClient.layer({ filename, readerWorker: true })));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const names = (sql: SqlClient.SqlClient) =>
  Effect.map(sql<{ name: string }>`SELECT name FROM entries ORDER BY rowid`, (rows) =>
    rows.map((row) => row.name),
  );

it.effect("a toolkit read runs once and returns what it read", () =>
  withReaderClient((sql) =>
    Effect.gen(function* () {
      let attempts = 0;
      const read = yield* readOffEventLoop(
        Effect.suspend(() => {
          attempts += 1;
          return sql.withTransaction(names(sql));
        }),
      );

      assert.deepEqual(read, ["first"]);
      assert.equal(attempts, 1);
    }),
  ),
);

it.effect("a toolkit read that has to write runs again where the write lands", () =>
  withReaderClient((sql) =>
    Effect.gen(function* () {
      let attempts = 0;
      // Stands in for the v1 transcript import that every thread read may run first.
      yield* readOffEventLoop(
        Effect.suspend(() => {
          attempts += 1;
          return sql.withTransaction(sql`INSERT INTO entries VALUES ('imported')`);
        }),
      );

      assert.equal(attempts, 2);
      assert.deepEqual(yield* names(sql), ["first", "imported"]);
    }),
  ),
);
