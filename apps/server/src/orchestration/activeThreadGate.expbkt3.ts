/**
 * T3-CUSTOM(expbkt3): answer the HTTP thread read of an archived or deleted
 * thread before the full detail read.
 *
 * `getThreadDetailSnapshot` loads messages, activities, plans and pull
 * requests in parallel with the thread row, and only then finds the row
 * missing, because the row query skips archived and deleted threads. That cost
 * ~150 ms of synchronous SQLite per 404 on bkt3. The Linear bridge reads
 * hundreds of archived threads in waves (TEC-1502): on 2026-10-02, 480 such
 * reads in three minutes blocked the event loop for up to 50 s a minute and
 * dropped client connections.
 *
 * This checks the row query's own condition first, so the answer is unchanged
 * and an archived thread costs one primary-key lookup.
 */
import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Whether `threadId` is a thread `getThreadDetailSnapshot` would return. */
export const makeActiveThreadCheck = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return (threadId: ThreadId) =>
    sql<{ readonly found: number }>`
      SELECT 1 AS "found"
      FROM projection_threads
      WHERE thread_id = ${threadId}
        AND deleted_at IS NULL
        AND archived_at IS NULL
      LIMIT 1
    `.pipe(Effect.map((rows) => rows.length > 0));
});
