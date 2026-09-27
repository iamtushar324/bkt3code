/**
 * T3-CUSTOM(expbkt3): Per-user automation/MCP metadata. Raw integration
 * credentials live in ServerSecretStore; only personal token hashes and
 * non-secret profile metadata are persisted here.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS user_mcp_profiles (
      user_id TEXT PRIMARY KEY,
      profile_json TEXT NOT NULL,
      external_token_hash TEXT,
      external_token_prefix TEXT,
      token_created_at TEXT,
      token_last_used_at TEXT,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_user_mcp_profiles_external_token_hash
    ON user_mcp_profiles(external_token_hash)
    WHERE external_token_hash IS NOT NULL
  `;
});
