// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentHttpApi,
  ProviderDriverKind,
  type RepositoryIdentity,
} from "@t3tools/contracts";
import type { RelayManagedEndpointRuntimeConfig } from "@t3tools/contracts/relay";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Random from "effect/Random";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { FetchHttpClient, HttpRouter, HttpServer } from "effect/unstable/http";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import * as BackgroundPolicy from "./background/BackgroundPolicy.ts";
import * as HostPowerMonitor from "./background/HostPowerMonitor.ts";
import * as ServerConfig from "./config.ts";
import {
  otlpTracesProxyRouteLayer,
  assetRouteLayer,
  attachmentUploadRouteLayer,
  serverEnvironmentHttpApiLayer,
  staticAndDevRouteLayer,
  browserApiCorsLayer,
  httpCompressionLayer,
  untracedRequestsLayer,
} from "./http.ts";
import { guardHttpResponseWriteErrors } from "./httpResponseErrorGuard.ts";
import { fixPath } from "./os-jank.ts";
import { websocketRpcRouteLayer } from "./ws.ts";
import * as ExternalLauncher from "./process/externalLauncher.ts";
import * as NodePtyAdapter from "./terminal/NodePtyAdapter.ts";
import { pullRequestHttpApiLayer } from "./pullRequest/http.ts";
import * as PullRequestProviderRegistry from "./pullRequest/PullRequestProviderRegistry.ts";
import * as PullRequestService from "./pullRequest/PullRequestService.ts";
import { layerConfig as SqlitePersistenceLayerLive } from "./persistence/Layers/Sqlite.ts";
import * as PullRequestFilesViewed from "./persistence/PullRequestFilesViewed.ts";
import * as ServerLifecycleEvents from "./serverLifecycleEvents.ts";
import * as AnalyticsService from "./telemetry/AnalyticsService.ts";
import { ProviderSessionDirectoryLive } from "./provider/Layers/ProviderSessionDirectory.ts";
import * as ProviderSessionRuntime from "./persistence/ProviderSessionRuntime.ts";
import { ProviderAdapterRegistryLive } from "./provider/Layers/ProviderAdapterRegistry.ts";
import * as ModelManifest from "./provider/ModelManifest.ts";
import * as ResetCreditCoordinator from "./provider/Layers/resetCreditCoordinator.ts";
import * as ProviderEventLoggers from "./provider/Layers/ProviderEventLoggers.ts";
import { ProviderServiceLive } from "./provider/Layers/ProviderService.ts";
import { ProviderAuthServiceLive } from "./provider/Layers/ProviderAuthService.ts";
import { AntigravityInstallation } from "./provider/AntigravityInstallation.ts";
import { ProviderInstanceRegistry } from "./provider/Services/ProviderInstanceRegistry.ts";
import { ProviderRegistry } from "./provider/Services/ProviderRegistry.ts";
import { ProviderSessionReaperLive } from "./provider/Layers/ProviderSessionReaper.ts";
import { ProviderUsageLimitsIngestionLive } from "./provider/Layers/ProviderUsageLimitsIngestion.ts";
import * as OpenCodeRuntime from "./provider/opencodeRuntime.ts";
import * as CheckpointDiffQuery from "./checkpointing/CheckpointDiffQuery.ts";
import * as CheckpointStore from "./checkpointing/CheckpointStore.ts";
import * as AzureDevOpsCli from "./sourceControl/AzureDevOpsCli.ts";
import * as BitbucketApi from "./sourceControl/BitbucketApi.ts";
import * as GitHubCli from "./sourceControl/GitHubCli.ts";
import * as GitLabCli from "./sourceControl/GitLabCli.ts";
import * as ForgejoCli from "./sourceControl/ForgejoCli.ts";
import * as TextGeneration from "./textGeneration/TextGeneration.ts";
import { ProviderInstanceRegistryHydrationLive } from "./provider/Layers/ProviderInstanceRegistryHydration.ts";
import * as TerminalManager from "./terminal/Manager.ts";
import * as McpHttpServer from "./mcp/McpHttpServer.ts";
import * as McpSessionRegistry from "./mcp/McpSessionRegistry.ts";
// T3-CUSTOM(expbkt3): BEGIN personal MCP profile store and upstream MCP proxy route.
import * as UserMcpProfileStore from "./mcp/UserMcpProfileStore.ts";
import { mcpUpstreamProxyRouteLayer } from "./mcp/McpUpstreamProxy.ts";
// T3-CUSTOM(expbkt3): END
import * as PreviewAutomationBroker from "./mcp/PreviewAutomationBroker.ts";
// T3-CUSTOM(expbkt3): BEGIN — native plan review.
import * as PlanIngestListener from "./planreview/PlanIngestListener.ts";
import * as PlanReviewServiceLayer from "./planreview/PlanReviewService.ts";
// T3-CUSTOM(expbkt3): agent-rendered UI surfaces in chat.
import * as AgentUiServiceLayer from "./agentui/AgentUiService.ts";
import * as PlanReviewDocuments from "./persistence/PlanReviewDocuments.ts";
import * as AgentUiRenders from "./persistence/AgentUiRenders.ts";
// T3-CUSTOM(expbkt3): END
// T3-CUSTOM(expbkt3): event feed for followers such as the Linear bridge.
import { eventFeedRouteLayer } from "./orchestration/eventFeedHttp.expbkt3.ts";
// T3-CUSTOM(expbkt3): pull-request state pushed by the Linear bridge.
import { pullRequestStateRouteLayer } from "./orchestration/pullRequestStateHttp.expbkt3.ts";
// T3-CUSTOM(expbkt3): BEGIN — user presence for agents (t3_user_presence, GET /api/presence).
import * as EnvironmentUsers from "./persistence/EnvironmentUsers.ts";
import { presenceRouteLayer } from "./presence/presenceHttp.expbkt3.ts";
import * as PresenceMessageQuery from "./presence/presenceMessages.ts";
import * as UserPresenceService from "./presence/UserPresenceService.ts";
// T3-CUSTOM(expbkt3): END
import * as DeviceService from "./device/DeviceService.ts";
import { deviceHubProxyRouteLayer } from "./device/DeviceHubProxy.ts";
import * as PreviewManager from "./preview/Manager.ts";
import * as PortScanner from "./preview/PortScanner.ts";
import * as ProcessRunner from "./processRunner.ts";
import * as GitManager from "./git/GitManager.ts";
import * as EnvironmentTheme from "./environmentTheme.ts";
import * as Keybindings from "./keybindings.ts";
import * as ServerRuntimeStartup from "./serverRuntimeStartup.ts";
import { OrchestrationReactorLive } from "./orchestration/Layers/OrchestrationReactor.ts";
import { RuntimeReceiptBusLive } from "./orchestration/Layers/RuntimeReceiptBus.ts";
import { ProviderRuntimeIngestionLive } from "./orchestration/Layers/ProviderRuntimeIngestion.ts";
import { ProviderCommandReactorLive } from "./orchestration/Layers/ProviderCommandReactor.ts";
import { CheckpointReactorLive } from "./orchestration/Layers/CheckpointReactor.ts";
import { ThreadDeletionReactorLive } from "./orchestration/Layers/ThreadDeletionReactor.ts";
// T3-CUSTOM(expbkt3): archive-time session history export.
import { ArchiveExportReactorLive } from "./orchestration/Layers/ArchiveExportReactor.ts";
import * as ThreadSettlementReactor from "./orchestration/ThreadSettlementReactor.ts";
import * as StorageCleanup from "./storageCleanup.ts";
import * as PullRequestSyncReactor from "./orchestration/PullRequestSyncReactor.ts";
import * as ThreadPullRequestReactor from "./orchestration/ThreadPullRequestReactor.ts";
import * as AgentAwarenessRelay from "./relay/AgentAwarenessRelay.ts";
import { hasCloudPublicConfig } from "./cloud/publicConfig.ts";
import { ProviderRegistryLive } from "./provider/Layers/ProviderRegistry.ts";
// T3-CUSTOM(expbkt3): recycle only the Claude thread that reports a hard usage limit.
import * as ClaudeHardLimitRotation from "./provider/claudeHardLimitRotation.expbkt3.ts";
// T3-CUSTOM(expbkt3): Claude account profiles per thread.
import * as ClaudeAccountsServiceLayer from "./claudeAccounts/ClaudeAccountsService.ts";
import * as ClaudeAutoswitchClient from "./claudeAccounts/ClaudeAutoswitchClient.ts";
import * as ThreadClaudeAccount from "./persistence/ThreadClaudeAccount.ts";
import * as ClaudeAccountProfileAccess from "./persistence/ClaudeAccountProfileAccess.ts";
import * as ServerSettings from "./serverSettings.ts";
import * as NativeAppIconResolver from "./assets/NativeAppIconResolver.ts";
import * as ProjectFaviconResolver from "./project/ProjectFaviconResolver.ts";
import * as T3ProjectFileLoader from "./project/T3ProjectFileLoader.ts";
import * as RepositoryIdentityResolver from "./project/RepositoryIdentityResolver.ts";
import * as WorkspaceEntries from "./workspace/WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "./workspace/WorkspaceFileSystem.ts";
import * as WorkspacePaths from "./workspace/WorkspacePaths.ts";
import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "./vcs/VcsDriverRegistry.ts";
import * as VcsProjectConfig from "./vcs/VcsProjectConfig.ts";
import * as VcsProcess from "./vcs/VcsProcess.ts";
import * as VcsProvisioningService from "./vcs/VcsProvisioningService.ts";
import * as VcsStatusBroadcaster from "./vcs/VcsStatusBroadcaster.ts";
import * as ProjectCloneTracker from "./project/ProjectCloneTracker.ts";
import * as GitWorkflowService from "./git/GitWorkflowService.ts";
import * as ReviewService from "./review/ReviewService.ts";
import * as SourceControlProviderRegistry from "./sourceControl/SourceControlProviderRegistry.ts";
import * as PullRequestReadCache from "./pullRequest/PullRequestReadCache.ts";
import * as SourceControlRateLimit from "./sourceControl/SourceControlRateLimit.ts";
import * as SourceControlRepositoryService from "./sourceControl/SourceControlRepositoryService.ts";
import * as SourceControlProfileService from "./sourceControl/SourceControlProfileService.ts";
// T3-CUSTOM(expbkt3): review comments on assistant messages in chat.
import * as ThreadCommentsServiceLayer from "./threadcomments/ThreadCommentsService.ts";
import * as ThreadComments from "./persistence/ThreadComments.ts";
import * as ThreadSourceControlActionLock from "./sourceControl/ThreadSourceControlActionLock.ts";
import * as ProjectSetupScriptRunner from "./project/ProjectSetupScriptRunner.ts";
import * as WorktreeSetupTracker from "./project/WorktreeSetupTracker.ts";
import { ObservabilityLive } from "./observability/Layers/Observability.ts";
import * as HeapSnapshot from "./observability/HeapSnapshot.ts";
import * as EventLoopMonitor from "./observability/EventLoopMonitor.ts";
import * as ServerEnvironment from "./environment/ServerEnvironment.ts";
// T3-CUSTOM(expbkt3): connect-time discovery answered from the last result.
import {
  cachedExternalLauncherLayer,
  cachedRemoteOpenTargetsLayer,
} from "./environment/connectDiscoveryCache.expbkt3.ts";
import { authHttpApiLayer, environmentAuthenticatedAuthLayer } from "./auth/http.ts";
import { ClerkDirectoryLive } from "./auth/ClerkDirectory.ts";
import * as ReplayMarkers from "./auth/replayMarkers.ts";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import * as ClerkIdentityVerifier from "./auth/ClerkIdentityVerifier.ts";
import * as EnvironmentUserService from "./auth/EnvironmentUserService.ts";
// T3-CUSTOM(expbkt3): session-identity markers for provider sessions.
import * as SessionIdentityEnvironment from "./identity/SessionIdentityEnvironment.ts";
import {
  connectHttpApiLayer,
  pendingServiceUpdateExists,
  reconcileDesiredCloudLinkIfStillDesired,
  recoverManagedCloudTunnel,
  registerManagedCloudTunnelRecovery,
  startManagedCloudTunnelIfOriginConfirmed,
  releaseManagedTunnelOnShutdown,
} from "./cloud/http.ts";
import { serverRelayBrokerTracingLayer } from "./cloud/relayTracing.ts";
import { shouldRetryCloudLink } from "./cloud/relayResponse.ts";
import * as CloudManagedEndpointRuntime from "./cloud/ManagedEndpointRuntime.ts";
import {
  MANAGED_TUNNEL_FIRST_REGISTRATION_JITTER,
  MANAGED_TUNNEL_RECOVERY_COOLDOWN,
  managedTunnelStartupAction,
  retryManagedTunnelRegistration,
} from "./cloud/managedTunnelStartup.ts";
import * as CloudCliTokenManager from "./cloud/CliTokenManager.ts";
import * as CloudCliState from "./cloud/CliState.ts";
import * as ServerSelfUpdate from "./cloud/selfUpdate.ts";
import * as DesktopAppUpdate from "./desktopUpdate/DesktopAppUpdate.ts";
import * as ServiceLauncherClient from "./cloud/serviceLauncherClient.ts";
import * as ProcessDiagnostics from "./diagnostics/ProcessDiagnostics.ts";
import * as HostResources from "./resourceTelemetry/HostResources.ts";
import * as ProcessResourceMonitor from "./diagnostics/ProcessResourceMonitor.ts";
import * as TraceDiagnostics from "./diagnostics/TraceDiagnostics.ts";
import * as DesktopTelemetryReceiver from "./resourceTelemetry/DesktopTelemetryReceiver.ts";
import * as NativeTelemetryClient from "./resourceTelemetry/NativeTelemetryClient.ts";
import * as ResourceAttribution from "./resourceTelemetry/ResourceAttribution.ts";
import * as ResourceMonitorBinary from "./resourceTelemetry/ResourceMonitorBinary.ts";
import * as ResourceTelemetry from "./resourceTelemetry/ResourceTelemetry.ts";
import * as UsageLimitSources from "./usage/UsageLimitSources.ts";
import * as UsageService from "./usage/UsageService.ts";
import { OrchestrationLayerLive } from "./orchestration/runtimeLayer.ts";
// T3-CUSTOM(expbkt3): archived-session worktree reclaim
import * as SessionArchiveService from "./sessionArchive/SessionArchiveService.ts";
import * as SessionArchiveSweeper from "./sessionArchive/SessionArchiveSweeper.ts";
import { ProjectionThreadMessageRepositoryLive } from "./persistence/Layers/ProjectionThreadMessages.ts";
// T3-CUSTOM(expbkt3): archive-time history export reads activities, thread
// rows (for the soft-deleted backfill), and provider resume cursors.
import { ProjectionThreadActivityRepositoryLive } from "./persistence/Layers/ProjectionThreadActivities.ts";
import { ProjectionThreadRepositoryLive } from "./persistence/Layers/ProjectionThreads.ts";
// T3-CUSTOM(expbkt3): bootstrap turn starts for HTTP and MCP callers.
import * as TurnStartBootstrap from "./orchestration/turnStartBootstrap.expbkt3.ts";
import * as ThreadWorkspaceGroups from "./persistence/ThreadWorkspaceGroups.ts";
import {
  clearPersistedServerRuntimeState,
  makePersistedServerRuntimeState,
  persistServerRuntimeState,
} from "./serverRuntimeState.ts";
import { orchestrationHttpApiLayer } from "./orchestration/http.ts";
import { OrchestrationAccessControlLive } from "./orchestration/Layers/AccessControl.ts";
import * as NetService from "@t3tools/shared/Net";
import * as RelayClient from "@t3tools/shared/relayClient";
import { disableTailscaleServe, ensureTailscaleServe } from "@t3tools/tailscale";
import { forkParked, ServerActivation } from "./serverActivation.ts";

