import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as SqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import type { Caller } from "../../threadAccess.ts";
import { readSessionOffEventLoop } from "./offLoopReads.ts";

const threadId = ThreadId.make("toolkit-read-thread");

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

/** A caller whose transcript import writes a row, as a v1 import would. */
const importingCaller = (sql: SqlClient.SqlClient, imports: Array<ThreadId>) =>
  ({
    threads: {
      ensureLegacyTranscript: (id: ThreadId) =>
        Effect.suspend(() => {
          imports.push(id);
          return sql`INSERT INTO entries VALUES ('imported')`.pipe(Effect.asVoid, Effect.orDie);
        }),
    },
  }) as unknown as Caller;

it.effect("imports the transcript on the writer, then reads it", () =>
  withReaderClient((sql) =>
    Effect.gen(function* () {
      const imports: Array<ThreadId> = [];
      const read = yield* readSessionOffEventLoop(
        importingCaller(sql, imports),
        threadId,
        sql.withTransaction(names(sql)),
      );

      assert.deepEqual(imports, [threadId]);
      assert.deepEqual(read, ["first", "imported"]);
    }),
  ),
);

it.effect("runs the read itself on the read-only reader", () =>
  withReaderClient((sql) =>
    Effect.gen(function* () {
      const error = yield* readSessionOffEventLoop(
        importingCaller(sql, []),
        threadId,
        sql.withTransaction(sql`INSERT INTO entries VALUES ('blocked')`),
      ).pipe(Effect.flip);

      assert.equal(error._tag, "SqlError");
      assert.include(
        String(error._tag === "SqlError" ? error.reason.cause : error),
        "readonly database",
      );
      assert.deepEqual(yield* names(sql), ["first", "imported"]);
    }),
  ),
);

it.effect("does not read when the transcript import fails", () =>
  withReaderClient((sql) =>
    Effect.gen(function* () {
      let reads = 0;
      const caller = {
        threads: { ensureLegacyTranscript: () => Effect.fail("import failed" as const) },
      } as unknown as Caller;
      const error = yield* readSessionOffEventLoop(
        caller,
        threadId,
        Effect.suspend(() => {
          reads += 1;
          return sql.withTransaction(names(sql));
        }),
      ).pipe(Effect.flip);

      assert.equal(error as unknown, "import failed");
      assert.equal(reads, 0);
    }),
  ),
);
