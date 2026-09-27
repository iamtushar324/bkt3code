import {
  EnvironmentHttpApi,
  ProviderDriverKind,
  type RepositoryIdentity,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
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
} from "./http.ts";
import { guardHttpResponseWriteErrors } from "./httpResponseErrorGuard.ts";
import { fixPath } from "./os-jank.ts";
import { websocketRpcRouteLayer } from "./ws.ts";
import * as ExternalLauncher from "./process/externalLauncher.ts";
import { pullRequestHttpApiLayer } from "./pullRequest/http.ts";
import * as PullRequestProviderRegistry from "./pullRequest/PullRequestProviderRegistry.ts";
import * as PullRequestService from "./pullRequest/PullRequestService.ts";
import { layerConfig as SqlitePersistenceLayerLive } from "./persistence/Layers/Sqlite.ts";
import * as ServerLifecycleEvents from "./serverLifecycleEvents.ts";
import * as AnalyticsService from "./telemetry/AnalyticsService.ts";
import { ProviderSessionDirectoryLive } from "./provider/Layers/ProviderSessionDirectory.ts";
import * as ProviderSessionRuntime from "./persistence/ProviderSessionRuntime.ts";
// T3-CUSTOM(expbkt3): automatic session recovery.
import * as SessionRecoveryState from "./persistence/SessionRecoveryState.ts";
import { SessionRecoveryLive } from "./recovery/SessionRecoveryLive.ts";
import { ProviderAdapterRegistryLive } from "./provider/Layers/ProviderAdapterRegistry.ts";
import * as ModelManifest from "./provider/ModelManifest.ts";
import * as CodexResetCredit from "./provider/Layers/codexResetCredit.ts";
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
import * as UserMcpProfileStore from "./mcp/UserMcpProfileStore.ts";
import { mcpUpstreamProxyRouteLayer } from "./mcp/McpUpstreamProxy.ts";
import * as PreviewAutomationBroker from "./mcp/PreviewAutomationBroker.ts";
// T3-CUSTOM(expbkt3): BEGIN — experimental native-plan review runtime.
import * as PlannotatorManager from "./plannotator/PlannotatorManager.ts";
// T3-CUSTOM(expbkt3): native plan review.
import * as PlanIngestListener from "./planreview/PlanIngestListener.ts";
import * as PlanReviewServiceLayer from "./planreview/PlanReviewService.ts";
// T3-CUSTOM(expbkt3): agent-rendered UI surfaces in chat.
import * as AgentUiServiceLayer from "./agentui/AgentUiService.ts";
import * as PlanReviewDocuments from "./persistence/PlanReviewDocuments.ts";
import * as AgentUiRenders from "./persistence/AgentUiRenders.ts";
import { plannotatorProxyRouteLayer } from "./plannotator/http.ts";
// T3-CUSTOM(expbkt3): END
// T3-CUSTOM(expbkt3): event feed for followers such as the Linear bridge.
import { eventFeedRouteLayer } from "./orchestration/eventFeedHttp.expbkt3.ts";
// T3-CUSTOM(expbkt3): pull-request state pushed by the Linear bridge.
import { pullRequestStateRouteLayer } from "./orchestration/pullRequestStateHttp.expbkt3.ts";
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
import { CatchupSummaryReactorLive } from "./orchestration/Layers/CatchupSummaryReactor.ts";
// T3-CUSTOM(expbkt3): BEGIN — bulk session manager work summaries.
import { WorkSummaryReactorLive } from "./orchestration/Layers/WorkSummaryReactor.ts";
// T3-CUSTOM(expbkt3): END
import { CheckpointReactorLive } from "./orchestration/Layers/CheckpointReactor.ts";
import { ThreadDeletionReactorLive } from "./orchestration/Layers/ThreadDeletionReactor.ts";
// T3-CUSTOM(expbkt3): archive-time session history export.
import { ArchiveExportReactorLive } from "./orchestration/Layers/ArchiveExportReactor.ts";
import * as ThreadSettlementReactor from "./orchestration/ThreadSettlementReactor.ts";
import * as PullRequestSyncReactor from "./orchestration/PullRequestSyncReactor.ts";
import * as ThreadPullRequestReactor from "./orchestration/ThreadPullRequestReactor.ts";
import * as AgentAwarenessRelay from "./relay/AgentAwarenessRelay.ts";
import { hasCloudPublicConfig } from "./cloud/publicConfig.ts";
import { ProviderRegistryLive } from "./provider/Layers/ProviderRegistry.ts";
import * as ProviderRateLimits from "./provider/ProviderRateLimits.ts";
// T3-CUSTOM(expbkt3): recycle only the Claude thread that reports a hard usage limit.
import * as ClaudeHardLimitRotation from "./provider/claudeHardLimitRotation.expbkt3.ts";
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
import * as GitWorkflowService from "./git/GitWorkflowService.ts";
import * as ReviewService from "./review/ReviewService.ts";
import * as SourceControlProviderRegistry from "./sourceControl/SourceControlProviderRegistry.ts";
import * as PullRequestReadCache from "./pullRequest/PullRequestReadCache.ts";
import * as SourceControlRateLimit from "./sourceControl/SourceControlRateLimit.ts";
import * as SourceControlRepositoryService from "./sourceControl/SourceControlRepositoryService.ts";
import * as SourceControlProfileService from "./sourceControl/SourceControlProfileService.ts";
import * as ThreadSourceControlActionLock from "./sourceControl/ThreadSourceControlActionLock.ts";
import * as ProjectSetupScriptRunner from "./project/ProjectSetupScriptRunner.ts";
import { ObservabilityLive } from "./observability/Layers/Observability.ts";
import * as ServerEnvironment from "./environment/ServerEnvironment.ts";
import * as RemoteOpenTargets from "./environment/RemoteOpenTargets.ts";
import { authHttpApiLayer, environmentAuthenticatedAuthLayer } from "./auth/http.ts";
import { ClerkDirectoryLive } from "./auth/ClerkDirectory.ts";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import * as ClerkIdentityVerifier from "./auth/ClerkIdentityVerifier.ts";
import * as EnvironmentUserService from "./auth/EnvironmentUserService.ts";
// T3-CUSTOM(expbkt3): session-identity markers for provider sessions.
import * as SessionIdentityEnvironment from "./identity/SessionIdentityEnvironment.ts";
import {
  connectHttpApiLayer,
  pendingServiceUpdateExists,
  reconcileDesiredCloudLink,
  releaseManagedTunnelOnShutdown,
} from "./cloud/http.ts";
import { serverRelayBrokerTracingLayer } from "./cloud/relayTracing.ts";
import { shouldRetryCloudLink } from "./cloud/relayResponse.ts";
import * as CloudManagedEndpointRuntime from "./cloud/ManagedEndpointRuntime.ts";
import * as CloudCliTokenManager from "./cloud/CliTokenManager.ts";
import * as CloudCliState from "./cloud/CliState.ts";
import * as ServerSelfUpdate from "./cloud/selfUpdate.ts";
import * as DesktopAppUpdate from "./desktopUpdate/DesktopAppUpdate.ts";
import * as ServiceLauncherClient from "./cloud/serviceLauncherClient.ts";
import * as ProcessDiagnostics from "./diagnostics/ProcessDiagnostics.ts";
import * as HostResources from "./resourceTelemetry/HostResources.ts";
import * as ProcessResourceMonitor from "./diagnostics/ProcessResourceMonitor.ts";
import * as SystemResourceMonitor from "./observability/SystemResourceMonitor.ts";
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
// T3-CUSTOM(expbkt3): 6-hourly SQLite statistics refresh.
import { SqliteOptimizeScheduleLive } from "./persistence/sqliteOptimize.expbkt3.ts";
import { ProjectionThreadMessageRepositoryLive } from "./persistence/Layers/ProjectionThreadMessages.ts";
// T3-CUSTOM(expbkt3): archive-time history export reads activities, thread
// rows (for the soft-deleted backfill), and provider resume cursors.
import { ProjectionThreadActivityRepositoryLive } from "./persistence/Layers/ProjectionThreadActivities.ts";
import { ProjectionThreadRepositoryLive } from "./persistence/Layers/ProjectionThreads.ts";
import * as OrchestrationCommandDispatcher from "./orchestration/dispatchCommand.ts";
import { ThreadExecutionSupervisorLive } from "./execution/ThreadExecutionSupervisorLive.ts";
// T3-CUSTOM(expbkt3): durable execution state machine repository.
import { DurableExecutionIntentRepositoryLive } from "./execution/DurableExecutionIntentRepository.ts";
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
const ApplicationObservabilityLive = ObservabilityLive.pipe(
  Layer.provideMerge(ResourceAttributionLayerLive),
);

