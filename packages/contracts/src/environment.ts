import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  EnvironmentId,
  ForwardCompatibleOptional,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

export const ORCHESTRATION_PROTOCOL_VERSION = 2;
export const ORCHESTRATION_PROTOCOL_VERSION_TEXT = "2";
export const ORCHESTRATION_PROTOCOL_QUERY_PARAM = "orchestrationProtocol";
export const ORCHESTRATION_PROTOCOL_HEADER = "x-t3-orchestration-protocol";

export const ExecutionEnvironmentPlatformOs = Schema.Literals([
  "darwin",
  "linux",
  "windows",
  "unknown",
]);
export type ExecutionEnvironmentPlatformOs = typeof ExecutionEnvironmentPlatformOs.Type;

export const ExecutionEnvironmentPlatformArch = Schema.Literals(["arm64", "x64", "other"]);
export type ExecutionEnvironmentPlatformArch = typeof ExecutionEnvironmentPlatformArch.Type;

export const ENVIRONMENT_MACHINE_KINDS = [
  "server",
  "cloud",
  "linux",
  "desktop",
  "laptop",
  "mac-mini",
  "mac-studio",
] as const;
export const EnvironmentMachineKind = Schema.Literals(ENVIRONMENT_MACHINE_KINDS);
export type EnvironmentMachineKind = typeof EnvironmentMachineKind.Type;
export const isEnvironmentMachineKind = Schema.is(EnvironmentMachineKind);

export const ExecutionEnvironmentPlatform = Schema.Struct({
  os: ExecutionEnvironmentPlatformOs,
  arch: ExecutionEnvironmentPlatformArch,
  machine: ForwardCompatibleOptional(EnvironmentMachineKind),
});

/**
 * Lives here (not settings.ts) so orchestration contracts can reference it
 * without an import cycle.
 */
export const ThreadEnvMode = Schema.Literals(["local", "worktree"]);
export type ThreadEnvMode = typeof ThreadEnvMode.Type;

export const WorktreeSubmodules = Schema.Literals(["recursive", "top-level", "none"]);
export type WorktreeSubmodules = typeof WorktreeSubmodules.Type;
export type ExecutionEnvironmentPlatform = typeof ExecutionEnvironmentPlatform.Type;

export const ServerSelfUpdateMethod = Schema.Literals(["boot-service", "respawn", "desktop-app"]);
export type ServerSelfUpdateMethod = typeof ServerSelfUpdateMethod.Type;

export const ServerInstallation = Schema.Union([
  Schema.Struct({ kind: Schema.Literals(["npx", "pnpm-dlx", "bunx"]) }),
  Schema.Struct({ kind: Schema.Literal("npm-global"), prefix: TrimmedNonEmptyString }),
]);
export type ServerInstallation = typeof ServerInstallation.Type;

export const ServerSelfUpdateCapability = Schema.Literals([
  "boot-service",
  "respawn",
  "desktop-managed",
]);
export type ServerSelfUpdateCapability = typeof ServerSelfUpdateCapability.Type;

