// @effect-diagnostics nodeBuiltinImport:off - expected paths are computed independently.
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import {
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ServerSettings,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { ServerSettingsService } from "../serverSettings.ts";
import {
  runClaudeAutoswitchElection,
  runClaudeHardLimitRotation,
  type ClaudeAutoswitchElectionResult,
} from "./claudeHardLimitRotation.expbkt3.ts";

const claude = ProviderDriverKind.make("claudeAgent");
const claudeInstance = ProviderInstanceId.make("claudeAgent");
const affectedThread = ThreadId.make("affected-thread");
const unrelatedThread = ThreadId.make("unrelated-thread");
const encoder = new TextEncoder();

function rateLimitEvent(input: {
  readonly eventId: string;
  readonly threadId: ThreadId;
  readonly status: "allowed" | "allowed_warning" | "rejected";
  readonly rateLimitType?: "five_hour" | "seven_day";
  readonly resetsAt?: number;
}): ProviderRuntimeEvent {
  return {
    type: "account.rate-limits.updated",
    eventId: EventId.make(input.eventId),
    provider: claude,
    providerInstanceId: claudeInstance,
    threadId: input.threadId,
    createdAt: "2026-08-20T13:15:49.000Z",
    payload: {
      limits: { windows: [] },
    },
    raw: {
      source: "claude.sdk.message",
      messageType: "rate_limit_event",
      payload: {
        type: "rate_limit_event",
        session_id: "claude-session",
        uuid: input.eventId,
        rate_limit_info: {
          status: input.status,
          ...(input.rateLimitType ? { rateLimitType: input.rateLimitType } : {}),
          ...(input.resetsAt ? { resetsAt: input.resetsAt } : {}),
        },
      },
    },
  };
}

function commandHandle(input: {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: Effect.Effect<ChildProcessSpawner.ExitCode>;
  readonly code?: number;
}) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: input.exitCode ?? Effect.succeed(ChildProcessSpawner.ExitCode(input.code ?? 0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.make(encoder.encode(input.stdout ?? "")),
    stderr: Stream.make(encoder.encode(input.stderr ?? "")),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

/** The switcher under the home of whoever runs the tests, never a fixed `/home/ubuntu`. */
const DEFAULT_SWITCHER = NodePath.join(NodeOS.homedir(), ".local", "bin", "claude-autoswitch");

function electionLayer(
  input: Parameters<typeof commandHandle>[0],
  expectedCommand: string = DEFAULT_SWITCHER,
) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      assert.isTrue(ChildProcess.isStandardCommand(command));
      if (!ChildProcess.isStandardCommand(command)) return Effect.die("expected standard command");
      assert.equal(command.command, expectedCommand);
      assert.deepEqual(command.args, ["--hard-limit", "five_hour", "--json"]);
      return Effect.succeed(commandHandle(input));
    }),
  );
}

