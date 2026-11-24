// Fork behavior of nodeSqliteClient: the reader pool skips a worker that still runs a
// cancelled read. Kept apart from upstream's test file so upstream merges do not touch it.
import type * as NodeWorkerThreads from "node:worker_threads";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import { vi } from "vite-plus/test";

import * as SqliteClient from "./nodeSqliteClient.ts";

// A request whose SQL carries this marker never reaches the worker, so it stays pending
// as a read the worker is still running would.
const HANG_MARKER = "/* t3-test-hang */";

const startedWorkers = vi.hoisted((): Array<NodeWorkerThreads.Worker> => []);
const hangs = vi.hoisted(() => ({ onHang: (): void => {} }));

vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeWorkerThreads>();
  class HangingWorker extends actual.Worker {
    constructor(...args: ConstructorParameters<typeof actual.Worker>) {
      super(...args);
      startedWorkers.push(this);
    }
    override postMessage(...args: Parameters<NodeWorkerThreads.Worker["postMessage"]>) {
      const [value] = args;
      if (
        typeof value === "object" &&
        value !== null &&
        "sql" in value &&
        typeof value.sql === "string" &&
        value.sql.includes(HANG_MARKER)
      ) {
        hangs.onHang();
        return;
      }
      super.postMessage(...args);
    }
  }
  return { ...actual, Worker: HangingWorker };
});

const countEntries = (sql: SqlClient.SqlClient) =>
  Effect.map(
    sql<{ count: number }>`SELECT COUNT(*) AS count FROM entries`,
    (rows) => rows[0]?.count,
  );

it.effect("routes a read past a reader still running a cancelled read", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sqlite-busy-" });
    const filename = path.join(directory, "state.sqlite");
    return yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA journal_mode = WAL`;
      yield* sql`CREATE TABLE entries(name TEXT NOT NULL)`;
      yield* sql`INSERT INTO entries VALUES ('first')`;
      const startedBefore = startedWorkers.length;

      const hung = yield* Deferred.make<void>();
      hangs.onHang = () => Deferred.doneUnsafe(hung, Effect.void);
      const cancelled = yield* sql
        .unsafe(`SELECT 1 ${HANG_MARKER}`)
        .pipe(SqliteClient.readOnly, (effect) =>
          Effect.forkChild(effect, { startImmediately: true }),
        );
      yield* Deferred.await(hung);
      yield* Fiber.interrupt(cancelled);
      assert.equal(startedWorkers.length, startedBefore + 1);

      // The first slot is free again but its worker still owes the cancelled reply, so the
      // read starts the next slot's worker instead of queueing behind it.
      assert.equal(yield* countEntries(sql).pipe(SqliteClient.readOnly), 1);
      assert.equal(startedWorkers.length, startedBefore + 2);
    }).pipe(Effect.provide(SqliteClient.layer({ filename, readerWorker: true })));
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        hangs.onHang = () => {};
      }),
    ),
    Effect.scoped,
    Effect.provide(NodeServices.layer),
  ),
);
