/**
 * T3-CUSTOM(expbkt3): the only event property keys bkt3 sends to PostHog.
 *
 * Events now carry a person's email as `distinct_id`, so a property must never
 * hold free text a person or an agent wrote: titles, prompts, messages, paths,
 * branches, repository names, answers, questions or error messages. Add a key
 * here only when its values are ids, enums, numbers or booleans. Error detail
 * goes in as a class or tag name (`errorClass`, `failureClass`), never a message.
 *
 * `AnalyticsService.record` drops every other key and logs each dropped key
 * once per process.
 */

const UPSTREAM_KEYS = [
  // server.boot.heartbeat
  "threadCount",
  "projectCount",
  // client.connected, client.thread.started, client.turn.requested
  "surface",
  "appVersion",
  "clientAppVersion",
  "clientOs",
  "os",
  "clientDeviceType",
  "webDeployment",
  "clientBrowser",
  "osMajorVersion",
  "clientOsMajorVersion",
  "deviceModel",
  "clientDeviceModel",
  "connectionMethod",
  // provider.turn.completed
  "terminalStatus",
  "usageStatus",
  "usageScope",
  "hasSubagents",
  "inputTokens",
  "cachedInputTokens",
  "cacheCreationTokens",
  "outputTokens",
  "reasoningTokens",
  "mixedModels",
  // chatgpt.auth.*, chatgpt.transfer.*
  "flow",
  "intent",
  "callbackMode",
  "outcome",
  "failureStage",
  "accountCountScope",
  "connectedAccountCount",
  "connectedConnectionCount",
  "savedConnectionCount",
  "unidentifiedConnectedConnectionCount",
] as const;

/** Session activity and run metrics (TEC-1631 worker 2). */
const SESSION_ACTIVITY_KEYS = [
  "threadId",
  "projectId",
  "parentThreadId",
  "isChildSession",
  "state",
  "waitKind",
  "durationMs",
  "startedAt",
  "endedAt",
  "endReason",
  "runId",
  "runOrdinal",
  "provider",
  "providerInstanceId",
  "model",
  "effort",
  "interactionMode",
  "runtimeMode",
  "activeWorkers",
  "maxActiveWorkers",
  "ownerUserId",
  "senderUserId",
  "sessionSource",
  "resumedAfterRestart",
  "backfill",
  "ageMs",
  "status",
  "queueWaitMs",
  "runDurationMs",
  "workDurationMs",
  "attempts",
  "failureClass",
  "requestKind",
  "waitMs",
  "resolution",
  "answeredByUserId",
  "subagentId",
  "driver",
  "childThreadPresent",
  "decision",
  "count",
  "runningRuns",
  "queuedRuns",
  "waitingHuman",
  "waitingWorkers",
  "activeSubagents",
  "snoozed",
  "spanStartedAt",
  "segmentIndex",
  "runTrigger",
  "backgroundTasks",
  "createdBy",
  "origin",
  "scope",
] as const;

/** Server events outside the orchestration stream (TEC-1631 worker 1). */
const SERVER_EVENT_KEYS = [
  "instance",
  "actorKind",
  "connectionMode",
  // mcp.tool.called
  "toolName",
  "callerKind",
  "ok",
  "errorClass",
  // scheduled_task.ran
  "taskId",
  "scheduleType",
  "trigger",
  "creationSource",
  // webhook.delivered
  "kind",
  // session.recovery.*
  "terminalizedRuns",
  "stoppedSessions",
  "closedRequests",
  "retiredEffects",
  "requeuedEffects",
  // install.owner_observed (upstream); ownerId is a hash.
  "ownerSource",
  "ownerId",
  "observedBy",
] as const;

export const ALLOWED_ANALYTICS_PROPERTY_KEYS: ReadonlySet<string> = new Set<string>([
  ...UPSTREAM_KEYS,
  ...SESSION_ACTIVITY_KEYS,
  ...SERVER_EVENT_KEYS,
]);

/**
 * Keys that must never be allowed, whatever someone adds above. Checked by the
 * tests so a free-text key cannot slip in by accident.
 */
export const FORBIDDEN_ANALYTICS_PROPERTY_KEYS: ReadonlyArray<string> = [
  "title",
  "prompt",
  "message",
  "text",
  "path",
  "cwd",
  "branch",
  "repo",
  "answer",
  "question",
  "error",
  "errorMessage",
];

/** Splits `properties` into the allowed ones and the names of the dropped keys. */
export function filterAnalyticsProperties(
  properties: Readonly<Record<string, unknown>> | undefined,
): {
  readonly kept: Readonly<Record<string, unknown>> | undefined;
  readonly dropped: ReadonlyArray<string>;
} {
  if (properties === undefined) return { kept: undefined, dropped: [] };
  const kept: Record<string, unknown> = {};
  const dropped: Array<string> = [];
  for (const [key, value] of Object.entries(properties)) {
    if (ALLOWED_ANALYTICS_PROPERTY_KEYS.has(key)) {
      kept[key] = value;
    } else {
      dropped.push(key);
    }
  }
  return { kept, dropped };
}