// MCP handoff thread IDs include escaped provenance and can exceed find-my-way's
// 100-character default for one path segment.
export const HTTP_ROUTER_CONFIG = {
  maxParamLength: 512,
} as const;

// Effect's default preemptive shutdown waits 20s before finalizing request scopes.
// T3's primary transport is long-lived WebSocket RPC, whose Effect scope finalizer
// already closes the websocket gracefully. Do not add an artificial drain before
// those finalizers get a chance to run.
const HTTP_PREEMPTIVE_SHUTDOWN_GRACE_MS = 0;
const ResourceAttributionLayerLive = ResourceAttribution.layer;
const ApplicationObservabilityLive = EventLoopMonitor.layer.pipe(
  Layer.provideMerge(ObservabilityLive),
  Layer.provideMerge(ResourceAttributionLayerLive),
);

const PtyAdapterLive = NodePtyAdapter.layer;

const ServerSettingsLayerLive = ServerSettings.layer.pipe(
  Layer.provide(ServerSecretStore.layer),
  Layer.provideMerge(SqlitePersistenceLayerLive),
);

const NativeTelemetryLayerLive = NativeTelemetryClient.layer.pipe(
  Layer.provide(ResourceMonitorBinary.layer),
);
const DesktopTelemetryReceiverLayerLive = DesktopTelemetryReceiver.layer.pipe(
  Layer.provideMerge(ServerSettingsLayerLive),
);

