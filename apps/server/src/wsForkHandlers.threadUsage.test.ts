/**
 * T3-CUSTOM(expbkt3): `threadUsage.get` reads only the requested thread.
 *
 * Every open thread view polls this RPC, so it must never read the full shell
 * snapshot: on bkt3 that is ~1,800 threads per call.
 */
import {
  ThreadId,
  WS_METHODS,
  type OrchestrationThreadShell,
  type ThreadUsage,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { makeForkWsHandlers, type ForkWsHandlerDeps } from "./wsForkHandlers.ts";

const threadId = ThreadId.make("thread-usage");

function makeHandlers(
  shell: Option.Option<OrchestrationThreadShell>,
  nativeSessionIds: ReadonlyArray<string> = [],
) {
  const shellReads: Array<ThreadId> = [];
  const sessionIdReads: Array<ThreadId> = [];
  const usageReads: Array<{
    readonly sessionIds: ReadonlyArray<string>;
    readonly sinceMs: number;
  }> = [];
  const deps = {
    observeRpcEffect: (_method, effect) => effect,
    requireThreadAccess: () => Effect.void,
    projectionSnapshotQuery: {
      getShellSnapshot: () => Effect.die("threadUsage.get must not read the full shell"),
      getThreadShellById: (id: ThreadId) =>
        Effect.sync(() => {
          shellReads.push(id);
          return shell;
        }),
      getThreadNativeSessionIds: (id: ThreadId) =>
        Effect.sync(() => {
          sessionIdReads.push(id);
          return nativeSessionIds;
        }),
    } as unknown as ForkWsHandlerDeps["projectionSnapshotQuery"],
    usage: {
      readThreadUsage: (input: {
        readonly sessionIds: ReadonlyArray<string>;
        readonly sinceMs: number;
      }) =>
        Effect.sync(() => {
          usageReads.push({ sessionIds: input.sessionIds, sinceMs: input.sinceMs });
          return {} as ThreadUsage;
        }),
    } as unknown as ForkWsHandlerDeps["usage"],
  } satisfies Partial<ForkWsHandlerDeps>;
  return {
    handlers: makeForkWsHandlers(deps as unknown as ForkWsHandlerDeps),
    shellReads,
    sessionIdReads,
    usageReads,
  };
}

const shellFor = (archivedAt: string | null) =>
  ({
    id: threadId,
    createdAt: "2026-10-21T10:00:00.000Z",
    archivedAt,
    // V2's legacy shell never carries the native session id.
    session: { providerThreadId: null },
  }) as unknown as OrchestrationThreadShell;

describe("threadUsage.get", () => {
  it.effect("reads one thread and passes every native provider session", () =>
    Effect.gen(function* () {
      const { handlers, shellReads, sessionIdReads, usageReads } = makeHandlers(
        Option.some(shellFor(null)),
        ["native-session-1", "native-session-2"],
      );
      yield* handlers[WS_METHODS.threadUsageGet]({ threadId, timeZone: "UTC" });
      expect(shellReads).toEqual([threadId]);
      expect(sessionIdReads).toEqual([threadId]);
      expect(usageReads).toEqual([
        {
          sessionIds: ["native-session-1", "native-session-2"],
          sinceMs: Date.parse("2026-10-21T10:00:00.000Z"),
        },
      ]);
    }),
  );

  it.effect("keeps the empty result for archived and missing threads", () =>
    Effect.gen(function* () {
      for (const shell of [Option.some(shellFor("2026-10-21T11:00:00.000Z")), Option.none()]) {
        const { handlers, sessionIdReads, usageReads } = makeHandlers(shell, ["native-session-1"]);
        yield* handlers[WS_METHODS.threadUsageGet]({ threadId, timeZone: "UTC" });
        expect(sessionIdReads).toEqual([]);
        expect(usageReads).toEqual([{ sessionIds: [], sinceMs: 0 }]);
      }
    }),
  );
});
