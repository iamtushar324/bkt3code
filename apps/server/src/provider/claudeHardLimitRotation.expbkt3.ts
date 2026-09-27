/**
 * T3-CUSTOM(expbkt3): rotate Claude after an authoritative usage rejection.
 *
 * The provider event retains Claude's typed rate-limit message in `raw`. This
 * listener delegates the machine-global election to the host-owned autoswitch
 * command and stops only the emitting thread after a validated switched result.
 * It never reads, copies, logs, or moves account credentials.
 */
import type { ProviderRuntimeEvent, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { collectUint8StreamText } from "../stream/collectUint8StreamText.ts";
import * as ProviderService from "./Services/ProviderService.ts";

const CLAUDE_AUTOSWITCH_COMMAND = "/home/ubuntu/.local/bin/claude-autoswitch";
const CLAUDE_AUTOSWITCH_TIMEOUT = "10 seconds";
const MAX_AUTOSWITCH_OUTPUT_BYTES = 4_096;
const MAX_HANDLED_CONDITIONS = 128;

const ClaudeRateLimitType = Schema.Literals([
  "five_hour",
  "seven_day",
  "seven_day_opus",
  "seven_day_sonnet",
  "overage",
]);
export type ClaudeRateLimitType = typeof ClaudeRateLimitType.Type;

const ClaudeRateLimitMessage = Schema.Struct({
  type: Schema.Literal("rate_limit_event"),
  rate_limit_info: Schema.Struct({
    status: Schema.Literals(["allowed", "allowed_warning", "rejected"]),
    rateLimitType: Schema.optional(ClaudeRateLimitType),
    resetsAt: Schema.optional(Schema.Number),
    overageResetsAt: Schema.optional(Schema.Number),
  }),
});
const decodeClaudeRateLimitMessage = Schema.decodeUnknownOption(ClaudeRateLimitMessage);

const ClaudeAutoswitchHostResult = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("switched"),
    hardLimitType: ClaudeRateLimitType,
    from: Schema.String,
    to: Schema.String,
    reason: Schema.String,
  }),
  Schema.Struct({
    status: Schema.Literal("no-op"),
    hardLimitType: ClaudeRateLimitType,
    reason: Schema.String,
  }),
  Schema.Struct({
    status: Schema.Literal("failure"),
    hardLimitType: ClaudeRateLimitType,
    reason: Schema.String,
  }),
]);
const decodeClaudeAutoswitchHostResult = Schema.decodeUnknownOption(
  Schema.fromJsonString(ClaudeAutoswitchHostResult),
);

export type ClaudeAutoswitchElectionResult =
  | { readonly status: "switched" }
  | { readonly status: "no-op"; readonly failureKind: "host-no-op" }
  | {
      readonly status: "failure";
      readonly failureKind: "command-error" | "timeout" | "invalid-response" | "nonzero-exit";
    };

interface ClaudeHardLimitCondition {
  readonly key: string;
  readonly rateLimitType: ClaudeRateLimitType;
  readonly threadId: ThreadId;
}

export interface ClaudeHardLimitRotationDependencies {
  readonly requestElection: (
    rateLimitType: ClaudeRateLimitType,
  ) => Effect.Effect<ClaudeAutoswitchElectionResult>;
  readonly recycleSession: (threadId: ThreadId) => Effect.Effect<void>;
}

function hardLimitCondition(event: ProviderRuntimeEvent): ClaudeHardLimitCondition | null {
  if (
    event.provider !== "claudeAgent" ||
    event.type !== "account.rate-limits.updated" ||
    event.raw?.source !== "claude.sdk.message" ||
    event.raw.messageType !== "rate_limit_event"
  ) {
    return null;
  }

  const decoded = decodeClaudeRateLimitMessage(event.raw.payload);
  if (Option.isNone(decoded)) return null;
  const info = decoded.value.rate_limit_info;
  if (info.status !== "rejected" || info.rateLimitType === undefined) return null;

  const resetAt =
    info.rateLimitType === "overage" ? (info.overageResetsAt ?? info.resetsAt) : info.resetsAt;
  return {
    key: `${String(event.providerInstanceId ?? event.provider)}\u0000${info.rateLimitType}\u0000${String(resetAt ?? "unknown")}`,
    rateLimitType: info.rateLimitType,
    threadId: event.threadId,
  };
}

