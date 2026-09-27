/**
 * 036_BackfillLatestTurnSkipPendingRows - Finish the 035 latest_turn_id repair.
 *
 * `projection_turns` holds placeholder rows for a requested-but-not-yet-started
 * turn: `turn_id IS NULL`, `state = 'pending'`. Migration 035 picked the most
 * recent turn row without excluding those, so any thread whose newest row was a
 * pending placeholder had `latest_turn_id` set from NULL to NULL and stayed
 * broken — still readable as a half-finished bootstrap.
 *
 * Repeat the repair, ignoring placeholder rows. Idempotent: only touches rows
 * that are still NULL.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    UPDATE projection_threads
    SET latest_turn_id = (
      SELECT t.turn_id
      FROM projection_turns t
      WHERE t.thread_id = projection_threads.thread_id
        AND t.turn_id IS NOT NULL
      ORDER BY t.requested_at DESC, t.row_id DESC
      LIMIT 1
    )
    WHERE latest_turn_id IS NULL
      AND EXISTS (
        SELECT 1 FROM projection_turns t
        WHERE t.thread_id = projection_threads.thread_id
          AND t.turn_id IS NOT NULL
      )
  `;
});
