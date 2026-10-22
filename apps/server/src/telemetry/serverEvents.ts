/**
 * T3-CUSTOM(expbkt3): bkt3 product events that do not come from the
 * orchestration event stream (TEC-1631).
 *
 * Each helper reads `AnalyticsService` from the caller's context, so a hook
 * point is one line and adds no service requirement. Every helper is best
 * effort: it never fails or delays the work it reports on. Properties are ids,
 * enums, numbers and booleans only; see `analyticsProperties.ts`.
 */
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Result from "effect/Result";

import * as AnalyticsService from "./AnalyticsService.ts";

/** Records `event` when analytics is in context; otherwise does nothing. */
export const recordServerEvent = (
  event: string,
  properties: Readonly<Record<string, unknown>>,
  options?: AnalyticsService.AnalyticsRecordOptions,
): Effect.Effect<void> =>
  Effect.serviceOption(AnalyticsService.AnalyticsService).pipe(
    Effect.flatMap((analytics) =>
      Option.isNone(analytics)
        ? Effect.void
        : analytics.value.record(event, properties, options).pipe(Effect.ignoreCause),
    ),
  );

const userOption = (userId: string | null | undefined) =>
  userId === null || userId === undefined || userId === "" ? undefined : { userId };

/**
 * The tag or class name of a failure, never its message. Tagged errors give
 * their `_tag`; other errors their constructor name; anything else "unknown".
 */
export function errorClassOf(cause: Cause.Cause<unknown>): string {
  if (Cause.hasInterruptsOnly(cause)) return "Interrupted";
  const error = Option.getOrUndefined(Cause.findErrorOption(cause));
  const defect = Cause.findDefect(cause);
  const failure = error ?? (Result.isSuccess(defect) ? defect.success : undefined);
  if (typeof failure === "object" && failure !== null) {
    const tag = (failure as { readonly _tag?: unknown })._tag;
    if (typeof tag === "string" && /^[A-Za-z0-9_.-]{1,80}$/.test(tag)) return tag;
    const name = failure.constructor?.name;
    if (typeof name === "string" && /^[A-Za-z0-9_]{1,80}$/.test(name)) return name;
  }
  return error === undefined ? "Defect" : "unknown";
}

/** Who called a T3 MCP tool. */
export type McpCallerKind = "agent" | "user" | "operator";

/** Maps the MCP invocation principal to the analytics caller kind. */
export function mcpCallerKind(
  principal: "provider-session" | "external-user" | "external-operator",
): McpCallerKind {
  switch (principal) {
    case "provider-session":
      return "agent";
    case "external-user":
      return "user";
    case "external-operator":
      return "operator";
  }
}

export interface McpToolCaller {
  readonly principal: "provider-session" | "external-user" | "external-operator";
  readonly actorUserId: string | null;
}

/**
 * Times one MCP tool call and records `mcp.tool.called` when it ends. Only
 * the tool name is sent, never its arguments or result. `caller` reads the
 * invocation scope, or returns undefined when there is none.
 */
export const withMcpToolAnalytics = Effect.fn("serverEvents.withMcpToolAnalytics")(function* <
  A,
  E,
  R,
>(
  toolName: string,
  caller: Effect.Effect<McpToolCaller | undefined>,
  effect: Effect.Effect<A, E, R>,
): Effect.fn.Return<A, E, R> {
  const startedAt = yield* Clock.currentTimeMillis;
  return yield* effect.pipe(
    Effect.onExit((exit) =>
      Effect.gen(function* () {
        const endedAt = yield* Clock.currentTimeMillis;
        const scope = yield* caller;
        yield* recordServerEvent(
          "mcp.tool.called",
          {
            toolName,
            callerKind: scope === undefined ? "unknown" : mcpCallerKind(scope.principal),
            ok: Exit.isSuccess(exit),
            durationMs: Math.max(0, endedAt - startedAt),
            ...(Exit.isFailure(exit) ? { errorClass: errorClassOf(exit.cause) } : {}),
          },
          userOption(scope?.actorUserId),
        );
      }),
    ),
  );
});