function rememberCondition(handled: Set<string>, key: string): boolean {
  if (handled.has(key)) return false;
  if (handled.size >= MAX_HANDLED_CONDITIONS) {
    const oldest = handled.values().next().value;
    if (oldest !== undefined) handled.delete(oldest);
  }
  handled.add(key);
  return true;
}

export const runClaudeHardLimitRotation = Effect.fn("ClaudeHardLimitRotation.run")(function* (
  events: Stream.Stream<ProviderRuntimeEvent>,
  dependencies: ClaudeHardLimitRotationDependencies,
) {
  const handled = new Set<string>();

  yield* events.pipe(
    Stream.runForEach((event) => {
      const condition = hardLimitCondition(event);
      if (condition === null || !rememberCondition(handled, condition.key)) return Effect.void;

      return dependencies
        .requestElection(condition.rateLimitType)
        .pipe(
          Effect.flatMap((result) =>
            result.status === "switched"
              ? dependencies.recycleSession(condition.threadId)
              : Effect.void,
          ),
        );
    }),
  );
});

export const runClaudeAutoswitchElection = Effect.fn("ClaudeHardLimitRotation.elect")(function* (
  rateLimitType: ClaudeRateLimitType,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const attempt = yield* Effect.gen(function* () {
    const child = yield* spawner.spawn(
      ChildProcess.make(CLAUDE_AUTOSWITCH_COMMAND, ["--hard-limit", rateLimitType, "--json"]),
    );
    yield* Effect.addFinalizer(() => child.kill().pipe(Effect.ignore));
    const [stdout, , exitCode] = yield* Effect.all(
      [
        collectUint8StreamText({
          stream: child.stdout,
          maxBytes: MAX_AUTOSWITCH_OUTPUT_BYTES,
        }),
        collectUint8StreamText({
          stream: child.stderr,
          maxBytes: MAX_AUTOSWITCH_OUTPUT_BYTES,
        }),
        child.exitCode,
      ],
      { concurrency: "unbounded" },
    );
    return { stdout: stdout.text.trim(), exitCode: Number(exitCode) };
  }).pipe(Effect.scoped, Effect.timeoutOption(CLAUDE_AUTOSWITCH_TIMEOUT), Effect.result);

  if (Result.isFailure(attempt)) {
    return { status: "failure", failureKind: "command-error" } as const;
  }
  if (Option.isNone(attempt.success)) {
    return { status: "failure", failureKind: "timeout" } as const;
  }

  const commandResult = attempt.success.value;
  const decoded = decodeClaudeAutoswitchHostResult(commandResult.stdout);
  if (Option.isNone(decoded) || decoded.value.hardLimitType !== rateLimitType) {
    return { status: "failure", failureKind: "invalid-response" } as const;
  }
  if (commandResult.exitCode !== 0) {
    return { status: "failure", failureKind: "nonzero-exit" } as const;
  }
  if (decoded.value.status === "switched") return { status: "switched" } as const;
  if (decoded.value.status === "no-op") {
    return { status: "no-op", failureKind: "host-no-op" } as const;
  }
  return { status: "failure", failureKind: "invalid-response" } as const;
});

function immediateRotationEnabled(): boolean {
  const configured = process.env.T3_CLAUDE_HARD_LIMIT_ROTATION;
  return configured === undefined || !["0", "false", "off"].includes(configured.toLowerCase());
}

const makeLive = Effect.gen(function* () {
  if (!immediateRotationEnabled()) {
    yield* Effect.logInfo("claude hard-limit rotation disabled");
    return;
  }

  const providers = yield* ProviderService.ProviderService;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const requestElection = (rateLimitType: ClaudeRateLimitType) =>
    runClaudeAutoswitchElection(rateLimitType).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.tap((result) =>
        result.status === "switched"
          ? Effect.logInfo("claude hard-limit rotation confirmed profile election", {
              rateLimitType,
            })
          : Effect.logWarning("claude hard-limit rotation left provider session running", {
              rateLimitType,
              electionStatus: result.status,
              failureKind: result.failureKind,
            }),
      ),
    );
  const recycleSession = (threadId: ThreadId) =>
    providers.stopSession({ threadId }).pipe(
      Effect.tap(() =>
        Effect.logInfo("claude hard-limit rotation recycled affected provider session", {
          threadId,
        }),
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("claude hard-limit rotation failed to recycle provider session", {
          threadId,
          cause,
        }),
      ),
    );

  yield* runClaudeHardLimitRotation(providers.streamEvents, {
    requestElection,
    recycleSession,
  }).pipe(Effect.forkScoped);
});

export const layer = Layer.effectDiscard(makeLive);
