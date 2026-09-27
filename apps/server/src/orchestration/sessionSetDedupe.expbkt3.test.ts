import { type OrchestrationSession, ThreadId, TurnId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { it as effectIt } from "@effect/vitest";
import { describe, expect, it } from "vite-plus/test";

import { dispatchSessionSetUnlessNoOp, isNoOpSessionSet } from "./sessionSetDedupe.expbkt3.ts";

const base: OrchestrationSession = {
  threadId: ThreadId.make("thread-1"),
  status: "running",
  providerName: "claudeAgent",
  providerThreadId: "claude-session-1",
  runtimeMode: "full-access",
  activeTurnId: TurnId.make("turn-1"),
  lastError: null,
  updatedAt: "2026-09-26T08:00:00.000Z",
};

describe("isNoOpSessionSet", () => {
  it("treats a session that only differs in updatedAt as a no-op", () => {
    expect(isNoOpSessionSet(base, { ...base, updatedAt: "2026-09-26T08:00:05.000Z" })).toBe(true);
  });

  it("treats a missing and a null provider thread id as equal", () => {
    const { providerThreadId: _, ...withoutProviderThreadId } = base;
    expect(isNoOpSessionSet({ ...base, providerThreadId: null }, withoutProviderThreadId)).toBe(
      true,
    );
  });

  it("never drops the first session for a thread", () => {
    expect(isNoOpSessionSet(null, base)).toBe(false);
    expect(isNoOpSessionSet(undefined, base)).toBe(false);
  });

  it.each([
    ["status", { status: "ready" }],
    ["activeTurnId", { activeTurnId: null }],
    ["lastError", { lastError: "boom" }],
    ["providerThreadId", { providerThreadId: "claude-session-2" }],
    ["runtimeMode", { runtimeMode: "approval-required" }],
    ["providerName", { providerName: "codex" }],
    ["providerInstanceId", { providerInstanceId: "claude-work" }],
  ] as const)("keeps a change to %s", (_field, change) => {
    expect(isNoOpSessionSet(base, { ...base, ...change } as OrchestrationSession)).toBe(false);
  });
});

describe("dispatchSessionSetUnlessNoOp", () => {
  const command = {
    type: "thread.session.set" as const,
    commandId: "cmd-1" as never,
    threadId: base.threadId,
    session: { ...base, updatedAt: "2026-09-26T08:00:05.000Z" },
    createdAt: "2026-09-26T08:00:05.000Z",
  };

  const run = (eventType: string, current: OrchestrationSession | null) =>
    Effect.gen(function* () {
      const dispatched: string[] = [];
      yield* dispatchSessionSetUnlessNoOp(
        { dispatch: (next) => Effect.sync(() => dispatched.push(next.commandId)) },
        eventType,
        current,
      )(command);
      return dispatched;
    });

  effectIt.effect("drops a status ping that changes nothing", () =>
    Effect.map(run("session.state.changed", base), (dispatched) => expect(dispatched).toEqual([])),
  );

  effectIt.effect("always dispatches lifecycle events, even when unchanged", () =>
    Effect.gen(function* () {
      expect(yield* run("turn.started", base)).toEqual(["cmd-1"]);
      expect(yield* run("session.started", base)).toEqual(["cmd-1"]);
    }),
  );
});
