import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// T3-CUSTOM(expbkt3): execution snapshots read request/resolution kinds, not tool history.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE INDEX idx_projection_thread_activities_thread_kind
    ON projection_thread_activities(thread_id, kind)
  `;
});