export const ExecutionEnvironmentCapabilities = Schema.Struct({
  repositoryIdentity: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  connectionProbe: Schema.optionalKey(Schema.Boolean),
  attachmentUploads: Schema.optionalKey(Schema.Boolean),
  questionAttachments: Schema.optionalKey(Schema.Boolean),
  fileAttachments: Schema.optionalKey(
    Schema.Struct({
      maxUploadBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
    }),
  ),
  pullRequests: Schema.optionalKey(Schema.Boolean),
  pullRequestChecks: Schema.optionalKey(Schema.Boolean),
  /** Absent on servers from before inline context shipped, which drop the records and forward
      the links as literal text -- so a client must serialize context the legacy way for them. */
  inlineMessageContext: Schema.optionalKey(Schema.Boolean),
  requiredWorktreeBootstrap: Schema.optionalKey(Schema.Boolean),
  threadSettlement: Schema.optionalKey(Schema.Boolean),
  threadAutoSettlement: Schema.optionalKey(Schema.Boolean),
  storageCleanup: Schema.optionalKey(Schema.Boolean),
  storageCleanupRun: Schema.optionalKey(Schema.Boolean),
  /** Server streams database size and reclaimable space for the Storage settings notice. */
  databaseStorage: Schema.optionalKey(Schema.Boolean),
  /** Server checks OTLP endpoints for the telemetry export settings. */
  otlpEndpointCheck: Schema.optionalKey(Schema.Boolean),
  projectWorktreeCleanup: Schema.optionalKey(Schema.Boolean),
  settledWorktreeCleanup: Schema.optionalKey(Schema.Boolean),
  worktreesDirectory: Schema.optionalKey(Schema.Boolean),
  threadAutoSettlementScope: Schema.optionalKey(Schema.Boolean),
  threadRestartContinuation: Schema.optionalKey(Schema.Boolean),
  projectSettingsOverrides: Schema.optionalKey(Schema.Boolean),
  /**
   * Older
      servers decode the key away (unknown fields are stripped, not
      rejected), so the per-project provider switch would silently do
      nothing; clients hide it instead of sending a patch that goes nowhere.
   */
  projectProviderInstanceOverrides: Schema.optionalKey(Schema.Boolean),
  threadSnooze: Schema.optionalKey(Schema.Boolean),
  /** Absent on servers from
      before environment themes shipped, which never emit the events -- so a
      client reconnecting to one must drop published themes rather than keep
      showing a set nothing will ever update. */
  environmentThemes: Schema.optionalKey(Schema.Boolean),
  usageLimitSources: Schema.optionalKey(Schema.Boolean),
  usagePriceOverrides: Schema.optionalKey(Schema.Boolean),
  usageModelAliases: Schema.optionalKey(Schema.Boolean),
  threadPinning: Schema.optionalKey(Schema.Boolean),
  threadPinReorder: Schema.optionalKey(Schema.Boolean),
  threadActiveReorder: Schema.optionalKey(Schema.Boolean),
  threadAutoSettleOptOut: Schema.optionalKey(Schema.Boolean),
  threadTitleRegeneration: Schema.optionalKey(Schema.Boolean),
  /** T3-CUSTOM(expbkt3): server answers threadUsage.get (per-thread API cost). */
  threadUsage: Schema.optionalKey(Schema.Boolean),
  /** T3-CUSTOM(expbkt3): server understands priority on thread.create and
      thread.meta.update. Same version-skew contract as threadSnooze. */
  threadPriority: Schema.optionalKey(Schema.Boolean),
  // T3-CUSTOM(expbkt3): server understands customGroup on thread.create and
  // thread.meta.update. Same version-skew contract as threadPriority.
  threadCustomGroup: Schema.optionalKey(Schema.Boolean),
  // T3-CUSTOM(expbkt3): server keeps the shared custom-group registry (names
  // and colours) in `threadCustomGroups` server settings, merged per entry.
  threadCustomGroupRegistry: Schema.optionalKey(Schema.Boolean),
  /** T3-CUSTOM(expbkt3): durable manual Linear tags on thread metadata. */
  threadLinearIssue: Schema.optionalKey(Schema.Boolean),
  /** T3-CUSTOM(expbkt3): several Linear tags per thread — `linearLinks` on thread
      metadata, `linearLinksAdd`/`linearLinksRemove` on thread.meta.update. Absent
      on older servers, which silently ignore those fields. */
  threadLinearLinks: Schema.optionalKey(Schema.Boolean),
  /** T3-CUSTOM(expbkt3): durable Mattermost conversation link on thread metadata. */
  threadMattermostLink: Schema.optionalKey(Schema.Boolean),
  /** T3-CUSTOM(expbkt3): server exposes the native plan-review document API
      (planReview.* and subscribePlanReview). Absent on upstream servers and on
      fork servers from before it shipped, so clients hide the plan-review
      surface entirely rather than probing for it. */
  planReview: Schema.optionalKey(Schema.Boolean),
  /** T3-CUSTOM(expbkt3): server exposes review comments on agent messages
      (threadComments.* and subscribeThreadComments). Same contract as planReview. */
  threadComments: Schema.optionalKey(Schema.Boolean),
  /** T3-CUSTOM(expbkt3): server answers the `t3_user_presence` MCP tool and
      `GET /api/presence`, and clients report the open thread as a background scope. */
  userPresence: Schema.optionalKey(Schema.Boolean),
  threadVisitedTracking: Schema.optionalKey(Schema.Boolean),
  threadPullRequestLinking: Schema.optionalKey(Schema.Boolean),
  serverResolvedCommandContext: Schema.optionalKey(Schema.Boolean),
  threadPullRequests: Schema.optionalKey(Schema.Boolean),
  threadPullRequestWatch: Schema.optionalKey(Schema.Boolean),
  pullRequestStackActions: Schema.optionalKey(Schema.Boolean),
  serverSelfUpdate: Schema.optionalKey(ServerSelfUpdateCapability),
  /** Manual commands must update this install, not the host's default global prefix. */
  serverInstallation: ForwardCompatibleOptional(ServerInstallation),
  serverSelfUpdateProgress: Schema.optionalKey(Schema.Boolean),
  serverUpdateThreadContinuation: Schema.optionalKey(Schema.Boolean),
  /**
   * Clients skip seeding a Live Activity when
      this is false — no update would ever repaint it. Absent on older
      servers, which may still publish, so only an explicit false skips.
   */
  agentActivityPublishing: Schema.optionalKey(Schema.Boolean),
  projectCloneTracking: Schema.optionalKey(Schema.Boolean),
  environmentIcon: Schema.optionalKey(Schema.Boolean),
  // T3-CUSTOM(expbkt3): server persists the shared `environmentAppearance`
  // setting (nickname, icon, colour). Absent on servers that would drop it.
  environmentAppearance: Schema.optionalKey(Schema.Boolean),
  desktopAppUpdate: Schema.optionalKey(Schema.Boolean),
  /** Server answers orchestration.subscribeCommandOutput. Absent on older servers,
      which never send command output, so clients must not subscribe. */
  commandOutputStreaming: Schema.optionalKey(Schema.Boolean),
  /** Server hosts preview tabs in its own headless Chromium (`runtime:
      "server"`) and streams them over `/api/preview-stream`. Clients
      without a local browser runtime open server tabs here. */
  serverBrowser: Schema.optionalKey(Schema.Boolean),
});
export type ExecutionEnvironmentCapabilities = typeof ExecutionEnvironmentCapabilities.Type;