const PtyAdapterLive = Layer.unwrap(
  Effect.gen(function* () {
    if (typeof Bun !== "undefined") {
      const BunPtyAdapter = yield* Effect.promise(() => import("./terminal/BunPtyAdapter.ts"));
      return BunPtyAdapter.layer;
    } else {
      const NodePtyAdapter = yield* Effect.promise(() => import("./terminal/NodePtyAdapter.ts"));
      return NodePtyAdapter.layer;
    }
  }),
);

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
    if (typeof Bun !== "undefined") {
      const BunHttpServer = yield* Effect.promise(
        () => import("@effect/platform-bun/BunHttpServer"),
      );
      return BunHttpServer.layer({
        port: config.port,
        hostname: config.host ?? "127.0.0.1",
        gracefulShutdownTimeout: HTTP_PREEMPTIVE_SHUTDOWN_GRACE_MS,
        websocket: {
          // Negotiate permessage-deflate with clients that offer it; clients
          // that don't still get uncompressed frames on their connection. A
          // dedicated compressor keeps a per-connection sliding window
          // (context takeover) so the compression dictionary is shared across
          // server-to-client frames. Decompression uses the shared
          // decompressor: uWebSockets' dedicated decompressor path can abort
          // connections (close 1006) on valid DEFLATE input — see
          // https://github.com/uNetworking/uWebSockets.js/issues/633.
          perMessageDeflate: {
            compress: "dedicated",
            decompress: "shared",
          },
        },
      });
    } else {
      const [NodeHttpServer, NodeHttp] = yield* Effect.all([
        Effect.promise(() => import("@effect/platform-node/NodeHttpServer")),
        Effect.promise(() => import("node:http")),
      ]);
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
    }
  }),
);

