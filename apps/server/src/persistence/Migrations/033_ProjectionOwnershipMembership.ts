import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

/**
 * Team-mode ownership + membership projection schema.
 *
 * Adds an `owner_user_id` column to the thread/project read-model tables and
 * two join tables tracking tagged members. Membership is a set keyed by
 * (id, user_id); the owner is implicit (creator permanence) and never stored as
 * a member row. All columns are nullable / default-empty so single-user
 * deployments are unaffected — every legacy row simply has a null owner and no
 * member rows, which the access layer treats as "unrestricted".
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE projection_threads
    ADD COLUMN owner_user_id TEXT
  `.pipe(Effect.catch(() => Effect.void));

  yield* sql`
    ALTER TABLE projection_projects
    ADD COLUMN owner_user_id TEXT
  `.pipe(Effect.catch(() => Effect.void));

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_thread_members (
      thread_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      added_by_user_id TEXT,
      added_at TEXT NOT NULL,
      PRIMARY KEY (thread_id, user_id)
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_project_members (
      project_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      added_by_user_id TEXT,
      added_at TEXT NOT NULL,
      PRIMARY KEY (project_id, user_id)
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_members_user
    ON projection_thread_members(user_id)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_project_members_user
    ON projection_project_members(user_id)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_threads_owner
    ON projection_threads(owner_user_id)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_projects_owner
    ON projection_projects(owner_user_id)
  `;
});
