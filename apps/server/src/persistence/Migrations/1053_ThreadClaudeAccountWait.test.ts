// T3-CUSTOM(expbkt3): the Claude account revive queue columns and the
// repository methods that write and read them.
import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as ThreadClaudeAccountRepo from "../ThreadClaudeAccount.ts";

const columnNames = Effect.flatMap(
  SqlClient.SqlClient,
  (sql) => sql<{ readonly name: string }>`PRAGMA table_info(thread_claude_account)`,
).pipe(Effect.map((columns) => columns.map((column) => column.name)));

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))("1053_ThreadClaudeAccountWait", (it) => {
  it.effect("adds the wait columns once, keeping existing rows as not waiting", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 1052 });
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO thread_claude_account (thread_id, mode_json, resolved_profile, resolved_at, updated_at)
        VALUES ('thread-old', '{"kind":"auto"}', 'sam', '2026-10-16T12:00:00.000Z', '2026-10-16T12:00:00.000Z')
      `;
      yield* runMigrations({ toMigrationInclusive: 1053 });
      yield* runMigrations({ toMigrationInclusive: 1053 });
      const names = yield* columnNames;
      for (const expected of [
        "wait_queued_at",
        "wait_was_active",
        "wait_prefer_profile",
        "wait_not_before",
      ]) {
        assert.strictEqual(names.filter((name) => name === expected).length, 1);
      }

      const repository = yield* ThreadClaudeAccountRepo.make;
      const old = yield* repository.get(ThreadId.make("thread-old"));
      assert.strictEqual(old.resolvedProfile, "sam");
      assert.strictEqual(old.wait, null);
      assert.deepStrictEqual(yield* repository.listWaiting(), []);
    }),
  );

  it.effect("writes, lists and clears a wait without touching the mode or account", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const repository = yield* ThreadClaudeAccountRepo.make;
      const queued = ThreadId.make("thread-queued");
      const later = ThreadId.make("thread-queued-later");
      const draft = ThreadId.make("thread-queued-draft");
      yield* repository.setResolved({
        threadId: queued,
        profile: "sam",
        resolvedAt: "2026-10-16T12:19:02.000Z",
      });
      yield* repository.setWait({
        threadId: later,
        wait: {
          queuedAt: "2026-10-16T12:20:00.000Z",
          wasActive: false,
          preferProfile: null,
          notBefore: null,
        },
      });
      yield* repository.setWait({
        threadId: queued,
        wait: {
          queuedAt: "2026-10-16T12:19:02.000Z",
          wasActive: true,
          preferProfile: "sam",
          notBefore: "2026-10-16T12:21:00.000Z",
        },
      });

      const waiting = yield* repository.listWaiting();
      assert.deepStrictEqual(
        waiting.map((row) => row.threadId),
        [queued, later],
      );
      assert.deepStrictEqual(waiting[0]!.wait, {
        queuedAt: "2026-10-16T12:19:02.000Z",
        wasActive: true,
        preferProfile: "sam",
        notBefore: "2026-10-16T12:21:00.000Z",
      });
      assert.strictEqual(waiting[0]!.resolvedProfile, "sam");
      assert.strictEqual(waiting[1]!.wait?.wasActive, false);

      yield* repository.clearWait(queued);
      // Clearing a thread with no row is a no-op.
      yield* repository.clearWait(draft);
      const cleared = yield* repository.get(queued);
      assert.strictEqual(cleared.wait, null);
      assert.strictEqual(cleared.resolvedProfile, "sam");
      assert.deepStrictEqual(cleared.mode, { kind: "auto" });
      assert.deepStrictEqual(
        (yield* repository.listWaiting()).map((row) => row.threadId),
        [later],
      );
      assert.strictEqual((yield* repository.get(draft)).wait, null);
    }),
  );
});