const PlatformServicesLive = Layer.unwrap(
  Effect.gen(function* () {
    if (typeof Bun !== "undefined") {
      const { layer } = yield* Effect.promise(() => import("@effect/platform-bun/BunServices"));
      return layer;
    } else {
      const { layer } = yield* Effect.promise(() => import("@effect/platform-node/NodeServices"));
      return layer;
    }
  }),
);

const ReactorLayerLive = Layer.empty.pipe(
  Layer.provideMerge(OrchestrationReactorLive),
  Layer.provideMerge(ProviderRuntimeIngestionLive),
  Layer.provideMerge(ProviderCommandReactorLive),
  Layer.provideMerge(CheckpointReactorLive),
  Layer.provideMerge(CatchupSummaryReactorLive),
  // T3-CUSTOM(expbkt3): BEGIN — bulk session manager work summaries.
  Layer.provideMerge(WorkSummaryReactorLive),
  // T3-CUSTOM(expbkt3): END
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

// T3-CUSTOM(expbkt3): shared repository instance for provider dispatch and recovery.
const DurableExecutionIntentLayerLive = DurableExecutionIntentRepositoryLive.pipe(
  Layer.provide(PersistenceLayerLive),
);

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
  Layer.provide(PullRequestReadCache.layer),
  Layer.provide(SourceControlProviderRegistryLayerLive),
  Layer.provide(SourceControlRateLimit.layer),
);

