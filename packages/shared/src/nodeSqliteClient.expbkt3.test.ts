// Fork behavior of nodeSqliteClient: bounded checkpoint admission, the gate wait
// before the writer lock, and the reader pool. Kept apart from upstream's test file
// so upstream merges do not touch it.
import * as NodeSqlite from "node:sqlite";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqliteClient from "./nodeSqliteClient.ts";

// 256 KiB rows: about 64 WAL frames each, so 40 rows pass the checkpoint
// worker's 1000-frame check and, with a pinned WAL, close the admission gate.
const ROW_BYTES = 256 * 1024;
const ROWS = 40;

const elapsed = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.suspend(() => {
    const start = performance.now();
    return Effect.map(effect, (value) => ({ value, ms: performance.now() - start }));
  });

/**
 * A client with the checkpoint worker, and a second connection that holds a
 * read snapshot so the checkpoint cannot pass it until `release` runs.
 */
const withPinnedWal = <A, E>(
  config: Omit<SqliteClient.SqliteClientConfig, "filename">,
  use: (
    sql: SqlClient.SqlClient,
    pin: { readonly held: () => boolean; readonly release: () => void },
  ) => Effect.Effect<A, E, SqlClient.SqlClient>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sqlite-admission-" });
    const filename = path.join(directory, "state.sqlite");
    return yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA journal_mode = WAL`;
      yield* sql.unsafe("PRAGMA journal_size_limit = 65536");
      yield* sql`CREATE TABLE entries(body BLOB NOT NULL)`;
      yield* sql`INSERT INTO entries VALUES (zeroblob(16))`;
      const other = yield* Effect.acquireRelease(
        Effect.sync(() => {
          const database = new NodeSqlite.DatabaseSync(filename, { readOnly: true });
          database.exec("BEGIN");
          database.prepare("SELECT count(*) AS count FROM entries").get();
          return database;
        }),
        (database) =>
          Effect.sync(() => {
            if (database.isTransaction) database.exec("COMMIT");
            database.close();
          }),
      );
      return yield* use(sql, {
        held: () => other.isTransaction,
        release: () => {
          if (other.isTransaction) other.exec("COMMIT");
        },
      });
    }).pipe(Effect.provide(SqliteClient.layer({ filename, checkpointWorker: true, ...config })));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const insertRow = (sql: SqlClient.SqlClient) =>
  sql.withTransaction(sql`INSERT INTO entries VALUES (zeroblob(${ROW_BYTES}))`);

it.live("lets writes through a WAL that a reader pins once they waited the admission timeout", () =>
  withPinnedWal({ checkpointAdmissionTimeout: "200 millis" }, (sql, pin) =>
    Effect.gen(function* () {
      const waits: Array<number> = [];
      for (let row = 0; row < ROWS; row++) {
        waits.push((yield* elapsed(insertRow(sql))).ms);
      }
      // The gate closed and one write waited for the timeout, but the writes did
      // not wait for the reader that pins the WAL.
      assert.isTrue(pin.held());
      assert.isAtLeast(Math.max(...waits), 150);
      assert.isBelow(Math.max(...waits), 5_000);
      assert.deepEqual(yield* sql`SELECT count(*) AS count FROM entries`.values, [[ROWS + 1]]);
    }).pipe(Effect.timeout("20 seconds")),
  ),
);

it.live("keeps the writer free for reads while a write transaction waits at the gate", () =>
  withPinnedWal({}, (sql, pin) =>
    Effect.gen(function* () {
      let written = 0;
      const writes = yield* Effect.forkChild(
        Effect.gen(function* () {
          for (let row = 0; row < ROWS; row++) {
            yield* insertRow(sql);
            written++;
          }
        }),
      );
      // Wait until the writes stop: without an admission timeout they wait for the pin.
      let previous = -1;
      while (written !== previous) {
        previous = written;
        yield* Effect.sleep("300 millis");
      }
      assert.isBelow(written, ROWS);

      // A plain read on the writer must not queue behind the waiting transaction.
      const read = yield* elapsed(sql`SELECT count(*) AS count FROM entries`.values);
      assert.isBelow(read.ms, 1_000);
      assert.deepEqual(read.value, [[written + 1]]);

      pin.release();
      yield* Fiber.join(writes).pipe(Effect.timeout("20 seconds"));
      assert.equal(written, ROWS);
    }).pipe(Effect.timeout("30 seconds")),
  ),
);

it.live("sends a read-only transaction to an idle reader while another runs a slow read", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sqlite-pool-" });
    const filename = path.join(directory, "state.sqlite");
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA journal_mode = WAL`;
      yield* sql`CREATE TABLE entries(name TEXT NOT NULL)`;
      yield* sql`INSERT INTO entries VALUES ('first')`;
      const slow = sql
        .withTransaction(
          sql`
            WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 3000000)
            SELECT count(*) AS n FROM c
          `,
        )
        .pipe(SqliteClient.readOnly);
      const fast = sql
        .withTransaction(sql`SELECT count(*) AS count FROM entries`.values)
        .pipe(SqliteClient.readOnly);
      // Start both workers, then time the slow read alone.
      yield* Effect.all([fast, fast], { concurrency: "unbounded" });
      const alone = (yield* elapsed(slow)).ms;

      const slowRead = yield* Effect.forkChild(slow);
      yield* Effect.sleep("20 millis");
      const read = yield* elapsed(fast);
      assert.deepEqual(read.value, [[1]]);
      assert.isBelow(read.ms, alone / 2);
      yield* Fiber.join(slowRead);
    }).pipe(
      Effect.provide(
        SqliteClient.layer({
          filename,
          readerWorker: true,
          readerWorkers: 2,
          checkpointWorker: true,
        }),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer), Effect.timeout("30 seconds")),
);