// T3-CUSTOM(expbkt3): BEGIN — product analytics config for the client (TEC-1631).
/**
 * Where a client sends its product analytics for this environment. Present
 * only when the server has an explicit PostHog project key and telemetry is
 * on, so the client bundle never carries a key of its own. `posthogKey` is a
 * public write-only `phc_` key.
 */
export const ExecutionEnvironmentAnalytics = Schema.Struct({
  enabled: Schema.Boolean,
  posthogKey: TrimmedNonEmptyString,
  posthogHost: TrimmedNonEmptyString,
  /** Which deployment the events come from, such as `bkt3` or `expbkt3`. */
  instance: Schema.optionalKey(TrimmedNonEmptyString),
});
export type ExecutionEnvironmentAnalytics = typeof ExecutionEnvironmentAnalytics.Type;
// T3-CUSTOM(expbkt3): END

export const ExecutionEnvironmentDescriptor = Schema.Struct({
  environmentId: EnvironmentId,
  label: TrimmedNonEmptyString,
  platform: ExecutionEnvironmentPlatform,
  serverVersion: TrimmedNonEmptyString,
  orchestrationProtocolVersion: Schema.optionalKey(Schema.Int),
  capabilities: ExecutionEnvironmentCapabilities,
  // T3-CUSTOM(expbkt3): absent on servers without product analytics (TEC-1631).
  analytics: Schema.optionalKey(ExecutionEnvironmentAnalytics),
});
export type ExecutionEnvironmentDescriptor = typeof ExecutionEnvironmentDescriptor.Type;

export const RepositoryIdentityLocator = Schema.Struct({
  source: Schema.Literal("git-remote"),
  remoteName: TrimmedNonEmptyString,
  remoteUrl: TrimmedNonEmptyString,
});
export type RepositoryIdentityLocator = typeof RepositoryIdentityLocator.Type;

export const RepositoryOrigin = Schema.Struct({
  canonicalKey: TrimmedNonEmptyString,
  displayName: Schema.optionalKey(TrimmedNonEmptyString),
});
export type RepositoryOrigin = typeof RepositoryOrigin.Type;

export const RepositoryIdentity = Schema.Struct({
  canonicalKey: TrimmedNonEmptyString,
  locator: RepositoryIdentityLocator,
  webUrl: Schema.optionalKey(TrimmedNonEmptyString),
  rootPath: Schema.optionalKey(TrimmedNonEmptyString),
  displayName: Schema.optionalKey(TrimmedNonEmptyString),
  provider: Schema.optionalKey(TrimmedNonEmptyString),
  owner: Schema.optionalKey(TrimmedNonEmptyString),
  name: Schema.optionalKey(TrimmedNonEmptyString),
  origin: Schema.optionalKey(RepositoryOrigin),
});
export type RepositoryIdentity = typeof RepositoryIdentity.Type;

export function repositoryGroupingKeyOf(identity: RepositoryIdentity): string {
  return identity.origin?.canonicalKey ?? identity.canonicalKey;
}

export function repositoryGroupingDisplayNameOf(identity: RepositoryIdentity): string | undefined {
  return identity.origin
    ? (identity.origin.displayName ?? identity.origin.canonicalKey)
    : identity.displayName;
}

export const ScopedProjectRef = Schema.Struct({
  environmentId: EnvironmentId,
  projectId: ProjectId,
});
export type ScopedProjectRef = typeof ScopedProjectRef.Type;

export const ScopedThreadRef = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
});
export type ScopedThreadRef = typeof ScopedThreadRef.Type;