const ResourceTelemetryLayerLive = ResourceTelemetry.layer.pipe(
  Layer.provideMerge(NativeTelemetryLayerLive),
  Layer.provideMerge(DesktopTelemetryReceiverLayerLive),
);

const HostPowerMonitorLayerLive = HostPowerMonitor.layer.pipe(
  Layer.provide(DesktopTelemetryReceiverLayerLive),
);

// Reuses DesktopTelemetryReceiverLayerLive: a fresh receiver layer here
// would open a second reader on the desktop telemetry fd.
const DesktopAppUpdateLayerLive = DesktopAppUpdate.layer.pipe(
  Layer.provide(DesktopTelemetryReceiverLayerLive),
);

const BackgroundLayerLive = BackgroundPolicy.layer.pipe(
  Layer.provide(HostPowerMonitorLayerLive),
  Layer.provideMerge(ServerSettingsLayerLive),
);

const UsageLayerLive = UsageService.layer.pipe(Layer.provide(ServerSettingsLayerLive));

const ResourceDiagnosticsLayerLive = Layer.mergeAll(
  HostResources.layer,
  ResourceTelemetryLayerLive,
  ProcessDiagnostics.layer.pipe(Layer.provide(ResourceTelemetryLayerLive)),
  ProcessResourceMonitor.layer.pipe(Layer.provide(ResourceTelemetryLayerLive)),
);

const RelayClientLive = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    return RelayClient.layerCloudflared({ baseDir: config.baseDir });
  }),
);

const HttpServerLive = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    return NodeHttpServer.layer(() => guardHttpResponseWriteErrors(NodeHttp.createServer()), {
      host: config.host ?? "127.0.0.1",
      port: config.port,
      gracefulShutdownTimeout: HTTP_PREEMPTIVE_SHUTDOWN_GRACE_MS,
      // Negotiate permessage-deflate with clients that offer it; clients
      // that don't still get uncompressed frames on their connection.
      // Context takeover stays enabled (ws default) so the compression
      // window is shared across frames — that also makes small frames cheap
      // to compress, so no size threshold is set (ws only honors
      // `threshold` when context takeover is disabled).
      websocket: { perMessageDeflate: true },
    });
  }),
);

const PlatformServicesLive = NodeServices.layer;

const ReactorLayerLive = Layer.empty.pipe(
  Layer.provideMerge(OrchestrationReactorLive),
  Layer.provideMerge(ProviderRuntimeIngestionLive),
  Layer.provideMerge(ProviderCommandReactorLive),
  Layer.provideMerge(CheckpointReactorLive),
  Layer.provideMerge(StorageCleanup.layer),
  Layer.provideMerge(ThreadDeletionReactorLive),
  // T3-CUSTOM(expbkt3): archive-time session history export.
  Layer.provideMerge(ArchiveExportReactorLive),
  Layer.provideMerge(ThreadSettlementReactor.layer),
  Layer.provideMerge(PullRequestSyncReactor.layer),
  Layer.provideMerge(ThreadPullRequestReactor.layer),
  Layer.provideMerge(AgentAwarenessRelay.layer.pipe(Layer.provide(ServerSecretStore.layer))),
  Layer.provideMerge(RuntimeReceiptBusLive),
);

const ProviderSessionDirectoryLayerLive = ProviderSessionDirectoryLive.pipe(
  Layer.provide(ProviderSessionRuntime.layer),
);

// `ProviderAdapterRegistryLive` is now a facade that resolves kind → adapter
// by looking up the default `ProviderInstance` per driver in the instance
// registry. Adapter construction itself moved inside each driver's
// `create()`; `ProviderEventLoggers.layer` owns the shared native/canonical
// NDJSON writers and is provided at the outer runtime layer so both
// `ProviderService` and the per-instance drivers read the same logger pair.
const ProviderLayerLive = ProviderServiceLive.pipe(
  Layer.provide(ProviderAdapterRegistryLive),
  Layer.provideMerge(ProviderSessionDirectoryLayerLive),
);

const PersistenceLayerLive = Layer.empty.pipe(Layer.provideMerge(SqlitePersistenceLayerLive));

// T3-CUSTOM(expbkt3): Fully compose this custom persistence service once so
// unrelated route tests and upstream callers never inherit its SqlClient or
// secret-store implementation requirements.
const UserMcpProfileStoreLive = UserMcpProfileStore.layer.pipe(
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(PersistenceLayerLive),
);

const VcsDriverRegistryLayerLive = VcsDriverRegistry.layer.pipe(
  Layer.provide(VcsProjectConfig.layer),
);

const SourceControlProviderRegistryLayerLive = SourceControlProviderRegistry.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      AzureDevOpsCli.layer,
      BitbucketApi.layer,
      GitHubCli.layer,
      GitLabCli.layer,
      ForgejoCli.layer,
    ),
  ),
  Layer.provideMerge(GitVcsDriver.layer),
  Layer.provideMerge(VcsDriverRegistryLayerLive),
);

