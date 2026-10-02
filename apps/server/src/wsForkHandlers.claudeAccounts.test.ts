/**
 * T3-CUSTOM(expbkt3): the admin gate on Claude account access RPCs, and the
 * per-connection identity the account handlers hand the service.
 */
import { ClaudeAccountsError, ThreadId, UserId, WS_FORK_METHODS } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import type * as ClaudeAccountsService from "./claudeAccounts/ClaudeAccountsService.ts";
import { makeForkWsHandlers, type ForkWsHandlerDeps } from "./wsForkHandlers.ts";

const member = UserId.make("user-member");
const outsider = UserId.make("user-outsider");

function makeHandlers(
  actorUserId: UserId | null,
  actorIsAdmin: boolean,
  directory: ReadonlyArray<UserId> | null = [member],
) {
  const calls: Array<{ readonly method: string; readonly input: unknown }> = [];
  const entries = { entries: [{ profile: "agent", userIds: [member] }] };
  const claudeAccounts = {
    listAccess: () =>
      Effect.sync(() => {
        calls.push({ method: "listAccess", input: undefined });
        return entries;
      }),
    setAccess: (input: unknown) =>
      Effect.sync(() => {
        calls.push({ method: "setAccess", input });
        return entries;
      }),
    setThreadMode: (input: unknown) =>
      Effect.sync(() => {
        calls.push({ method: "setThreadMode", input });
        return { threadId: ThreadId.make("thread-1"), mode: { kind: "auto" } } as const;
      }),
    watchSnapshot: (viewer: unknown) => {
      calls.push({ method: "watchSnapshot", input: viewer });
      return Stream.empty;
    },
  } as unknown as ClaudeAccountsService.ClaudeAccountsServiceShape;

  const deps = {
    actorUserId,
    actorIsAdmin,
    claudeAccounts,
    // `null` is local mode: no Clerk directory.
    clerkDirectory: {
      enabled: directory !== null,
      listOrgMembers: () =>
        Effect.succeed(
          (directory ?? []).map((id) => ({
            id,
            name: null,
            email: null,
            imageUrl: null,
            isAdmin: false,
          })),
        ),
    },
    observeRpcEffect: (_method, effect) => effect,
    observeRpcStream: (_method, stream) => stream,
    projectionSnapshotQuery: {
      getThreadShellById: () => Effect.succeedNone,
    } as unknown as ForkWsHandlerDeps["projectionSnapshotQuery"],
  } satisfies Partial<ForkWsHandlerDeps>;
  return { handlers: makeForkWsHandlers(deps as unknown as ForkWsHandlerDeps), calls };
}

describe("Claude account access websocket handlers", () => {
  it.effect("refuses a non-admin as forbidden without touching the service", () =>
    Effect.gen(function* () {
      const { handlers, calls } = makeHandlers(member, false);
      const list = yield* handlers[WS_FORK_METHODS.claudeAccountsAccessList]().pipe(Effect.flip);
      const set = yield* handlers[WS_FORK_METHODS.claudeAccountsAccessSet]({
        profile: "agent",
        userIds: [member],
      }).pipe(Effect.flip);
      for (const error of [list, set]) {
        expect(error).toBeInstanceOf(ClaudeAccountsError);
        expect(error._tag === "ClaudeAccountsError" ? error.reason : error._tag).toBe("forbidden");
      }
      expect(calls).toEqual([]);
    }),
  );

  it.effect("lets an admin manage access, stamped with their id", () =>
    Effect.gen(function* () {
      const { handlers, calls } = makeHandlers(member, true);
      yield* handlers[WS_FORK_METHODS.claudeAccountsAccessList]();
      yield* handlers[WS_FORK_METHODS.claudeAccountsAccessSet]({
        profile: "agent",
        userIds: [member],
      });
      expect(calls).toEqual([
        { method: "listAccess", input: undefined },
        {
          method: "setAccess",
          input: { profile: "agent", userIds: [member], actorUserId: member },
        },
      ]);
    }),
  );

  it.effect("refuses to assign someone outside the workspace directory", () =>
    Effect.gen(function* () {
      const { handlers, calls } = makeHandlers(member, true);
      const error = yield* handlers[WS_FORK_METHODS.claudeAccountsAccessSet]({
        profile: "agent",
        userIds: [member, outsider],
      }).pipe(Effect.flip);
      expect(error._tag === "ClaudeAccountsError" ? error.reason : error._tag).toBe("invalid");
      expect(error.message).toContain("user-outsider");
      expect(calls).toEqual([]);
    }),
  );

  it.effect("skips the directory check in local mode", () =>
    Effect.gen(function* () {
      const { handlers, calls } = makeHandlers(null, false, null);
      yield* handlers[WS_FORK_METHODS.claudeAccountsAccessSet]({
        profile: "agent",
        userIds: [outsider],
      });
      expect(calls.map((call) => call.method)).toEqual(["setAccess"]);
    }),
  );

  it.effect("leaves the local operator unrestricted", () =>
    Effect.gen(function* () {
      const { handlers, calls } = makeHandlers(null, false);
      yield* handlers[WS_FORK_METHODS.claudeAccountsAccessSet]({ profile: "agent", userIds: [] });
      expect(calls.map((call) => call.method)).toEqual(["setAccess"]);
    }),
  );

  it.effect("hands the connection's user to the snapshot and mode change", () =>
    Effect.gen(function* () {
      const { handlers, calls } = makeHandlers(member, false);
      yield* Stream.runDrain(handlers[WS_FORK_METHODS.subscribeClaudeAccounts]());
      yield* handlers[WS_FORK_METHODS.claudeAccountsSetThreadMode]({
        threadId: ThreadId.make("draft-1"),
        mode: { kind: "profile", profile: "agent" },
      });
      expect(calls).toEqual([
        { method: "watchSnapshot", input: { userId: member, isAdmin: false } },
        {
          method: "setThreadMode",
          input: {
            threadId: ThreadId.make("draft-1"),
            mode: { kind: "profile", profile: "agent" },
            actorUserId: member,
          },
        },
      ]);
    }),
  );
});