describe("Claude authoritative hard-limit handling", () => {
  it.effect(
    "elects once for repeated hard-limit evidence and recycles only the emitting thread",
    () =>
      Effect.gen(function* () {
        const electionRequests: Array<string> = [];
        const recycledThreads: Array<ThreadId> = [];
        const hardLimit = rateLimitEvent({
          eventId: "hard-limit-1",
          threadId: affectedThread,
          status: "rejected",
          rateLimitType: "five_hour",
          resetsAt: 1_776_725_705,
        });

        yield* runClaudeHardLimitRotation(
          Stream.fromIterable([
            hardLimit,
            { ...hardLimit, eventId: EventId.make("hard-limit-copy") },
            {
              ...hardLimit,
              eventId: EventId.make("hard-limit-other-thread"),
              threadId: unrelatedThread,
            },
          ]),
          {
            requestElection: (rateLimitType) =>
              Effect.sync(() => {
                electionRequests.push(rateLimitType);
                return { status: "switched" } as const;
              }),
            recycleSession: (threadId) =>
              Effect.sync(() => {
                recycledThreads.push(threadId);
              }),
          },
        );

        assert.deepEqual(electionRequests, ["five_hour"]);
        assert.deepEqual(recycledThreads, [affectedThread]);
      }),
  );

  it.effect("ignores warnings, unsupported limit shapes, and unrelated provider errors", () =>
    Effect.gen(function* () {
      let electionRequests = 0;
      const events: ReadonlyArray<ProviderRuntimeEvent> = [
        rateLimitEvent({
          eventId: "warning",
          threadId: affectedThread,
          status: "allowed_warning",
          rateLimitType: "five_hour",
          resetsAt: 1_776_725_705,
        }),
        rateLimitEvent({
          eventId: "missing-type",
          threadId: affectedThread,
          status: "rejected",
        }),
        {
          type: "runtime.error",
          eventId: EventId.make("provider-error"),
          provider: claude,
          providerInstanceId: claudeInstance,
          threadId: affectedThread,
          createdAt: "2026-08-20T13:16:00.000Z",
          payload: { message: "HTTP 429" },
          raw: {
            source: "claude.sdk.message",
            messageType: "error",
            payload: {
              error: "rate_limit",
              quotaLimits: { status: "rejected", rateLimitType: "five_hour" },
            },
          },
        },
      ];

      yield* runClaudeHardLimitRotation(Stream.fromIterable(events), {
        requestElection: () =>
          Effect.sync(() => {
            electionRequests += 1;
            return { status: "switched" } as const;
          }),
        recycleSession: () => Effect.die("non-hard-limit evidence must not recycle a session"),
      });

      assert.equal(electionRequests, 0);
    }),
  );

  it.effect(
    "hands the rejection to per-thread placement when it is on, and skips the global path",
    () =>
      Effect.gen(function* () {
        const handledByHook: Array<{
          threadId: ThreadId;
          rateLimitType: string;
          resetAt: number | undefined;
        }> = [];
        let electionRequests = 0;
        yield* runClaudeHardLimitRotation(
          Stream.make(
            rateLimitEvent({
              eventId: "hook-handled",
              threadId: affectedThread,
              status: "rejected",
              rateLimitType: "five_hour",
              resetsAt: 1_776_725_705,
            }),
          ),
          {
            requestElection: () =>
              Effect.sync(() => {
                electionRequests += 1;
                return { status: "switched" } as const;
              }),
            recycleSession: () => Effect.die("per-thread placement owns the recycle"),
            accounts: () => ({
              handle: (condition) =>
                Effect.sync(() => {
                  handledByHook.push(condition);
                  return true;
                }),
            }),
          },
        );

        assert.deepEqual(handledByHook, [
          { threadId: affectedThread, rateLimitType: "five_hour", resetAt: 1_776_725_705 },
        ]);
        assert.equal(electionRequests, 0);
      }),
  );

  it.effect("keeps today's machine-global path while per-thread placement is off", () =>
    Effect.gen(function* () {
      const electionRequests: Array<string> = [];
      const recycledThreads: Array<ThreadId> = [];
      const hardLimit = rateLimitEvent({
        eventId: "hook-declined",
        threadId: affectedThread,
        status: "rejected",
        rateLimitType: "five_hour",
        resetsAt: 1_776_725_705,
      });
      yield* runClaudeHardLimitRotation(
        Stream.fromIterable([
          hardLimit,
          { ...hardLimit, eventId: EventId.make("hook-declined-copy") },
        ]),
        {
          requestElection: (rateLimitType) =>
            Effect.sync(() => {
              electionRequests.push(rateLimitType);
              return { status: "switched" } as const;
            }),
          recycleSession: (threadId) =>
            Effect.sync(() => {
              recycledThreads.push(threadId);
            }),
          accounts: () => ({ handle: () => Effect.succeed(false) }),
        },
      );

      assert.deepEqual(electionRequests, ["five_hour"]);
      assert.deepEqual(recycledThreads, [affectedThread]);
    }),
  );

  it.effect("leaves the session running for every unconfirmed election outcome", () =>
    Effect.gen(function* () {
      const outcomes: ReadonlyArray<ClaudeAutoswitchElectionResult> = [
        { status: "no-op", failureKind: "host-no-op" },
        { status: "failure", failureKind: "nonzero-exit" },
        { status: "failure", failureKind: "invalid-response" },
        { status: "failure", failureKind: "timeout" },
        { status: "failure", failureKind: "command-error" },
      ];

      for (const [index, outcome] of outcomes.entries()) {
        let recycled = false;
        yield* runClaudeHardLimitRotation(
          Stream.make(
            rateLimitEvent({
              eventId: `unconfirmed-${index}`,
              threadId: affectedThread,
              status: "rejected",
              rateLimitType: "five_hour",
              resetsAt: 1_776_725_705 + index,
            }),
          ),
          {
            requestElection: () => Effect.succeed(outcome),
            recycleSession: () =>
              Effect.sync(() => {
                recycled = true;
              }),
          },
        );
        assert.isFalse(recycled);
      }
    }),
  );
});