const RepositoryIdentityResolverLayerLive = Layer.effect(
  RepositoryIdentityResolver.RepositoryIdentityResolver,
  Effect.gen(function* () {
    const registry = yield* SourceControlProviderRegistry.SourceControlProviderRegistry;
    return yield* RepositoryIdentityResolver.make({
      refine: Effect.fn(function* (identity: RepositoryIdentity) {
        const remote = ForgejoCli.parseForgejoRemote(identity.locator.remoteUrl);
        if (
          !remote ||
          !identity.rootPath ||
          (identity.provider !== undefined &&
            identity.provider !== "unknown" &&
            identity.provider !== "forgejo")
        )
          return identity;
        const handle = yield* registry.resolveHandle({
          cwd: identity.rootPath,
          context: {
            provider: { kind: "unknown", name: "Unknown", baseUrl: "" },
            remoteName: identity.locator.remoteName,
            remoteUrl: identity.locator.remoteUrl,
          },
        });
        if (handle.context?.provider.kind !== "forgejo") return identity;
        const baseUrl = handle.context.provider.baseUrl.replace(/\/+$/, "");
        const basePath = new URL(baseUrl).pathname.replace(/^\/+|\/+$/g, "");
        const path =
          !remote.ssh && basePath && remote.path.startsWith(`${basePath}/`)
            ? remote.path.slice(basePath.length + 1)
            : remote.path;
        return { ...identity, provider: "forgejo", webUrl: `${baseUrl}/${path}` };
      }),
    });
  }),
).pipe(Layer.provide(SourceControlProviderRegistryLayerLive), Layer.provide(ProcessRunner.layer));

const PullRequestServiceLive = PullRequestService.layer.pipe(
  Layer.provide(PullRequestProviderRegistry.layer),
  // Where the viewed-file marks live for a host that keeps none of its own.
  Layer.provide(PullRequestFilesViewed.layer),
  Layer.provide(PullRequestReadCache.layer),
  Layer.provide(SourceControlProviderRegistryLayerLive),
  Layer.provide(SourceControlRateLimit.layer),
);

const GitManagerLayerLive = GitManager.layer.pipe(
  Layer.provideMerge(ProjectSetupScriptRunner.layer.pipe(Layer.provide(ServerSettingsLayerLive))),
  Layer.provideMerge(WorktreeSetupTracker.layer),
  Layer.provideMerge(GitVcsDriver.layer),
  Layer.provideMerge(SourceControlProviderRegistryLayerLive),
  Layer.provideMerge(
    TextGeneration.layer.pipe(Layer.provide(SourceControlProviderRegistryLayerLive)),
  ),
);

const GitLayerLive = Layer.empty.pipe(
  Layer.provideMerge(GitManagerLayerLive),
  Layer.provideMerge(GitVcsDriver.layer),
);

const GitWorkflowLayerLive = GitWorkflowService.layer.pipe(
  Layer.provideMerge(VcsDriverRegistryLayerLive),
  Layer.provideMerge(GitLayerLive),
);

const SourceControlRepositoryServiceLayerLive = SourceControlRepositoryService.layer.pipe(
  Layer.provideMerge(GitVcsDriver.layer),
  Layer.provideMerge(SourceControlProviderRegistryLayerLive),
);

// T3-CUSTOM(expbkt3): per-user source-control identity profiles.
const SourceControlProfileServiceLayerLive = SourceControlProfileService.layer.pipe(
  Layer.provide(GitHubCli.layer.pipe(Layer.provide(VcsProcess.layer))),
  Layer.provide(ServerSettingsLayerLive),
  Layer.provide(ServerSecretStore.layer),
);

// T3-CUSTOM(expbkt3): review comments on assistant messages. Sits below the
// reactor group so turn start can append open comments to the agent's input;
// the websocket handlers and MCP tools see it through the same merge.
const ThreadCommentsServiceLayerLive = ThreadCommentsServiceLayer.layer.pipe(
  Layer.provide(ThreadComments.layer),
);

const ProjectCloneTrackerLayerLive = ProjectCloneTracker.layer.pipe(
  Layer.provide(SourceControlRepositoryServiceLayerLive),
);

const ReviewLayerLive = ReviewService.layer.pipe(
  Layer.provideMerge(GitVcsDriver.layer),
  Layer.provideMerge(VcsDriverRegistryLayerLive),
);

const VcsLayerLive = Layer.empty.pipe(
  Layer.provideMerge(VcsProjectConfig.layer),
  Layer.provideMerge(VcsDriverRegistryLayerLive),
  Layer.provideMerge(VcsProvisioningService.layer.pipe(Layer.provide(VcsDriverRegistryLayerLive))),
  Layer.provideMerge(GitWorkflowLayerLive),
  Layer.provideMerge(ReviewLayerLive),
  Layer.provideMerge(SourceControlRepositoryServiceLayerLive),
  Layer.provideMerge(ProjectCloneTrackerLayerLive),
  Layer.provideMerge(
    VcsStatusBroadcaster.layer.pipe(
      Layer.provide(GitWorkflowLayerLive),
      Layer.provide(
        VcsStatusBroadcaster.autoPullPolicyLayer.pipe(Layer.provide(ServerSettingsLayerLive)),
      ),
    ),
  ),
);

const CheckpointingLayerLive = Layer.empty.pipe(
  Layer.provideMerge(CheckpointDiffQuery.layer),
  Layer.provideMerge(CheckpointStore.layer.pipe(Layer.provide(VcsDriverRegistryLayerLive))),
);

const PortScannerLayerLive = PortScanner.layer.pipe(Layer.provide(ProcessRunner.layer));

const TerminalLayerLive = TerminalManager.layer.pipe(
  Layer.provide(PtyAdapterLive),
  Layer.provide(PortScannerLayerLive),
  Layer.provide(NativeTelemetryLayerLive),
);

const PreviewLayerLive = Layer.empty.pipe(
  Layer.provideMerge(PreviewManager.layer),
  Layer.provideMerge(PortScannerLayerLive),
);

const DeviceLayerLive = DeviceService.layer.pipe(
  Layer.provide(ServerSettingsLayerLive),
  Layer.provide(ProcessRunner.layer),
  Layer.provide(NetService.layer),
);

const WorkspaceEntriesLayerLive = WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer));

const WorkspaceFileSystemLayerLive = WorkspaceFileSystem.layer.pipe(
  Layer.provide(WorkspacePaths.layer),
  Layer.provide(WorkspaceEntriesLayerLive),
);

const WorkspaceLayerLive = Layer.mergeAll(
  WorkspacePaths.layer,
  WorkspaceEntriesLayerLive,
  WorkspaceFileSystemLayerLive,
);

const ProjectFaviconResolverLayerLive = ProjectFaviconResolver.layer.pipe(
  Layer.provide(WorkspacePaths.layer),
  Layer.provide(T3ProjectFileLoader.layer),
);

const ServerEnvironmentLayerLive = ServerEnvironment.layer.pipe(
  Layer.provide(ServerSecretStore.layer),
);

// T3-CUSTOM(expbkt3): renamed from upstream's `AuthLayerLive` — the fork's own
// `AuthLayerLive` below layers environment-user and Clerk identity on top.
const EnvironmentAuthLayerLive = EnvironmentAuth.layer.pipe(
  Layer.provideMerge(PersistenceLayerLive),
  Layer.provide(ServerEnvironmentLayerLive),
  Layer.provide(ServerSecretStore.layer),
);

