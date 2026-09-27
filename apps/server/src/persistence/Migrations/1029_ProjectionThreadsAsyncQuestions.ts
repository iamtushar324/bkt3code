import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// T3-CUSTOM(expbkt3): async Codex questions are discoverable but never block.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE projection_threads
    ADD COLUMN pending_async_user_input_count INTEGER NOT NULL DEFAULT 0
  `;
  // T3-CUSTOM(expbkt3): Existing rows may have been projected before
  // responseMode existed. Rebuild both summaries from the lifecycle ledger so
  // an upgrade cannot leave an async question red as Needs Input.
  yield* sql`
    WITH unresolved AS (
      SELECT
        requested.thread_id,
        requested.turn_id,
        json_extract(requested.payload_json, '$.requestId') AS request_id,
        COALESCE(json_extract(requested.payload_json, '$.responseMode'), '') = 'message' AS is_async
      FROM projection_thread_activities AS requested
      WHERE requested.kind = 'user-input.requested'
        AND json_extract(requested.payload_json, '$.requestId') IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM projection_thread_activities AS resolved
          WHERE resolved.thread_id = requested.thread_id
            AND json_extract(resolved.payload_json, '$.requestId') = json_extract(requested.payload_json, '$.requestId')
            AND (
              resolved.kind = 'user-input.resolved'
              OR (
                resolved.kind = 'provider.user-input.respond.failed'
                AND (
                  lower(COALESCE(json_extract(resolved.payload_json, '$.detail'), '')) LIKE '%stale pending user-input request%'
                  OR lower(COALESCE(json_extract(resolved.payload_json, '$.detail'), '')) LIKE '%unknown pending user-input request%'
                  OR lower(COALESCE(json_extract(resolved.payload_json, '$.detail'), '')) LIKE '%unknown pending user input request%'
                  OR lower(COALESCE(json_extract(resolved.payload_json, '$.detail'), '')) LIKE '%unknown pending codex user input request%'
                )
              )
            )
            AND (
              COALESCE(resolved.sequence, -1) > COALESCE(requested.sequence, -1)
              OR (
                COALESCE(resolved.sequence, -1) = COALESCE(requested.sequence, -1)
                AND (resolved.created_at > requested.created_at OR (resolved.created_at = requested.created_at AND resolved.activity_id > requested.activity_id))
              )
            )
        )
    )
    UPDATE projection_threads
    SET
      pending_async_user_input_count = COALESCE((
        SELECT COUNT(DISTINCT request_id) FROM unresolved
        WHERE unresolved.thread_id = projection_threads.thread_id AND unresolved.is_async
      ), 0),
      pending_user_input_count = COALESCE((
        SELECT COUNT(DISTINCT request_id) FROM unresolved
        WHERE unresolved.thread_id = projection_threads.thread_id
          AND NOT unresolved.is_async
          AND (unresolved.turn_id IS NULL OR NOT EXISTS (
            SELECT 1 FROM projection_turns
            WHERE projection_turns.thread_id = unresolved.thread_id
              AND projection_turns.turn_id = unresolved.turn_id
              AND projection_turns.state IN ('completed', 'interrupted', 'error')
          ))
      ), 0)
  `;
});
