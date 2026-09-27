// T3-CUSTOM(expbkt3): proof-of-possession column on pairing links.
//
// This migration runs against the live expbkt3 database on deploy, where
// `auth_pairing_links` already has rows. The property that matters is that those
// rows come out the other side redeemable exactly as before.
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
// T3-CUSTOM(expbkt3): upstream moved the node SQLite client to shared.
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" })));

layer("1014_AuthPairingRequiresProofOfPossession", (it) => {
  it.effect("adds the column with existing pairing links defaulted to not required", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 1013 });
      yield* sql`
        INSERT INTO auth_pairing_links (
          id, credential, method, scopes, subject, label,
          proof_key_thumbprint, created_at, expires_at, consumed_at, revoked_at
        ) VALUES (
          'link-1', 'CREDENTIAL01', 'one-time-token', '["orchestration:read"]',
          'clerk:user_1', 'Existing link', NULL,
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:05:00.000Z', NULL, NULL
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 1014 });

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(auth_pairing_links)
      `;
      assert.ok(new Set(columns.map((column) => column.name)).has("requires_proof_of_possession"));

      // A link minted before this migration is an ordinary link: it must not
      // suddenly demand a DPoP proof from whoever is holding it.
      const rows = yield* sql<{ readonly requires_proof_of_possession: number }>`
        SELECT requires_proof_of_possession FROM auth_pairing_links WHERE id = 'link-1'
      `;
      assert.strictEqual(rows[0]?.requires_proof_of_possession, 0);
    }),
  );

  it.effect("is idempotent, so a re-run on a migrated database is a no-op", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 1014 });
      yield* runMigrations({ toMigrationInclusive: 1014 });

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(auth_pairing_links)
      `;
      assert.strictEqual(
        columns.filter((column) => column.name === "requires_proof_of_possession").length,
        1,
      );
    }),
  );
});