// T3-CUSTOM(expbkt3): BEGIN `AuthLayerLive` now layers the environment-user
// directory and Clerk identity verification over upstream's environment auth.
const AuthLayerLive = EnvironmentUserService.layer.pipe(
  Layer.provide(PersistenceLayerLive),
  Layer.provide(ServerSettingsLayerLive),
  Layer.provideMerge(EnvironmentAuthLayerLive),
  Layer.provideMerge(ClerkIdentityVerifier.layer),
);
// T3-CUSTOM(expbkt3): END

// T3-CUSTOM(expbkt3): provider sessions read owner and sender identity from the
// same environment-user directory the auth layer already builds.
const SessionIdentityLayerLive = SessionIdentityEnvironment.layer.pipe(
  Layer.provideMerge(AuthLayerLive),
);

const CloudManagedEndpointRuntimeLive = Layer.mergeAll(
  RelayClientLive,
  CloudManagedEndpointRuntime.layer.pipe(
    Layer.provide(ServerSecretStore.layer),
    Layer.provide(RelayClientLive),
  ),
);

// T3-CUSTOM(expbkt3): BEGIN Claude account profiles per thread. Placement reads
// the provider event bus and lifecycle like the hard-limit rotation, which
// hands it rejections through a module-level hook; the adapter reads the
// resolver the same way, so neither upstream contract widens.
const ClaudeAccountsLayerLive = ClaudeAccountsServiceLayer.layer.pipe(
  Layer.provide(ThreadClaudeAccount.layer.pipe(Layer.provide(PersistenceLayerLive))),
  Layer.provide(ClaudeAccountProfileAccess.layer.pipe(Layer.provide(PersistenceLayerLive))),
  Layer.provide(
    ClaudeAutoswitchClient.layer.pipe(
      Layer.provide(ProcessRunner.layer),
      Layer.provide(ServerSettingsLayerLive),
    ),
  ),
  Layer.provide(ServerSettingsLayerLive),
);
// T3-CUSTOM(expbkt3): END

// T3-CUSTOM(expbkt3): hard-limit rotation consumes the same provider event bus
// and lifecycle service as the reaper, without widening upstream contracts.
const ProviderRuntimeLayerLive = Layer.mergeAll(
  ProviderSessionReaperLive,
  ClaudeHardLimitRotation.layer.pipe(Layer.provide(ServerSettingsLayerLive)),
  ProviderUsageLimitsIngestionLive,
  ClaudeAccountsLayerLive, // T3-CUSTOM(expbkt3): Claude account profiles per thread.
).pipe(Layer.provideMerge(ProviderLayerLive), Layer.provideMerge(OrchestrationLayerLive));

// T3-CUSTOM(expbkt3): archived-session worktree reclaim. Reads the projection
// for archived threads and their messages, and removes worktrees through the
// same git workflow service the delete path uses.
const SessionArchiveLayerLive = SessionArchiveService.layer.pipe(
  Layer.provide(ServerSettingsLayerLive),
  Layer.provide(OrchestrationLayerLive),
  Layer.provide(ProjectionThreadMessageRepositoryLive),
  // T3-CUSTOM(expbkt3): archive-time export deps — activities sidecar, the
  // soft-deleted backfill row source, and provider resume cursors for raw
  // transcript capture.
  Layer.provide(ProjectionThreadActivityRepositoryLive),
  Layer.provide(ProjectionThreadRepositoryLive),
  Layer.provide(ProviderSessionRuntime.layer),
  Layer.provide(GitWorkflowLayerLive),
  Layer.provide(PersistenceLayerLive),
);

// The sweeper only puts the service on a timer, so it composes on top of it.
const SessionArchiveSweeperLayerLive = SessionArchiveSweeper.layer.pipe(
  Layer.provide(SessionArchiveLayerLive),
  Layer.provide(ServerSettingsLayerLive),
);

const AntigravityInstallationRefreshLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const installation = yield* AntigravityInstallation;
    const instances = yield* ProviderInstanceRegistry;
    const providers = yield* ProviderRegistry;
    yield* installation.changes.pipe(
      Stream.map((state) => state.installedVersion),
      Stream.changes,
      Stream.drop(1),
      Stream.runForEach(() =>
        instances.listInstances.pipe(
          Effect.flatMap((entries) =>
            Effect.forEach(
              entries.filter(
                (instance) => instance.driverKind === ProviderDriverKind.make("antigravity"),
              ),
              (instance) => providers.refreshInstance(instance.instanceId),
              { discard: true },
            ),
          ),
        ),
      ),
      Effect.forkScoped,
    );
  }),
);

const RuntimeCoreDependenciesLive = ReactorLayerLive.pipe(
  Layer.provideMerge(AntigravityInstallationRefreshLive),
  Layer.provideMerge(ReplayMarkers.layer),
  Layer.provideMerge(ProviderAuthServiceLive),
  // Core Services
  Layer.provideMerge(ServerSettingsLayerLive),
  Layer.provideMerge(CheckpointingLayerLive),
  // `GitHubCli` is the registry's own instance, exposed because the asset route fetches
  // GitHub-hosted pull request media with the repository's credential.
  // T3-CUSTOM(expbkt3): BEGIN group source-control services with the profile/lock additions below.
  Layer.provideMerge(
    Layer.mergeAll(
      SourceControlProviderRegistryLayerLive,
      PullRequestServiceLive,
      GitHubCli.layer,
      // T3-CUSTOM(expbkt3): END
      // T3-CUSTOM(expbkt3): per-user source-control profiles and per-thread action lock.
      SourceControlProfileServiceLayerLive,
      ThreadSourceControlActionLock.layer,
      // T3-CUSTOM(expbkt3): review comments on assistant messages in chat.
      ThreadCommentsServiceLayerLive,
    ),
  ),
  Layer.provideMerge(GitLayerLive),
  // T3-CUSTOM(expbkt3): the session archive is merged into the VCS group rather
  // than added as its own `pipe` step — the chain is already at TypeScript's
  // 20-overload ceiling for `.pipe`.
  Layer.provideMerge(
    Layer.mergeAll(VcsLayerLive, SessionArchiveLayerLive, SessionArchiveSweeperLayerLive),
  ),
  Layer.provideMerge(ProviderRuntimeLayerLive),
  Layer.provideMerge(Layer.mergeAll(TerminalLayerLive, PreviewLayerLive, DeviceLayerLive)),
  Layer.provideMerge(PersistenceLayerLive),
  // Both read a user-owned file out of the state directory and stream changes
  // to clients; neither depends on the other.
  Layer.provideMerge(
    Layer.mergeAll(Keybindings.layer, EnvironmentTheme.layer, UsageLimitSources.layer),
  ),
  Layer.provideMerge(ProviderRegistryLive),
  // The instance registry is the new routing keystone — text generation,
  // adapter lookup, and runtime ingestion all resolve `ProviderInstanceId`
  // through this layer. Built-in drivers come from `BUILT_IN_DRIVERS`;
  // `providerInstances` hydration merges `settings.providers.<kind>`
  // with explicit `providerInstances` entries on boot.
  Layer.provideMerge(ProviderInstanceRegistryHydrationLive),
).pipe(
  Layer.provideMerge(AntigravityInstallation.layer),
  // Shared native/canonical NDJSON writers used by both the per-instance
  // drivers (native stream, written from inside each `<X>Adapter`) and
  // `ProviderService` (canonical stream, written after event normalization).
  // Provided once at the runtime level so every consumer sees the same
  // logger instances.
  // `ModelManifest.layer` is the legacy-model classification data, refreshed
  // from the repo's `model-manifest.json` on `main` and applied by the
  // Codex/Claude drivers.
  Layer.provideMerge(
    Layer.mergeAll(ProviderEventLoggers.layer, ModelManifest.layer, ResetCreditCoordinator.layer),
  ),
  // `OpenCodeDriver.create()` yields `OpenCodeRuntime`; previously the old
  // `ProviderRegistryLive` pulled `OpenCodeRuntimeLive` in for itself, but
  // the rewritten registry reads snapshots off the instance registry and
  // no longer transitively provides it. Exposing it at the runtime level
  // keeps a single Live for all opencode consumers.
  Layer.provideMerge(OpenCodeRuntime.OpenCodeRuntimeLive),
  Layer.provideMerge(WorkspaceLayerLive),
  Layer.provideMerge(Layer.mergeAll(NativeAppIconResolver.layer, ProjectFaviconResolverLayerLive)),
  Layer.provideMerge(RepositoryIdentityResolverLayerLive),
  Layer.provideMerge(ServerEnvironmentLayerLive),
  Layer.provideMerge(SessionIdentityLayerLive),
  // T3-CUSTOM(expbkt3): Keep the personal MCP store beside its write-only
  // secret dependency in one merge seam. Besides making upstream rebases
  // mechanical, grouping these avoids exceeding Effect's typed pipe arity.
  Layer.provideMerge(
    Layer.mergeAll(
      ServerSecretStore.layer,
      // Reusing this layer value shares the already-memoized SQLite runtime;
      // it does not create a second database connection or migration graph.
      UserMcpProfileStoreLive,
    ),
  ),
  Layer.provideMerge(
    Layer.mergeAll(
      CloudCliTokenManager.layer.pipe(
        Layer.provide(ServerSecretStore.layer),
        Layer.provide(ExternalLauncher.layer),
      ),
      CloudManagedEndpointRuntimeLive,
    ),
  ),
);

