import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS environment_users (
      user_id TEXT PRIMARY KEY,
      display_name TEXT,
      primary_email TEXT,
      avatar_url TEXT,
      role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
      status TEXT NOT NULL CHECK (status IN ('active', 'blocked')),
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_environment_users_status_last_seen
    ON environment_users(status, last_seen_at DESC)
  `;

  const sessionColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(auth_sessions)
  `;
  if (!sessionColumns.some((column) => column.name === "user_id")) {
    yield* sql`
      ALTER TABLE auth_sessions
      ADD COLUMN user_id TEXT
    `;
  }

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_auth_sessions_user_active
    ON auth_sessions(user_id, revoked_at, expires_at, issued_at)
  `;
});
