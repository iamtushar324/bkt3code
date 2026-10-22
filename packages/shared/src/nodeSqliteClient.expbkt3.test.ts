// Fork behavior of nodeSqliteClient: bounded checkpoint admission, the gate wait
// before the writer lock, and the reader pool. Kept apart from upstream's test file
// so upstream merges do not touch it.
import * as NodeSqlite from "node:sqlite";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as References from "effect/References";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as SqliteClient from "./nodeSqliteClient.ts";

// With 512-byte pages a 64 KiB row is about 130 WAL frames, so ROWS rows pass the
// 10,000-frame backpressure limit. The writer counts its own frames after each
// commit, so the gate closes before the last row whatever the worker replies.
const ROW_BYTES = 64 * 1024;
const ROWS = 100;

/** Completes a Deferred for each admission log line, so tests wait on events, not time. */
const admissionEvents = Effect.gen(function* () {
  const paused = yield* Deferred.make<void>();
  const timedOut = yield* Deferred.make<void>();
  const resumed = yield* Deferred.make<void>();
  const signals = [
    ["SQLite checkpoint admission paused", paused],
    ["SQLite checkpoint admission timed out", timedOut],
    ["SQLite checkpoint admission resumed", resumed],
  ] as const;
  const logger = Logger.make<unknown, void>(({ message }) => {
    const text = String(Array.isArray(message) ? message[0] : message);
    for (const [prefix, signal] of signals) {
      if (text.startsWith(prefix)) Deferred.doneUnsafe(signal, Effect.void);
    }
  });
  return { paused, timedOut, resumed, logger };
});

interface PinnedWal {
  readonly sql: SqlClient.SqlClient;
  readonly events: Effect.Success<typeof admissionEvents>;
  /** A second connection holds a read snapshot, so no checkpoint can pass it. */
  readonly pin: { readonly held: () => boolean; readonly release: () => void };
}

const withPinnedWal = <A, E>(
  config: Omit<SqliteClient.SqliteClientConfig, "filename">,
  use: (wal: PinnedWal) => Effect.Effect<A, E, SqlClient.SqlClient>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sqlite-admission-" });
    const filename = path.join(directory, "state.sqlite");
    const events = yield* admissionEvents;
    return yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA page_size = 512`;
      yield* sql`PRAGMA journal_mode = WAL`;
      yield* sql`CREATE TABLE entries(body BLOB NOT NULL)`;
      yield* sql`INSERT INTO entries VALUES (zeroblob(16))`;
      assert.deepEqual(yield* sql`PRAGMA page_size`.values, [[512]]);
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
      return yield* use({
        sql,
        events,
        pin: {
          held: () => other.isTransaction,
          release: () => {
            if (other.isTransaction) other.exec("COMMIT");
          },
        },
      });
    }).pipe(
      Effect.provide(SqliteClient.layer({ filename, checkpointWorker: true, ...config })),
      // The client captures its logger and clock when it starts.
      Effect.provide(Logger.layer([events.logger])),
      Effect.provideService(References.MinimumLogLevel, "Debug"),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const insertRows = (sql: SqlClient.SqlClient, rows: number) =>
  Effect.gen(function* () {
    for (let row = 0; row < rows; row++) {
      yield* sql.withTransaction(sql`INSERT INTO entries VALUES (zeroblob(${ROW_BYTES}))`);
    }
  });

const countRows = (sql: SqlClient.SqlClient) =>
  Effect.map(
    sql<{ count: number }>`SELECT count(*) AS count FROM entries`,
    (rows) => rows[0]?.count,
  );

it.effect("lets writes through a pinned WAL once one has waited the admission timeout", () =>
  withPinnedWal({ checkpointAdmissionTimeout: "1 second" }, ({ sql, events, pin }) =>
    Effect.gen(function* () {
      const writes = yield* Effect.forkChild(insertRows(sql, ROWS));
      yield* Deferred.await(events.paused);
      // The reader still pins the WAL, so the writes wait for the timeout.
      assert.isUndefined(writes.pollUnsafe());

      yield* TestClock.adjust("1 second");
      yield* Deferred.await(events.timedOut);
      yield* Fiber.join(writes);
      assert.isTrue(pin.held());
      assert.equal(yield* countRows(sql), ROWS + 1);

      // Once the pin ends, a checkpoint catches up and writes wait at the gate again.
      pin.release();
      yield* Deferred.await(events.resumed);
      yield* insertRows(sql, 1);
      assert.equal(yield* countRows(sql), ROWS + 2);
    }),
  ),
);

it.effect("keeps the writer free for reads while a write transaction waits at the gate", () =>
  withPinnedWal({ checkpointAdmissionTimeout: "1 hour" }, ({ sql, events, pin }) =>
    Effect.gen(function* () {
      const writes = yield* Effect.forkChild(insertRows(sql, ROWS));
      yield* Deferred.await(events.paused);

      // The waiting transaction does not hold the writer lock, so this read runs now.
      const whileWaiting = yield* countRows(sql);
      assert.isBelow(whileWaiting ?? ROWS + 1, ROWS + 1);
      assert.isUndefined(writes.pollUnsafe());

      pin.release();
      yield* Fiber.join(writes);
      assert.equal(yield* countRows(sql), ROWS + 1);
    }),
  ),
);

const withReaderPool = <A, E>(
  use: (sql: SqlClient.SqlClient) => Effect.Effect<A, E, SqlClient.SqlClient>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sqlite-pool-" });
    const filename = path.join(directory, "state.sqlite");
    return yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA journal_mode = WAL`;
      yield* sql`CREATE TABLE entries(body BLOB NOT NULL)`;
      yield* sql`INSERT INTO entries VALUES (zeroblob(16))`;
      return yield* use(sql);
    }).pipe(Effect.provide(SqliteClient.layer({ filename, readerWorker: true, readerWorkers: 2 })));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

it.effect("serves a read-only transaction from a free reader while another reader is held", () =>
  withReaderPool((sql) =>
    Effect.gen(function* () {
      const readerHeld = yield* Deferred.make<void>();
      const writerHeld = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const holdReader = yield* Effect.forkChild(
        sql
          .withTransaction(
            countRows(sql).pipe(
              Effect.andThen(Deferred.succeed(readerHeld, undefined)),
              Effect.andThen(Deferred.await(release)),
            ),
          )
          .pipe(SqliteClient.readOnly),
      );
      const holdWriter = yield* Effect.forkChild(
        sql.withTransaction(
          sql`INSERT INTO entries VALUES (zeroblob(16))`.pipe(
            Effect.andThen(Deferred.succeed(writerHeld, undefined)),
            Effect.andThen(Deferred.await(release)),
          ),
        ),
      );
      yield* Deferred.await(readerHeld);
      yield* Deferred.await(writerHeld);

      // Only the second reader is free: on the held reader or the writer this read
      // would wait for `release`. It sees the state before the open write.
      assert.equal(yield* sql.withTransaction(countRows(sql)).pipe(SqliteClient.readOnly), 1);

      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(holdReader);
      yield* Fiber.join(holdWriter);
      assert.equal(yield* countRows(sql), 2);
    }),
  ),
);