const RuntimeDependenciesLive = RuntimeCoreDependenciesLive.pipe(
  // Misc.
  Layer.provideMerge(BackgroundLayerLive),
  Layer.provideMerge(ResourceDiagnosticsLayerLive),
  Layer.provideMerge(UsageLayerLive),
  Layer.provideMerge(TraceDiagnostics.layer),
  Layer.provideMerge(AnalyticsService.layer),
  // T3-CUSTOM(expbkt3): BEGIN - reconnects reuse the last discovered editors and
  // SSH targets instead of rescanning on the connection's 15 s setup budget.
  Layer.provideMerge(cachedExternalLauncherLayer),
  Layer.provideMerge(cachedRemoteOpenTargetsLayer),
  // T3-CUSTOM(expbkt3): END
  Layer.provideMerge(ServerLifecycleEvents.layer),
  Layer.provide(NetService.layer),
);

const commandReadinessLayer = HttpRouter.middleware(
  (httpEffect) =>
    Effect.flatMap(ServerRuntimeStartup.ServerRuntimeStartup, (startup) =>
      startup.awaitCommandReady.pipe(Effect.orDie, Effect.andThen(httpEffect)),
    ),
  { global: true },
);
// T3-CUSTOM(expbkt3): BEGIN — Build one memoized user profile + credential
// registry pair and provide both to the native T3 MCP transport and upstream
// proxy, with the MCP routes composed under the Clerk/access-control layers
// team mode needs to authorize them.
const PersonalMcpRouteServicesLive = McpSessionRegistry.layer;

const McpRoutesLive = Layer.mergeAll(
  mcpUpstreamProxyRouteLayer,
  McpHttpServer.layer,
  eventFeedRouteLayer,
  pullRequestStateRouteLayer,
  presenceRouteLayer,
).pipe(
  // One registry instance authenticates both the native and upstream MCP
  // routes; separate instances would not recognize each other's run tokens.
  Layer.provideMerge(PersonalMcpRouteServicesLive),
  // The presence tracker serves both the `t3_user_presence` tool and `/api/presence`.
  // Its user directory is composed here so route tests never inherit the repository.
  Layer.provideMerge(
    UserPresenceService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(EnvironmentUsers.layer, PresenceMessageQuery.layer).pipe(
          Layer.provide(PersistenceLayerLive),
        ),
      ),
    ),
  ),
  Layer.provide(ClerkDirectoryLive),
  Layer.provide(OrchestrationAccessControlLive),
);
// T3-CUSTOM(expbkt3): END

export const makeRoutesLayer = Layer.mergeAll(
  Layer.mergeAll(
    HttpApiBuilder.layer(EnvironmentHttpApi).pipe(
      // T3-CUSTOM(expbkt3): Clerk-backed identity resolution for the auth route.
      Layer.provide(authHttpApiLayer.pipe(Layer.provide(ClerkDirectoryLive))),
      Layer.provide(connectHttpApiLayer),
      // T3-CUSTOM(expbkt3): orchestration routes require Clerk-backed access control.
      Layer.provide(
        orchestrationHttpApiLayer.pipe(
          Layer.provide(ClerkDirectoryLive),
          Layer.provide(OrchestrationAccessControlLive),
        ),
      ),
      Layer.provide(pullRequestHttpApiLayer),
      Layer.provide(serverEnvironmentHttpApiLayer),
      Layer.provide(environmentAuthenticatedAuthLayer),
    ),
    otlpTracesProxyRouteLayer,
    assetRouteLayer,
    attachmentUploadRouteLayer,
    deviceHubProxyRouteLayer,
    staticAndDevRouteLayer,
    websocketRpcRouteLayer,
  ),
  // T3-CUSTOM(expbkt3): fork MCP routes (native + upstream proxy, one registry) replace
  // upstream's McpHttpServer-only layer.
  McpRoutesLive,
  // Last, so no route layer can replace the server's one TracerDisabledWhen.
  untracedRequestsLayer,
).pipe(
  // Both transports consume the same service instance, so caches single-flight across clients
  // and mutations observed on WebSocket invalidate patches subsequently read over HTTP.
  Layer.provide(PullRequestServiceLive),
  Layer.provide(PreviewAutomationBroker.layer),
  Layer.provide(ServerSelfUpdate.layer.pipe(Layer.provide(DesktopAppUpdateLayerLive))),
  Layer.provide(commandReadinessLayer),
  Layer.provide(browserApiCorsLayer),
  Layer.provide(httpCompressionLayer),
);

