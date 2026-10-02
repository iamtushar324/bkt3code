/**
 * T3-CUSTOM(expbkt3): the per-account allow list behind Claude account access.
 *
 * Pins the replace-the-set semantics: users already listed keep their first
 * stamp, removed users drop out, and an empty list opens the account again.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { UserId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ClaudeAccountProfileAccess from "./ClaudeAccountProfileAccess.ts";
import { ClaudeAccountProfileAccessRepository } from "./ClaudeAccountProfileAccess.ts";
import { SqlitePersistenceMemory } from "./Layers/Sqlite.ts";
import { MigrationsLive } from "./Migrations.ts";

const barsha = UserId.make("user-barsha");
const sam = UserId.make("user-sam");
const tushar = UserId.make("user-tushar");

const layer = Layer.merge(ClaudeAccountProfileAccess.layer, MigrationsLive).pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provide(NodeServices.layer),
);

describe("ClaudeAccountProfileAccessRepository", () => {
  it.effect("replaces one account's users and keeps the first stamp of those it keeps", () =>
    Effect.gen(function* () {
      const repository = yield* ClaudeAccountProfileAccessRepository;
      const sql = yield* SqlClient.SqlClient;
      yield* repository.setUsers({
        profile: "agent",
        userIds: [sam, barsha],
        addedByUserId: tushar,
        addedAt: "2026-10-02T08:00:00.000Z",
      });
      yield* repository.setUsers({
        profile: "tushar",
        userIds: [tushar],
        addedByUserId: null,
        addedAt: "2026-10-02T08:00:00.000Z",
      });
      yield* repository.setUsers({
        profile: "agent",
        userIds: [barsha, tushar, tushar],
        addedByUserId: barsha,
        addedAt: "2026-10-02T09:00:00.000Z",
      });

      expect(yield* repository.listAll()).toEqual([
        { profile: "agent", userIds: [barsha, tushar] },
        { profile: "tushar", userIds: [tushar] },
      ]);
      const stamps = yield* sql<{
        readonly userId: string;
        readonly addedBy: string | null;
        readonly addedAt: string;
      }>`
        SELECT user_id AS "userId", added_by_user_id AS "addedBy", added_at AS "addedAt"
        FROM claude_account_profile_access WHERE profile = 'agent' ORDER BY user_id
      `;
      expect(stamps).toEqual([
        { userId: barsha, addedBy: tushar, addedAt: "2026-10-02T08:00:00.000Z" },
        { userId: tushar, addedBy: barsha, addedAt: "2026-10-02T09:00:00.000Z" },
      ]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("opens an account again when its list is emptied", () =>
    Effect.gen(function* () {
      const repository = yield* ClaudeAccountProfileAccessRepository;
      yield* repository.setUsers({
        profile: "agent",
        userIds: [sam],
        addedByUserId: null,
        addedAt: "2026-10-02T08:00:00.000Z",
      });
      yield* repository.setUsers({
        profile: "agent",
        userIds: [],
        addedByUserId: null,
        addedAt: "2026-10-02T08:00:00.000Z",
      });
      expect(yield* repository.listAll()).toEqual([]);
    }).pipe(Effect.provide(layer)),
  );
});
