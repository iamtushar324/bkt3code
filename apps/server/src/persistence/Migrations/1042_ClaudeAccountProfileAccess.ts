// T3-CUSTOM(expbkt3): Claude account access per user.
//
// One row per (account, user) allowed to use it. An account with no rows is
// open to everyone; once it has rows, only those users may use it. Account
// names are host config directory names, not rows anywhere, so there is no
// foreign key; a removed account's rows are inert.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS claude_account_profile_access (
      profile TEXT NOT NULL,
      user_id TEXT NOT NULL,
      added_by_user_id TEXT,
      added_at TEXT NOT NULL,
      PRIMARY KEY (profile, user_id)
    )
  `;
});