const makeServerLayer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const activation = yield* Deferred.make<void>();
    const awaitActivation = Deferred.await(activation);
    const activationLayer = Layer.succeed(ServerActivation, awaitActivation);
    const runtimeStateParked = yield* Deferred.make<void>();
    const tailscaleParked = yield* Deferred.make<void>();
    const cloudLinkParked = yield* Deferred.make<void>();
    const routesReady = yield* Deferred.make<void>();
    const launcherLayer = ServiceLauncherClient.layer;

    yield* fixPath();

    const httpListeningLayer = Layer.effectDiscard(
      Effect.gen(function* () {
        yield* HttpServer.HttpServer;
        const startup = yield* ServerRuntimeStartup.ServerRuntimeStartup;
        yield* startup.markHttpListening;
      }),
    );
    const runtimeStateLayer = Layer.effectDiscard(
      Effect.acquireRelease(
        Effect.gen(function* () {
          yield* Deferred.succeed(runtimeStateParked, undefined).pipe(Effect.orDie);
          yield* awaitActivation;
          const server = yield* HttpServer.HttpServer;
          const address = server.address;
          if (typeof address === "string" || !("port" in address)) {
            return;
          }

          const launcher = yield* ServiceLauncherClient.ServiceLauncherClient;
          const state = yield* makePersistedServerRuntimeState({
            config,
            port: address.port,
            serviceManaged: launcher.managed,
          });
          yield* persistServerRuntimeState({
            path: config.serverRuntimeStatePath,
            state,
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Failed to persist server runtime state", { cause }),
            ),
          );
        }),
        () =>
          clearPersistedServerRuntimeState(config.serverRuntimeStatePath).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Failed to clear server runtime state", { cause }),
            ),
          ),
      ),
    );
    const tailscaleServeLayer = config.tailscaleServeEnabled
      ? Layer.effectDiscard(
          Effect.acquireRelease(
            Effect.gen(function* () {
              yield* Deferred.succeed(tailscaleParked, undefined).pipe(Effect.orDie);
              yield* awaitActivation;
              const server = yield* HttpServer.HttpServer;
              const address = server.address;
              if (typeof address === "string" || !("port" in address)) {
                return null;
              }

              const localPort = address.port;
              return yield* ensureTailscaleServe({
                localPort,
                servePort: config.tailscaleServePort,
                localHost: "127.0.0.1",
              }).pipe(
                Effect.as({ localPort, servePort: config.tailscaleServePort }),
                Effect.tap(() =>
                  Effect.logInfo("Tailscale Serve configured", {
                    localPort,
                    servePort: config.tailscaleServePort,
                  }),
                ),
                Effect.catch((cause) =>
                  Effect.logWarning("Failed to configure Tailscale Serve", {
                    cause,
                    localPort,
                    servePort: config.tailscaleServePort,
                  }).pipe(Effect.as(null)),
                ),
              );
            }),
            (configured) =>
              configured
                ? disableTailscaleServe({ servePort: configured.servePort }).pipe(
                    Effect.tap(() =>
                      Effect.logInfo("Tailscale Serve disabled", {
                        servePort: configured.servePort,
                      }),
                    ),
                    Effect.catch((cause) =>
                      Effect.logWarning("Failed to disable Tailscale Serve", {
                        cause,
                        servePort: configured.servePort,
                      }),
                    ),
                  )
                : Effect.void,
          ),
        )
      : Layer.empty;
    const cloudDesiredLinkReconcileLayer = Layer.effectDiscard(
      Effect.gen(function* () {
        const releaseManagedTunnel = releaseManagedTunnelOnShutdown().pipe(
          Effect.timeout("10 seconds"),
          Effect.tap((released) =>
            released ? Effect.logInfo("Released the managed tunnel on shutdown") : Effect.void,
          ),
          Effect.catchCause((cause) =>
            Effect.logWarning(
              "Failed to release the managed tunnel on shutdown; the next link reuses it",
              { errors: Cause.prettyErrors(cause).map((error) => error.message) },
            ),
          ),
          Effect.asVoid,
        );
        // A launcher trial can be stopped before activation. The previous
        // server is already gone, so the trial owns cleanup immediately; the
        // pending-state check keeps the tunnel for normal commit or rollback,
        // while the launcher's explicit-stop marker allows it to be released.
        // Other runtimes wait for activation so a failed standby cannot tear
        // down the active runtime's tunnel.
        const cleanupBeforeActivation = yield* pendingServiceUpdateExists;
        if (cleanupBeforeActivation) {
          yield* Effect.addFinalizer(() => releaseManagedTunnel);
        }
        yield* forkParked(
          Effect.gen(function* () {
            if (!cleanupBeforeActivation) {
              yield* Effect.addFinalizer(() => releaseManagedTunnel);
            }
            const server = yield* HttpServer.HttpServer;
            const address = server.address;
            if (typeof address === "string" || !("port" in address)) return;
            const localOrigin = `http://127.0.0.1:${address.port}`;
            const endpointRuntime = yield* CloudManagedEndpointRuntime.CloudManagedEndpointRuntime;
            const recoveryLock = yield* Semaphore.make(1);
            let lastRecoveryAtMillis = 0;
            const recoverManagedTunnel = (config: RelayManagedEndpointRuntimeConfig) =>
              recoveryLock.withPermits(1)(
                Effect.gen(function* () {
                  const elapsed = (yield* Clock.currentTimeMillis) - lastRecoveryAtMillis;
                  const wait = Duration.toMillis(MANAGED_TUNNEL_RECOVERY_COOLDOWN) - elapsed;
                  if (wait > 0) yield* Effect.sleep(Duration.millis(wait));
                  lastRecoveryAtMillis = yield* Clock.currentTimeMillis;
                }).pipe(
                  Effect.andThen(
                    recoverManagedCloudTunnel(localOrigin, config, {
                      retryRuntimeFailures: true,
                    }),
                  ),
                  Effect.retry({
                    while: (error) =>
                      shouldRetryCloudLink(error) &&
                      error._tag !== "EnvironmentCloudEndpointUnavailableError",
                    schedule: Schedule.exponential("1 second").pipe(
                      Schedule.modifyDelay(({ duration }) =>
                        Effect.succeed(Duration.min(duration, Duration.seconds(30))),
                      ),
                      Schedule.jittered,
                    ),
                  }),
                  Effect.tap((recovered) =>
                    recovered ? Effect.logInfo("T3 Connect managed tunnel recovered") : Effect.void,
                  ),
                  Effect.catchCause((cause) =>
                    Cause.hasInterrupts(cause)
                      ? Effect.interrupt
                      : Effect.logWarning("Failed to recover the T3 Connect managed tunnel", {
                          cause,
                        }),
                  ),
                ),
              );
            yield* endpointRuntime.recoveryRequests.pipe(
              Stream.runForEach(recoverManagedTunnel),
              Effect.forkScoped,
            );
            // No settling delay before the first attempt: routes are already
            // serving by the time activation opens this gate (the startup
            // sequence awaits routesReady), and the retry schedule below
            // covers anything this sleep used to hedge against. Every
            // millisecond here is dead time on the path to remote
            // reachability after a restart.
            const wantsCliLink = hasCloudPublicConfig
              ? yield* CloudCliState.readCliDesiredCloudLink.pipe(
                  Effect.catch((cause) =>
                    Effect.logWarning("Failed to read the desired T3 Connect link", { cause }).pipe(
                      Effect.as(false),
                    ),
                  ),
                )
              : false;
            // A failed read must not end this fiber before it registers
            // recovery and starts consuming recovery requests. "managed" is
            // what a missing value means, so it is the safe fallback.
            const desiredCliLinkMode = wantsCliLink
              ? yield* CloudCliState.readCliDesiredLinkMode.pipe(
                  Effect.catch((cause) =>
                    Effect.logWarning("Failed to read the desired T3 Connect link mode", {
                      cause,
                    }).pipe(Effect.as("managed" as const)),
                  ),
                )
              : null;
            // A publish-only link must not expose the host, even if a managed
            // config from an earlier link is still stored.
            const startedConfirmed =
              desiredCliLinkMode === "publish_only"
                ? false
                : yield* startManagedCloudTunnelIfOriginConfirmed(localOrigin).pipe(
                    Effect.catch((cause) =>
                      Effect.logWarning("Failed to start the confirmed T3 Connect tunnel", {
                        cause,
                      }).pipe(Effect.as(false)),
                    ),
                  );
            const startStoredManagedTunnel = startManagedCloudTunnelIfOriginConfirmed(localOrigin, {
              requireConfirmedOrigin: false,
            }).pipe(
              Effect.tap((started) =>
                started
                  ? Effect.logWarning(
                      "T3 Connect started the stored tunnel without relay confirmation",
                    )
                  : Effect.void,
              ),
              Effect.catch((cause) =>
                Effect.logWarning("Failed to start the stored T3 Connect tunnel", { cause }),
              ),
              Effect.asVoid,
            );
            const registerManagedTunnel = retryManagedTunnelRegistration(
              registerManagedCloudTunnelRecovery(localOrigin, {
                retryRuntimeFailures: true,
              }),
              (error) =>
                shouldRetryCloudLink(error) &&
                error._tag !== "EnvironmentCloudEndpointUnavailableError",
              startedConfirmed ? Effect.void : startStoredManagedTunnel,
            ).pipe(
              Effect.tap((result) =>
                result.status === "ready"
                  ? Effect.logInfo("T3 Connect managed tunnel recovery registered")
                  : Effect.void,
              ),
              Effect.catchCause((cause) =>
                Cause.hasInterrupts(cause)
                  ? Effect.interrupt
                  : Effect.logWarning("Failed to register T3 Connect managed tunnel recovery", {
                      cause,
                    }).pipe(Effect.as({ status: "unavailable" as const })),
              ),
            );
            // A host without a confirmed marker is on its first boot after the
            // upgrade. Spread those registrations so an auto-update wave does
            // not hit the relay all at once.
            if (!startedConfirmed && desiredCliLinkMode !== "publish_only") {
              const jitter = yield* Random.nextIntBetween(
                0,
                Duration.toMillis(MANAGED_TUNNEL_FIRST_REGISTRATION_JITTER),
              );
              yield* Effect.sleep(Duration.millis(jitter));
            }
            const registration =
              desiredCliLinkMode === "publish_only"
                ? { status: "not_linked" as const }
                : yield* registerManagedTunnel;
            // A terminal registration failure also allows the stored config
            // to start. Transient outages use the fallback above and keep
            // registration retrying in this scoped startup fiber.
            if (registration.status === "unavailable" && !startedConfirmed) {
              yield* startStoredManagedTunnel;
            }
            const startupAction = managedTunnelStartupAction({ wantsCliLink, registration });
            if (startupAction.action === "request_recovery") {
              yield* endpointRuntime.requestRecovery(startupAction.config);
            }
            if (startupAction.action === "reconcile_link") {
              const reconciledMode = yield* reconcileDesiredCloudLinkIfStillDesired(
                localOrigin,
              ).pipe(
                Effect.retry({
                  while: shouldRetryCloudLink,
                  schedule: Schedule.exponential("1 second").pipe(
                    Schedule.modifyDelay(({ duration }) =>
                      Effect.succeed(Duration.min(duration, Duration.seconds(30))),
                    ),
                    Schedule.upTo({ duration: "10 minutes" }),
                  ),
                }),
                Effect.tap((mode) =>
                  mode === null
                    ? Effect.void
                    : Effect.logInfo("T3 Connect desired link reconciled on startup"),
                ),
                Effect.catch((cause) =>
                  Effect.logWarning("Failed to reconcile T3 Connect desired link on startup", {
                    cause,
                  }).pipe(Effect.as(null)),
                ),
              );
              if (reconciledMode === "managed") {
                const afterReconcile = yield* registerManagedTunnel;
                if (afterReconcile.status === "recovery_required") {
                  yield* endpointRuntime.requestRecovery(afterReconcile.config);
                }
              }
            }
          }),
        );
        yield* Deferred.succeed(cloudLinkParked, undefined).pipe(Effect.orDie);
      }),
    );

    // T3-CUSTOM(expbkt3): renamed from upstream's `runtimeServicesLive` — the
    // fork layers a bootstrap dispatcher and other services on top of it below.
    const runtimeBaseServicesLive = ServerRuntimeStartup.layerWithOptions({
      activate: Deferred.succeed(activation, undefined).pipe(Effect.asVoid),
      abort: (error) => Deferred.die(activation, error).pipe(Effect.asVoid),
      awaitAuxiliaryParked: Effect.all(
        [
          Deferred.await(runtimeStateParked),
          Deferred.await(cloudLinkParked),
          Deferred.await(routesReady),
          ...(config.tailscaleServeEnabled ? [Deferred.await(tailscaleParked)] : []),
        ],
        { concurrency: "unbounded" },
      ).pipe(Effect.asVoid),
    }).pipe(Layer.provideMerge(RuntimeDependenciesLive), Layer.provide(launcherLayer));
    // T3-CUSTOM(expbkt3): Layer the bootstrap dispatcher beside upstream's
    // activation-aware runtime services.
    const runtimeServicesWithDispatcherLive = Layer.mergeAll(
      runtimeBaseServicesLive,
      TurnStartBootstrap.layer.pipe(
        // T3-CUSTOM(expbkt3): shared child worktrees, one per (parent, repo).
        Layer.provide(ThreadWorkspaceGroups.layer.pipe(Layer.provide(PersistenceLayerLive))),
        Layer.provide(runtimeBaseServicesLive),
      ),
    );
    // T3-CUSTOM(expbkt3): native plan review reads the proposed-plan events.
    const planReviewServicesLive = PlanReviewServiceLayer.layer.pipe(
      Layer.provide(PlanReviewDocuments.layer),
      Layer.provideMerge(runtimeServicesWithDispatcherLive),
    );
    // T3-CUSTOM(expbkt3): agent-rendered UI surfaces. Only needs the sqlite
    // client, so it composes beside plan review rather than under it.
    const agentUiServicesLive = AgentUiServiceLayer.layer.pipe(
      Layer.provide(AgentUiRenders.layer),
      Layer.provideMerge(runtimeServicesWithDispatcherLive),
    );
    const runtimeServicesLive = Layer.mergeAll(
      PlanIngestListener.layer.pipe(Layer.provideMerge(planReviewServicesLive)),
      planReviewServicesLive,
      agentUiServicesLive,
    );

    const routesLayer = HttpRouter.serve(makeRoutesLayer.pipe(Layer.provide(launcherLayer)), {
      disableLogger: !config.logWebSocketEvents,
      routerConfig: HTTP_ROUTER_CONFIG,
    }).pipe(Layer.tap(() => Deferred.succeed(routesReady, undefined).pipe(Effect.orDie)));
    const serverApplicationLayer = Layer.mergeAll(
      routesLayer,
      httpListeningLayer,
      runtimeStateLayer.pipe(Layer.provide(launcherLayer)),
      tailscaleServeLayer,
      cloudDesiredLinkReconcileLayer,
      HeapSnapshot.layer,
    );

    return serverApplicationLayer.pipe(
      Layer.provideMerge(runtimeServicesLive),
      Layer.provide(activationLayer),
      Layer.provideMerge(serverRelayBrokerTracingLayer),
      Layer.provideMerge(HttpServerLive),
      Layer.provide(ApplicationObservabilityLive),
      Layer.provideMerge(FetchHttpClient.layer),
      // PR reads, Git operations, and WebSocket discovery share one process limiter.
      Layer.provide(VcsProcess.layer),
      Layer.provideMerge(PlatformServicesLive),
    );
  }),
);

// The CLI supplies configuration.
export const runServer = Layer.launch(makeServerLayer);
