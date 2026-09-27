import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { TestClock } from "effect/testing";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "./Layers/Sqlite.ts";
import {
  runSqliteOptimize,
  SQLITE_OPTIMIZE_ENV,
  SqliteOptimizeScheduleLive,
  sqliteOptimizeEnabled,
} from "./sqliteOptimize.expbkt3.ts";

const seedIndexedTable = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE optimize_probe (id INTEGER PRIMARY KEY, bucket TEXT NOT NULL)`;
  yield* sql`CREATE INDEX optimize_probe_bucket ON optimize_probe(bucket)`;
  yield* sql`
    WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 2000)
    INSERT INTO optimize_probe (id, bucket) SELECT i, 'b' || (i % 7) FROM n
  `;
  // The planner records tables a connection used; optimize=0x10002 also covers the rest.
  yield* sql`SELECT count(*) FROM optimize_probe WHERE bucket = 'b1'`;
});

const statRows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql<{ readonly n: number }>`
    SELECT count(*) AS n FROM sqlite_master WHERE name = 'sqlite_stat1'
  `;
  if (tables[0]?.n === 0) return 0;
  const rows = yield* sql<{ readonly n: number }>`
    SELECT count(*) AS n FROM sqlite_stat1 WHERE tbl = 'optimize_probe'
  `;
  return rows[0]?.n ?? 0;
});

describe("sqlite optimize", () => {
  it("is on unless explicitly disabled", () => {
    assert.isTrue(sqliteOptimizeEnabled({}));
    assert.isTrue(sqliteOptimizeEnabled({ [SQLITE_OPTIMIZE_ENV]: "1" }));
    assert.isFalse(sqliteOptimizeEnabled({ [SQLITE_OPTIMIZE_ENV]: "0" }));
    assert.isFalse(sqliteOptimizeEnabled({ [SQLITE_OPTIMIZE_ENV]: "off" }));
  });

  it.effect("writes planner statistics for a table that has none", () =>
    Effect.gen(function* () {
      yield* seedIndexedTable;
      assert.strictEqual(yield* statRows, 0);
      yield* runSqliteOptimize;
      assert.isAbove(yield* statRows, 0);
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect("waits a full interval before the first run", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* seedIndexedTable;
        yield* Layer.build(SqliteOptimizeScheduleLive);
        yield* TestClock.adjust("5 hours");
        assert.strictEqual(yield* statRows, 0, "must not run at startup or before 6 h");
        yield* TestClock.adjust("1 hour");
        assert.isAbove(yield* statRows, 0);
      }),
    ).pipe(Effect.provide(SqlitePersistenceMemory)),
  );
});
