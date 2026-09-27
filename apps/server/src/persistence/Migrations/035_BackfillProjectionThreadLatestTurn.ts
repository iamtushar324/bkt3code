/**
 * 035_BackfillProjectionThreadLatestTurn - Restore latest_turn_id wiped on settle.
 *
 * `thread.session-set` used to assign `latest_turn_id = session.activeTurnId`
 * verbatim. A settling session carries `activeTurnId: null`, so every thread
 * lost its latest-turn reference the moment a turn finished. Two consequences:
 * the turn's state/duration disappeared from the UI, and — worse — a completed
 * thread became indistinguishable from a half-finished bootstrap, so a retried
 * bootstrap turn-start "resumed" it and started a fresh turn on an existing
 * thread instead of no-oping.
 *
 * The projector no longer clears it, but rows already written stay wrong until
 * repaired. Point each affected thread at its most recent turn.
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
        WHERE t.thread_id = projection_threads.thread_id AND t.turn_id IS NOT NULL
      )
  `;
});