export const recordScheduledTaskRan = (input: {
  readonly taskId: string;
  readonly scheduleType: string;
  readonly trigger: "scheduled" | "manual" | "webhook";
  readonly creationSource: string;
  readonly status: "succeeded" | "failed";
  readonly durationMs: number;
  readonly ownerUserId?: string | null | undefined;
}): Effect.Effect<void> =>
  recordServerEvent(
    "scheduled_task.ran",
    {
      taskId: input.taskId,
      scheduleType: input.scheduleType,
      trigger: input.trigger,
      creationSource: input.creationSource,
      status: input.status,
      durationMs: Math.max(0, input.durationMs),
    },
    userOption(input.ownerUserId),
  );

/**
 * An inbound webhook delivery and how the server answered it. `kind` is
 * "scheduled_task" for `/api/hooks/...` and "session_callback" for
 * `/api/session-webhooks/...`. `status` is an outcome tag, never a body.
 */
export const recordWebhookDelivered = (
  kind: "scheduled_task" | "session_callback",
  status: string,
): Effect.Effect<void> => recordServerEvent("webhook.delivered", { kind, status });

/** The outcome tag for an HTTP status the session-webhook route answered with. */
export function webhookStatusFromHttp(status: number): string {
  return status === 202 ? "accepted" : `http_${status}`;
}

/**
 * Wraps the startup provider-runtime recovery: `session.recovery.attempted`
 * before it runs and `session.recovery.finished` with its outcome and counts
 * after. Recovery runs once per boot, so `attempts` is 1.
 */
export const withSessionRecoveryAnalytics = Effect.fn("serverEvents.withSessionRecoveryAnalytics")(
  function* <A extends object, E, R>(recover: Effect.Effect<A, E, R>): Effect.fn.Return<A, E, R> {
    yield* recordServerEvent("session.recovery.attempted", { trigger: "startup", attempts: 1 });
    const startedAt = yield* Clock.currentTimeMillis;
    return yield* recover.pipe(
      Effect.onExit((exit) =>
        Effect.gen(function* () {
          const endedAt = yield* Clock.currentTimeMillis;
          yield* recordServerEvent("session.recovery.finished", {
            trigger: "startup",
            attempts: 1,
            outcome: Exit.isSuccess(exit) ? "succeeded" : "failed",
            durationMs: Math.max(0, endedAt - startedAt),
            ...(Exit.isSuccess(exit) ? recoveryCounts(exit.value) : {}),
            ...(Exit.isFailure(exit) ? { errorClass: errorClassOf(exit.cause) } : {}),
          });
        }),
      ),
    );
  },
);

const RECOVERY_COUNT_KEYS = [
  "terminalizedRuns",
  "stoppedSessions",
  "closedRequests",
  "retiredEffects",
  "requeuedEffects",
] as const;

function recoveryCounts(summary: object): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const key of RECOVERY_COUNT_KEYS) {
    const value = (summary as Record<string, unknown>)[key];
    if (typeof value === "number") counts[key] = value;
  }
  return counts;
}

/** Linear items newly linked to a session through the T3 MCP tool. */
export const recordLinearLinked = (input: {
  readonly threadId: string;
  readonly count: number;
  readonly userId?: string | null | undefined;
}): Effect.Effect<void> =>
  input.count <= 0
    ? Effect.void
    : recordServerEvent(
        "linear.linked",
        { threadId: input.threadId, count: input.count },
        userOption(input.userId),
      );

export type ClientConnectionMode = "relay" | "local" | "tailnet" | "remote";

const TAILNET_IPV4 = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$/;

/**
 * How a client reached the server: through the relay, from this machine, over
 * the tailnet (a `*.ts.net` name or a 100.64.0.0/10 address), or otherwise.
 * `host` is the request's Host header; only its class is sent, never the host.
 */
export function clientConnectionMode(input: {
  readonly connectionMethod?: unknown;
  readonly host?: string | undefined;
}): ClientConnectionMode {
  if (input.connectionMethod === "relay") return "relay";
  const raw = (input.host ?? "").trim().toLowerCase();
  const hostname = raw.startsWith("[") ? raw.slice(1, raw.indexOf("]")) : raw.split(":")[0];
  if (
    hostname === "localhost" ||
    hostname === "::1" ||
    hostname?.startsWith("127.") === true ||
    hostname?.endsWith(".localhost") === true
  ) {
    return "local";
  }
  if (hostname?.endsWith(".ts.net") === true || TAILNET_IPV4.test(hostname ?? "")) {
    return "tailnet";
  }
  return "remote";
}
