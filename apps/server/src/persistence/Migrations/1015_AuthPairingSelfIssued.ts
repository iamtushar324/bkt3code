// T3-CUSTOM(expbkt3): pairing links minted by a member for their own devices.
//
// A member self-service link differs from an operator-minted one in two ways that
// have to survive a restart: it counts against that member's device cap, and the
// session it produces gets a shorter (7-day) life than the 30-day default. The
// subject alone cannot carry that — since the operator-identity change every
// UI-minted link already has a `clerk:<userId>` subject — so it is recorded here.
//
// Forward-only and additive: every existing row reads as 0 and keeps producing
// ordinary 30-day sessions.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(auth_pairing_links)
  `;

  if (!columns.some((column) => column.name === "self_issued")) {
    yield* sql`
      ALTER TABLE auth_pairing_links
      ADD COLUMN self_issued INTEGER NOT NULL DEFAULT 0
    `;
  }
});