const GitManagerLayerLive = GitManager.layer.pipe(
  Layer.provideMerge(
    ProjectSetupScriptRunner.layer.pipe(
      // T3-CUSTOM(expbkt3): setup falls back to the repository's t3.json.
      Layer.provide(T3ProjectFileLoader.layer),
      Layer.provide(ServerSettingsLayerLive),
    ),
  ),
  Layer.provideMerge(GitVcsDriver.layer),
  Layer.provideMerge(SourceControlProviderRegistryLayerLive),
  Layer.provideMerge(TextGeneration.layer),
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

const SourceControlProfileServiceLayerLive = SourceControlProfileService.layer.pipe(
  Layer.provide(GitHubCli.layer.pipe(Layer.provide(VcsProcess.layer))),
  Layer.provide(ServerSettingsLayerLive),
  Layer.provide(ServerSecretStore.layer),
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

const EnvironmentAuthLayerLive = EnvironmentAuth.layer.pipe(
  Layer.provideMerge(PersistenceLayerLive),
  // T3-CUSTOM(expbkt3): enables coordinator ownership in ProviderCommandReactor.
  Layer.provideMerge(DurableExecutionIntentLayerLive),
  Layer.provide(ServerEnvironmentLayerLive),
  Layer.provide(ServerSecretStore.layer),
);

const AuthLayerLive = EnvironmentUserService.layer.pipe(
  Layer.provide(PersistenceLayerLive),
  Layer.provide(ServerSettingsLayerLive),
  Layer.provideMerge(EnvironmentAuthLayerLive),
  Layer.provideMerge(ClerkIdentityVerifier.layer),
);

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

// T3-CUSTOM(expbkt3): hard-limit rotation consumes the same provider event bus
// and lifecycle service as the reaper, without widening upstream contracts.
const ProviderRuntimeLayerLive = Layer.mergeAll(
  ProviderSessionReaperLive,
  ClaudeHardLimitRotation.layer,
  ProviderUsageLimitsIngestionLive,
).pipe(Layer.provideMerge(ProviderLayerLive), Layer.provideMerge(OrchestrationLayerLive));

// T3-CUSTOM(expbkt3): the supervisor records session recovery desired-state,
// so its repository is composed in here rather than at every call site.
const SessionRecoveryStateLayerLive = SessionRecoveryState.layer.pipe(
  Layer.provide(PersistenceLayerLive),
);

const ExecutionLayerLive = ThreadExecutionSupervisorLive.pipe(
  // T3-CUSTOM(expbkt3): explicit Stop must fence the same durable rows the coordinator claims.
  Layer.provide(DurableExecutionIntentLayerLive),
  Layer.provide(ProviderLayerLive),
  Layer.provide(OrchestrationLayerLive),
  Layer.provide(PersistenceLayerLive),
  Layer.provide(SessionRecoveryStateLayerLive),
);

// T3-CUSTOM(expbkt3): reconnects sessions killed by a restart or a provider
// crash. Depends on the supervisor for live snapshots, so it composes after it.
const SessionRecoveryLayerLive = SessionRecoveryLive.pipe(
  Layer.provide(ExecutionLayerLive),
  Layer.provide(OrchestrationLayerLive),
  Layer.provide(SessionRecoveryStateLayerLive),
);

const ProviderExecutionRuntimeLayerLive = Layer.mergeAll(
  ProviderRuntimeLayerLive,
  ExecutionLayerLive,
  SessionRecoveryLayerLive,
);

const ProviderRateLimitsLayerLive = ProviderRateLimits.layer.pipe(Layer.provide(ProviderLayerLive));

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
  Layer.provideMerge(ProviderAuthServiceLive),
  // Core Services
  Layer.provideMerge(ServerSettingsLayerLive),
  Layer.provideMerge(CheckpointingLayerLive),
  Layer.provideMerge(
    Layer.mergeAll(
      SourceControlProviderRegistryLayerLive,
      PullRequestServiceLive,
      SourceControlProfileServiceLayerLive,
      ThreadSourceControlActionLock.layer,
    ),
  ),
  Layer.provideMerge(GitLayerLive),
  // T3-CUSTOM(expbkt3): the session archive is merged into the VCS group rather
  // than added as its own `pipe` step — the chain is already at TypeScript's
  // 20-overload ceiling for `.pipe`. The 6-hourly SQLite optimize rides along.
  Layer.provideMerge(
    Layer.mergeAll(
      VcsLayerLive,
      SessionArchiveLayerLive,
      SessionArchiveSweeperLayerLive,
      SqliteOptimizeScheduleLive,
    ),
  ),
  Layer.provideMerge(ProviderExecutionRuntimeLayerLive),
  Layer.provideMerge(
    Layer.mergeAll(
      ProviderRateLimitsLayerLive,
      TerminalLayerLive,
      PreviewLayerLive,
      DeviceLayerLive,
    ),
  ),
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
    Layer.mergeAll(ProviderEventLoggers.layer, ModelManifest.layer, CodexResetCredit.layer),
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
  // T3-CUSTOM(expbkt3): host-level metrics for the sidebar resource pill.
  // Upstream's ResourceDiagnosticsLayerLive already covers ProcessDiagnostics
  // and ProcessResourceMonitor; SystemResourceMonitor is fork-only.
  Layer.provideMerge(SystemResourceMonitor.layer),
  Layer.provideMerge(UsageLayerLive),
  Layer.provideMerge(TraceDiagnostics.layer),
  Layer.provideMerge(AnalyticsService.layer),
  Layer.provideMerge(ExternalLauncher.layer),
  Layer.provideMerge(RemoteOpenTargets.layer),
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
// T3-CUSTOM(expbkt3): Build one memoized user profile + credential registry
// pair and provide both to the native T3 MCP transport and upstream proxy.
const PersonalMcpRouteServicesLive = McpSessionRegistry.layer;

const PlannotatorAndMcpRoutesLive = Layer.mergeAll(
  plannotatorProxyRouteLayer,
  mcpUpstreamProxyRouteLayer,
  McpHttpServer.layer,
  eventFeedRouteLayer,
  pullRequestStateRouteLayer,
).pipe(
  // One registry instance authenticates both the native and upstream MCP
  // routes; separate instances would not recognize each other's run tokens.
  Layer.provideMerge(PersonalMcpRouteServicesLive),
  Layer.provide(ClerkDirectoryLive),
  Layer.provide(OrchestrationAccessControlLive),
);
// T3-CUSTOM(expbkt3): END

export const makeRoutesLayer = Layer.mergeAll(
  Layer.mergeAll(
    HttpApiBuilder.layer(EnvironmentHttpApi).pipe(
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
  PlannotatorAndMcpRoutesLive,
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

          const state = yield* makePersistedServerRuntimeState({
            config,
            port: address.port,
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
        if (!hasCloudPublicConfig) {
          yield* Deferred.succeed(cloudLinkParked, undefined).pipe(Effect.orDie);
          return;
        }
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
            if (!(yield* CloudCliState.readCliDesiredCloudLink)) return;
            const server = yield* HttpServer.HttpServer;
            const address = server.address;
            if (typeof address === "string" || !("port" in address)) return;
            // No settling delay before the first attempt: routes are already
            // serving by the time activation opens this gate (the startup
            // sequence awaits routesReady), and the retry schedule below
            // covers anything this sleep used to hedge against. Every
            // millisecond here is dead time on the path to remote
            // reachability after a restart.
            yield* reconcileDesiredCloudLink(`http://127.0.0.1:${address.port}`).pipe(
              Effect.retry({
                while: shouldRetryCloudLink,
                schedule: Schedule.exponential("1 second").pipe(
                  Schedule.modifyDelay(({ duration }) =>
                    Effect.succeed(Duration.min(duration, Duration.seconds(30))),
                  ),
                  Schedule.upTo({ duration: "10 minutes" }),
                ),
              }),
              Effect.tap(() => Effect.logInfo("T3 Connect desired link reconciled on startup")),
              Effect.catch((cause) =>
                Effect.logWarning("Failed to reconcile T3 Connect desired link on startup", {
                  message: cause.message,
                }),
              ),
            );
          }),
        );
        yield* Deferred.succeed(cloudLinkParked, undefined).pipe(Effect.orDie);
      }),
    );

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
    // T3-CUSTOM(expbkt3): Layer the durable dispatcher and Plannotator beside
    // upstream's activation-aware runtime services.
    const runtimeServicesWithoutPlannotatorLive = Layer.mergeAll(
      runtimeBaseServicesLive,
      OrchestrationCommandDispatcher.layer.pipe(Layer.provide(runtimeBaseServicesLive)),
    );
    // T3-CUSTOM(expbkt3): native plan review sits beside Plannotator; both read
    // the same proposed-plan events and neither depends on the other.
    const planReviewServicesLive = PlanReviewServiceLayer.layer.pipe(
      Layer.provide(PlanReviewDocuments.layer),
      Layer.provideMerge(runtimeServicesWithoutPlannotatorLive),
    );
    // T3-CUSTOM(expbkt3): agent-rendered UI surfaces. Only needs the sqlite
    // client, so it composes beside plan review rather than under it.
    const agentUiServicesLive = AgentUiServiceLayer.layer.pipe(
      Layer.provide(AgentUiRenders.layer),
      Layer.provideMerge(runtimeServicesWithoutPlannotatorLive),
    );
    const runtimeServicesLive = Layer.mergeAll(
      PlannotatorManager.layer.pipe(Layer.provideMerge(runtimeServicesWithoutPlannotatorLive)),
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
      runtimeStateLayer,
      tailscaleServeLayer,
      cloudDesiredLinkReconcileLayer,
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