describe("claude-autoswitch hard-limit contract", () => {
  it.effect("runs the switcher the settings name, with a leading ~ expanded", () =>
    Effect.gen(function* () {
      const settings = {
        experimental: {
          claudeAccountProfiles: {
            enabled: false,
            autoswitchPath: "~/bin/my-switcher",
            shortLabels: {},
          },
        },
      } as unknown as ServerSettings;
      const result = yield* runClaudeAutoswitchElection("five_hour").pipe(
        Effect.provide(
          Layer.merge(
            electionLayer(
              {
                stdout:
                  '{"status":"switched","hardLimitType":"five_hour","from":"a","to":"b","reason":"r"}',
              },
              NodePath.join(NodeOS.homedir(), "bin", "my-switcher"),
            ),
            Layer.mock(ServerSettingsService)({ getSettings: Effect.succeed(settings) }),
          ),
        ),
      );
      assert.deepEqual(result, { status: "switched" });
    }),
  );

  it.effect("accepts only an exit-zero switched response", () =>
    Effect.gen(function* () {
      const result = yield* runClaudeAutoswitchElection("five_hour").pipe(
        Effect.provide(
          electionLayer({
            stdout:
              '{"status":"switched","hardLimitType":"five_hour","from":"profile-a","to":"profile-b","reason":"authoritative rejection"}',
          }),
        ),
      );

      assert.deepEqual(result, { status: "switched" });
    }),
  );

  it.effect("maps no-op, nonzero, and invalid JSON to unconfirmed outcomes", () =>
    Effect.gen(function* () {
      const noOp = yield* runClaudeAutoswitchElection("five_hour").pipe(
        Effect.provide(
          electionLayer({
            stdout: '{"status":"no-op","hardLimitType":"five_hour","reason":"no eligible profile"}',
          }),
        ),
      );
      const nonzero = yield* runClaudeAutoswitchElection("five_hour").pipe(
        Effect.provide(
          electionLayer({
            code: 1,
            stdout: '{"status":"failure","hardLimitType":"five_hour","reason":"election failed"}',
          }),
        ),
      );
      const invalid = yield* runClaudeAutoswitchElection("five_hour").pipe(
        Effect.provide(electionLayer({ stdout: "not-json" })),
      );

      assert.deepEqual(noOp, { status: "no-op", failureKind: "host-no-op" });
      assert.deepEqual(nonzero, { status: "failure", failureKind: "nonzero-exit" });
      assert.deepEqual(invalid, { status: "failure", failureKind: "invalid-response" });
    }),
  );

  it.effect("times out without confirming a switch", () =>
    Effect.gen(function* () {
      const resultFiber = yield* runClaudeAutoswitchElection("five_hour").pipe(
        Effect.provide(electionLayer({ exitCode: Effect.never })),
        Effect.forkChild,
      );
      yield* TestClock.adjust("10 seconds");
      const result = yield* Fiber.join(resultFiber);

      assert.deepEqual(result, { status: "failure", failureKind: "timeout" });
    }),
  );

  it.effect("maps command startup errors to an unconfirmed outcome", () =>
    Effect.gen(function* () {
      const spawner = ChildProcessSpawner.make(() =>
        Effect.fail(
          PlatformError.systemError({
            _tag: "NotFound",
            module: "ChildProcess",
            method: "spawn",
            description: "autoswitch unavailable",
          }),
        ),
      );
      const result = yield* runClaudeAutoswitchElection("five_hour").pipe(
        Effect.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)),
      );

      assert.deepEqual(result, { status: "failure", failureKind: "command-error" });
    }),
  );
});
