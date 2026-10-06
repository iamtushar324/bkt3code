// T3-CUSTOM(expbkt3): member self-service marker on pairing links.
//
// Runs against the live expbkt3 database on deploy, where `auth_pairing_links`
// already holds rows. Those must come out administrator-minted, so the sessions
// they produce keep the 30-day life they have today.
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
// T3-CUSTOM(expbkt3): upstream moved the node SQLite client to shared.
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" })));

layer("1015_AuthPairingSelfIssued", (it) => {
  it.effect("adds the column with existing links defaulted to administrator-minted", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 1014 });
      yield* sql`
        INSERT INTO auth_pairing_links (
          id, credential, method, scopes, subject, label,
          proof_key_thumbprint, requires_proof_of_possession,
          created_at, expires_at, consumed_at, revoked_at
        ) VALUES (
          'link-1', 'CREDENTIAL01', 'one-time-token', '["orchestration:read"]',
          'clerk:user_1', 'Existing link', NULL, 0,
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:05:00.000Z', NULL, NULL
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 1015 });

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(auth_pairing_links)
      `;
      assert.ok(new Set(columns.map((column) => column.name)).has("self_issued"));

      const rows = yield* sql<{ readonly self_issued: number }>`
        SELECT self_issued FROM auth_pairing_links WHERE id = 'link-1'
      `;
      assert.strictEqual(rows[0]?.self_issued, 0);
    }),
  );

  it.effect("is idempotent, so a re-run on a migrated database is a no-op", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 1015 });
      yield* runMigrations({ toMigrationInclusive: 1015 });

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(auth_pairing_links)
      `;
      assert.strictEqual(columns.filter((column) => column.name === "self_issued").length, 1);
    }),
  );
});
