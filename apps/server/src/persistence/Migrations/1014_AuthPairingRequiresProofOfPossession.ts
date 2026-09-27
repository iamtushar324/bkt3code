// T3-CUSTOM(expbkt3): pairing links can require proof-of-possession at redemption.
//
// Distinct from `proof_key_thumbprint` (migration 32), which pre-binds a link to a
// key the issuer already knows — the SSH and desktop-bootstrap case. This flag says
// "redeem with *some* valid DPoP proof, and bind the issued token to whatever key
// was presented", which is what an operator minting a credential for a device they
// have never seen needs.
//
// Forward-only and additive: every existing row reads as 0, so every credential
// already in a live database keeps redeeming exactly as it does today.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(auth_pairing_links)
  `;

  if (!columns.some((column) => column.name === "requires_proof_of_possession")) {
    yield* sql`
      ALTER TABLE auth_pairing_links
      ADD COLUMN requires_proof_of_possession INTEGER NOT NULL DEFAULT 0
    `;
  }
});
