// T3-CUSTOM(expbkt3): source-control helpers use the same process service as upstream.
import * as VcsProcess from "./vcs/VcsProcess.ts";
// T3-CUSTOM(expbkt3): native shell and command access preserve team boundaries.
import { filterNativeShell, makeActiveShellView, owns } from "./wsV2Visibility.expbkt3.ts";
// T3-CUSTOM(expbkt3): a per-process id lets clients tell a reconnect from a server restart.
import { SERVER_INSTANCE_ID } from "./serverInstanceId.expbkt3.ts";
import { checkCommandAccess } from "./orchestration-v2/commandAccess.ts";
// T3-CUSTOM(expbkt3): native service dispatch reads the authenticated sender at execution.
import { CurrentOrchestrationActorUserId } from "./orchestration-v2/forkActor.expbkt3.ts";
// T3-CUSTOM(expbkt3): preserve caller-controlled metadata on native launches.
import { forkThreadLaunchMetadata } from "./orchestration-v2/forkThreadLaunch.expbkt3.ts";
// T3-CUSTOM(expbkt3): BEGIN team, credential, MCP, review and archive seams.
import { HttpClient } from "effect/http";
import {
  ProjectId,
  UserId,
  SourceControlProfileError,
  type SourceControlCloneRepositoryInput,
  type SourceControlPublishRepositoryInput,
  type SourceControlRepositoryLookupInput,
} from "@t3tools/contracts";
import * as OrchestrationEngine from "./orchestration-v2/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./orchestration-v2/Services/ProjectionSnapshotQuery.ts";
import { OrchestrationAccessControl } from "./orchestration-v2/Services/AccessControl.ts";
import { OrchestrationAccessControlLive } from "./orchestration-v2/Layers/AccessControl.ts";
import { ClerkDirectory, ClerkDirectoryLive } from "./auth/ClerkDirectory.ts";
import { makeForkWsHandlers } from "./wsForkHandlers.ts";
import { makeWsVisibility } from "./orchestration-v2/wsVisibility.ts";
import * as UserMcpProfileStore from "./mcp/UserMcpProfileStore.ts";
import { PlanReviewService } from "./planreview/PlanReviewService.ts";
import { AgentUiService } from "./agentui/AgentUiService.ts";
import { ThreadCommentsService } from "./threadcomments/ThreadCommentsService.ts";
import { ClaudeAccountsService } from "./claudeAccounts/ClaudeAccountsService.ts";
import * as SessionArchiveService from "./sessionArchive/SessionArchiveService.ts";
import * as EnvironmentUserService from "./auth/EnvironmentUserService.ts";
import * as SourceControlProfileService from "./sourceControl/SourceControlProfileService.ts";
import * as ThreadSourceControlActionLock from "./sourceControl/ThreadSourceControlActionLock.ts";
import {
  CurrentSourceControlExecutionEnvironment,
  withSourceControlExecutionEnvironment,
} from "./sourceControl/SourceControlExecutionEnvironment.ts";
import { githubSshRemoteToHttps } from "./sourceControl/GitHubRemoteUrl.ts";
// Client connection metadata, and what the web-UI bridge passes to makeAuthenticatedWsRpcHandlerLayer.
import type { OrchestrationClientOrigin } from "@t3tools/contracts";
import type * as PreviewAutomationBroker from "./mcp/PreviewAutomationBroker.ts";
// T3-CUSTOM(expbkt3): END
// T3-CUSTOM(expbkt3): access-denied secret and feedback answers report a missing request.
import { AgentFeedbackRequestError, SecretRequestError } from "@t3tools/contracts";
// T3-CUSTOM(expbkt3): members get empty workflow views and project-scoped issue reads.
import type { IssueListInput, WorkflowCounts, WorkflowRunsSnapshot } from "@t3tools/contracts";
import { GitCommandError, OrchestrationDispatchCommandError } from "@t3tools/contracts";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- A synchronous digest inside the pure provider mapping.
import * as NodeCrypto from "node:crypto";
import * as FeatureFlags from "@t3tools/shared/FeatureFlags";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeHttpServerRequest from "@effect/platform-node/NodeHttpServerRequest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Orchestrator from "./orchestration-v2/Orchestrator.ts";
import * as PeerClientPairing from "./peer/PeerClientPairing.ts";
import * as PeerLinkRequests from "./peer/PeerLinkRequests.ts";
import * as PeerLinks from "./peer/PeerLinks.ts";
import * as PeerThreadRelay from "./peer/PeerThreadRelay.ts";

import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Base64 from "effect/encoding/Base64";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { rpcInitialItems } from "./rpcInitialItems.ts";
import { subscribeChatGptHandoff } from "./provider/CodexChatGptHandoff.ts";
import {
  AcpRegistryOperationError,
  CommandId,
  authScopeResponse,
  AuthAccessStreamError,
  type AuthAccessStreamEvent,
  AuthOrchestrationOperateScope,
  AuthProvidersManageScope,
  type AuthEnvironmentScope,
  ProviderDriverKind,
  type ScheduledTaskListResult,
  WorkflowRequestError,
  AuthSessionId,
  ClientConnectionMethod,
  ClientDeviceType,
  ClientOs,
  ClientSurface,
  ClientWebDeployment,
  type DiscoveredLocalServerList,
  type EditorId,
  type FileManagerRevealKind,
  type OrchestrationV2Command,
  type GitActionProgressEvent,
  type GitManagerServiceError,
  type MessageId,
  type AcpRegistryDeleteSessionInput,
  type AcpRegistryDisableProviderInput,
  type AcpRegistryListProvidersInput,
  type AcpRegistryListSessionsInput,
  type AcpRegistrySetProviderInput,
  OrchestrationGetFullThreadDiffError,
  OrchestrationSearchThreadsError,
  OrchestrationV2SearchThreadError,
  // T3-CUSTOM(expbkt3): thread-gated stopWorkflow and subscribeCommandOutput failures.
  OrchestrationV2CommandOutputError,
  OrchestrationV2StopWorkflowError,
  OrchestrationV2ForceStopThreadError, // T3-CUSTOM(expbkt3): forceStopThread access gate.
  OrchestrationV2GetNativeChildWorkError, // T3-CUSTOM(expbkt3): getNativeChildWork access gate.
  OrchestrationGetTurnDiffError,
  ORCHESTRATION_V2_WS_METHODS,
  ORCHESTRATION_PROTOCOL_QUERY_PARAM,
  CLIENT_CAPABILITIES_QUERY_PARAM,
  SETTINGS_SECRET_REFERENCES_CAPABILITY,
  ORCHESTRATION_PROTOCOL_VERSION,
  OrchestrationV2DispatchCommandError,
  OrchestrationV2GetShellSnapshotError,
  OrchestrationV2GetThreadProjectionError,
  OrchestrationV2ThreadLaunchError,
  type OrchestrationProjectShell,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ShellStreamItem,
  type OrchestrationV2ThreadStreamItem,
  type ApplicationStoredEvent,
  type ProjectEntriesFailure,
  type ProjectFileFailure,
  type ProjectFileOperation,
  type ProjectMutation,
  ProjectListEntriesError,
  ProjectReadFileError,
  ProjectSearchContentsError,
  ProjectSearchEntriesError,
  ProjectWriteFileError,
  ProjectMutationError,
  McpAppRequestError, // T3-CUSTOM(expbkt3): MCP app thread-access denial.
  ProviderUploadFeedbackError,
  ProviderSetupError,
  RelayClientInstallFailedError,
  type RelayClientInstallProgressEvent,
  type ServerConfig as ClientServerConfig,
  type ServerConfigStreamEvent,
  type ServerLifecycleStreamEvent,
  type ServerProvider,
  serverProviderDeltas,
  type FilesystemBrowseFailure,
  FilesystemBrowseError,
  AssetWorkspaceContextNotFoundError,
  AssetWorkspaceContextResolutionError,
  SOURCE_CONTROL_MEDIA_ASSET,
  ChatAttachmentId,
  PersistChatAttachmentsError,
  RpcClientId,
  EnvironmentAuthorizationError,
  ThreadId,
  type TerminalMetadataStreamEvent,
  type PullRequestRef,
  WS_METHODS,
  WsRpcGroup,
  // T3-CUSTOM(expbkt3): compile native and fork handler layers separately.
  FORK_WS_RPCS,
} from "@t3tools/contracts";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerRespondable,
  HttpServerResponse,
} from "effect/http";
import { RpcGroup, RpcSerialization, RpcServer } from "effect/rpc";
import * as RpcSchema from "effect/rpc/RpcSchema"; // T3-CUSTOM(expbkt3): bridge scope check.

import * as CheckpointDiffQuery from "./checkpointing/CheckpointDiffQuery.ts";
import * as NativeChildWorkQuery from "./orchestration-v2/NativeChildWorkQuery.ts";
import * as ServerConfig from "./config.ts";
import * as EnvironmentTheme from "./environmentTheme.ts";
import * as Keybindings from "./keybindings.ts";
import * as ExternalLauncher from "./process/externalLauncher.ts";
import * as ThreadManagementService from "./orchestration-v2/ThreadManagementService.ts";
import * as ThreadViewers from "./orchestration-v2/ThreadViewers.ts";
import * as CommandOutputHub from "./orchestration-v2/CommandOutputHub.ts";
import * as McpAppRequests from "./mcpApps/McpAppRequests.ts";
import * as McpSignIn from "./mcpApps/McpSignIn.ts";
import * as ProviderSessionManager from "./orchestration-v2/ProviderSessionManager.ts";
import * as ThreadLaunchService from "./orchestration-v2/ThreadLaunchService.ts";
import * as ThreadMessageIntake from "./orchestration-v2/ThreadMessageIntake.ts";
import * as DocumentText from "./provider/DocumentText.ts";
import * as ScheduledTasks from "./scheduledTasks/ScheduledTaskService.ts";
import * as Workflows from "./workflows/Workflows.ts";
import * as WorkflowRuntime from "./workflows/WorkflowRuntime.ts";
import * as SecretRequests from "./secrets/SecretRequests.ts";
import * as FeedbackStore from "./feedback/FeedbackStore.ts";
import * as GuestShareService from "./guest/GuestShareService.ts";
import {
  bufferShellLiveStream,
  composeShellStreamWithEnrichment,
  dedupeShellEnrichment,
  loadOlderSettledThreadsPage,
  loadShellSnapshotParts,
  shellStreamItemFromEnrichmentRefresh,
  shellStreamItemsFromInitialSnapshot,
  loadSubscriberShellSnapshot,
  canResumeShellFrom,
  resumeIdentityRoots,
  shellStreamItemsFromResumeSnapshot,
  shouldPublishShellApplicationEvent,
} from "./orchestration-v2/ShellStream.ts";
// T3-CUSTOM(expbkt3): BEGIN — one shared shell feed per server (TEC-1837).
import {
  acquireShellFeed,
  readShellReplay,
  shellFeedSources,
  tapShellFeed,
  type ShellFeedBatch,
} from "./orchestration-v2/ShellFeed.expbkt3.ts";
// T3-CUSTOM(expbkt3): END
import { ORCHESTRATION_V2_PROJECTION_SCHEMA_VERSION } from "./orchestration-v2/ProjectionStore.ts";
import {
  coalesceLiveUpdatedEvents,
  coalesceThreadLiveStream,
} from "./orchestration-v2/ThreadLiveEventCoalescer.ts";
import {
  buildBoundedThreadStreamSnapshot,
  decideThreadResume,
  isThreadReplayRawPayloadSafe,
  threadReplayEncodedBytes,
  THREAD_RESUME_MAX_REPLAY_EVENTS,
} from "./orchestration-v2/ThreadStream.ts";
import {
  buildBoundedThreadProjection,
  THREAD_HISTORY_PAGE_POLICY,
  THREAD_HISTORY_SNAPSHOT_ROW_LIMIT,
} from "./orchestration-v2/threadHistoryPaging.ts";
import {
  makeLiveBodyDeduper,
  projectDomainEventForWire,
  projectThreadProjectionForWire,
  threadStreamEventItem,
} from "./orchestration-v2/WireProjection.ts";
import { dedupeSnapshotBodies } from "@t3tools/shared/orchestrationV2DedupedBodies";
import * as ProjectStore from "./orchestration-v2/ProjectStore.ts";
import * as ThreadSearch from "./orchestration-v2/ThreadSearch.ts";
import * as OrchestrationEventStore from "./persistence/OrchestrationEventStore.ts";
import { userFacingDispatchErrorMessage } from "./orchestration-v2/UserFacingErrors.ts";
import * as ProviderRegistry from "./provider/ProviderRegistry.ts";
import * as SecretCheck from "./secrets/SecretCheck.ts";
import * as AcpRegistrySessions from "./provider/AcpRegistrySessions.ts";
import * as ProviderInstanceRegistry from "./provider/ProviderInstanceRegistry.ts";
import * as AcpRegistrySupport from "@t3tools/provider-acp-registry/server/AcpRegistrySupport";
import * as AcpRegistryRuntimeCoordinator from "@t3tools/provider-acp-registry/server/AcpRegistryRuntimeCoordinator";
import * as ProviderMaintenanceRunner from "./provider/providerMaintenanceRunner.ts";
import * as ProviderAuthService from "./provider/ProviderAuthService.ts";
import * as ProviderInstallation from "./provider/providerInstallation.ts";
import * as ServerSelfUpdate from "./cloud/selfUpdate.ts";
import * as NpmRelease from "./cloud/npmRelease.ts";
import * as ServerLifecycleEvents from "./serverLifecycleEvents.ts";
import * as ServerRuntimeStartup from "./serverRuntimeStartup.ts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as ManagedProviders from "./policy/managedProviders.ts";
import * as ServerSettings from "./serverSettings.ts";
import { invalidateSettingsSecrets } from "./sourceControl/sourceControlHostSecrets.ts";
import * as DatabaseStorage from "./persistence/DatabaseStorage.ts";
import * as StorageCleanup from "./storageCleanup.ts";
import * as TerminalManager from "./terminal/Manager.ts";
import { makePrepareTerminalLaunch } from "./workspace/restoreMissingWorktree.ts";
import { terminalOutputStream, withOutputWindow } from "./terminal/OutputProtocol.ts";
import { withSocketHeartbeat } from "./socketHeartbeat.ts";
import * as ServerBrowser from "./preview/ServerBrowser.ts";
import * as DeviceService from "./device/DeviceService.ts";
import { remoteSshDeviceHosts } from "./device/localSshDeviceHost.ts";
import * as PreviewManager from "./preview/Manager.ts";
import { issueAssetUrl } from "./assets/AssetAccess.ts";
import {
  attachmentRelativePath,
  chatAttachmentStableKey,
  createDeterministicAttachmentId,
} from "./attachmentStore.ts";
import { parseBase64DataUrl } from "./imageMime.ts";
import { deletePendingAttachment, issueAttachmentUploadUrl } from "./assets/AttachmentUpload.ts";
import * as PortScanner from "./preview/PortScanner.ts";
import * as WorkspaceEntries from "./workspace/WorkspaceEntries.ts";
import * as WorkspaceFolders from "./workspace/WorkspaceFolders.ts";
import * as TaskFolders from "./workspace/TaskFolders.ts";
import * as KnownWorkspaces from "./workspace/KnownWorkspaces.ts";
import * as WorkspaceFileSystem from "./workspace/WorkspaceFileSystem.ts";
import { readWorkflowScript } from "./orchestration-v2/workflowScriptQuery.ts";
import * as WorkspacePaths from "./workspace/WorkspacePaths.ts";
import * as VcsStatusBroadcaster from "./vcs/VcsStatusBroadcaster.ts";
import * as VcsProvisioningService from "./vcs/VcsProvisioningService.ts";
import * as GitWorkflowService from "./git/GitWorkflowService.ts";
import { assertCheckoutIdle } from "./git/sharedCheckoutGuard.ts";
import { refreshPushedPullRequests } from "./git/refreshPushedPullRequests.ts";
import { linkCreatedPullRequest } from "./git/linkCreatedPullRequest.ts";
import * as ReviewService from "./review/ReviewService.ts";
import * as ProjectEnrichmentService from "./project/ProjectEnrichmentService.ts";
import * as ProjectService from "./project/ProjectService.ts";
import { threadWorkspaceRoot } from "./project/threadWorkspaceRoot.ts";
import * as ManagedProjectFolders from "./project/ManagedProjectFolders.ts";
import * as ScratchThreadPromotion from "./project/ScratchThreadPromotion.ts";
import { mutateProjectWithClone } from "./project/ProjectMutation.ts";
import * as ProjectCloneTracker from "./project/ProjectCloneTracker.ts";
import * as RepositoryIdentityResolver from "./project/RepositoryIdentityResolver.ts";
import * as WorktreeSetupTracker from "./project/WorktreeSetupTracker.ts";
import * as ServerEnvironment from "./environment/ServerEnvironment.ts";
import * as DirectEndpoints from "./environment/DirectEndpoints.ts";
import * as RemoteOpenTargets from "./environment/RemoteOpenTargets.ts";
import * as DefectReporter from "./observability/DefectReporter.ts";
import * as EventLoopMonitor from "./observability/EventLoopMonitor.ts";
import * as BackgroundPolicy from "./background/BackgroundPolicy.ts";
import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import { requiredScopeForDeviceList, rpcAuthorizationError } from "./auth/RpcAuthorization.ts";
import * as RpcAuthorization from "./auth/RpcAuthorization.ts";
import { RpcInstrumentation, rpcInstrumentationLayer } from "./observability/RpcInstrumentation.ts";
import * as ProcessDiagnostics from "./diagnostics/ProcessDiagnostics.ts";
import * as ProcessResourceMonitor from "./diagnostics/ProcessResourceMonitor.ts";
import * as ResourceTelemetry from "./resourceTelemetry/ResourceTelemetry.ts";
import * as HostResources from "./resourceTelemetry/HostResources.ts";
import * as AnalyticsService from "./telemetry/AnalyticsService.ts";
import { clientConnectionMode } from "./telemetry/serverEvents.ts"; // T3-CUSTOM(expbkt3)
import { commandFeatureUsage, featureUsage } from "./telemetry/FeatureUsage.ts";
import type { TelemetryOwner } from "./telemetry/Identify.ts";
import * as UsageService from "./usage/UsageService.ts";
import * as TraceDiagnostics from "./diagnostics/TraceDiagnostics.ts";
import * as TriageService from "./triage/TriageService.ts";
import * as PullRequestService from "./pullRequest/PullRequestService.ts";
import * as IssueService from "./issue/IssueService.ts";
import * as ThreadIssueService from "./orchestration-v2/ThreadIssueService.ts";
import * as IssueTrackerConnections from "./issue/IssueTrackerConnections.ts";
import * as PullRequestReviewGuideService from "./pullRequest/PullRequestReviewGuideService.ts";
import { listLinkedPullRequestThreads } from "./pullRequest/linkedThreads.ts";
import { pullRequestSyncKey } from "./pullRequest/pullRequestSyncKey.ts";
import * as SqlClient from "effect/sql/SqlClient";
import * as PullRequestSyncReactor from "./orchestration-v2/PullRequestSyncReactor.ts";
import * as SourceControlDiscovery from "./sourceControl/SourceControlDiscovery.ts";
import * as OtlpEndpointCheck from "./observability/OtlpEndpointCheck.ts";
import * as TextGenerators from "./textGeneration/TextGenerators.ts";
import * as SourceControlRepositoryService from "./sourceControl/SourceControlRepositoryService.ts";
import * as SourceControlSignIn from "./sourceControl/SourceControlSignIn.ts";
import * as SourceControlBuiltInDrivers from "./sourceControl/builtInDrivers.ts";
import * as SourceControlProviderRegistry from "./sourceControl/SourceControlProviderRegistry.ts";
import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "./vcs/VcsDriverRegistry.ts";
import * as VcsProjectConfig from "./vcs/VcsProjectConfig.ts";
import * as PairingGrantStore from "./auth/PairingGrantStore.ts";
import * as SessionStore from "./auth/SessionStore.ts";
import { failEnvironmentAuthInvalid, failEnvironmentInternal } from "./auth/http.ts";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import { isNetworkPath } from "@t3tools/shared/path";
import * as RelayClient from "@t3tools/shared/relayClient";
import {
  SOCKET_FRAME_PARTS_QUERY_PARAM,
  splitLargeSocketFrames,
} from "@t3tools/shared/socketFrameParts";
import { isTelemetryIdHash } from "@t3tools/shared/telemetryId";
import {
  sameUsageLimitCommandCoverage,
  withUsageLimitsCommands,
} from "@t3tools/shared/usageLimits";
import * as AgentSessionScanner from "./project/AgentSessionScanner.ts";
import * as AgentSessionImporter from "./project/AgentSessionImporter.ts";
import * as UsageLimitSources from "./usage/UsageLimitSources.ts";
import { requestUrl } from "./requestUrl.ts";

const CONFIG_DISCOVERY_TIMEOUT = Duration.seconds(5);
const isProviderUploadFeedbackError = Schema.is(ProviderUploadFeedbackError);

const resolveDiscoveryForConfig = <A, E, R>(
  discovery: Effect.Effect<A, E, R>,
  onTimeout: () => A,
) =>
  discovery.pipe(
    Effect.timeoutOption(CONFIG_DISCOVERY_TIMEOUT),
    Effect.map(Option.getOrElse(onTimeout)),
  );

const resolveAvailableEditorsForConfig = <A, E, R>(
  discovery: Effect.Effect<ReadonlyArray<A>, E, R>,
) => resolveDiscoveryForConfig(discovery, () => []);

const resolveFileManagerRevealKindForConfig = <E, R>(
  discovery: Effect.Effect<FileManagerRevealKind | undefined, E, R>,
) => resolveDiscoveryForConfig(discovery, () => undefined);

type EditorDiscovery = Pick<
  ExternalLauncher.ExternalLauncher["Service"],
  "resolveAvailableEditors" | "resolveFileManagerRevealKind"
>;

const resolveEditorConfig = Effect.fn("ws.resolveEditorConfig")(function* <E, R>(
  availableEditors: ReadonlyArray<EditorId>,
  revealKind: Effect.Effect<FileManagerRevealKind | undefined, E, R>,
) {
  const fileManagerRevealKind = availableEditors.includes("file-manager")
    ? yield* revealKind
    : undefined;
  return {
    availableEditors,
    ...(fileManagerRevealKind === undefined
      ? {}
      : {
          shellRevealInFileManager: true,
          shellRevealInFileManagerKind: fileManagerRevealKind,
        }),
  };
});

export const withLateConfigDiscovery = <E, R>(
  config: ClientServerConfig,
  liveUpdates: Stream.Stream<ServerConfigStreamEvent, E, R>,
  launcher: EditorDiscovery,
  remoteOpenTargets: RemoteOpenTargets.RemoteOpenTargets["Service"],
  directEndpoints: Pick<DirectEndpoints.DirectEndpoints["Service"], "resolve">,
) => {
  const lateEditorConfig = Stream.fromEffect(launcher.resolveAvailableEditors()).pipe(
    Stream.filter(
      (editors) =>
        editors.join() !== config.availableEditors.join() ||
        (editors.includes("file-manager") && config.shellRevealInFileManagerKind === undefined),
    ),
    // Unbounded, unlike the snapshot: this exists to deliver a probe that
    // outlasts the snapshot's timeout.
    Stream.mapEffect((editors) =>
      resolveEditorConfig(editors, launcher.resolveFileManagerRevealKind()),
    ),
    Stream.filter(
      (editorConfig) =>
        editorConfig.availableEditors.join() !== config.availableEditors.join() ||
        editorConfig.shellRevealInFileManagerKind !== config.shellRevealInFileManagerKind,
    ),
    Stream.map((editorConfig) => ({ type: "editorsResolved" as const, editorConfig })),
  );

  const lateRemoteOpenTargets = Stream.fromEffect(remoteOpenTargets.resolveTargets()).pipe(
    Stream.filter(
      (targets) => JSON.stringify(targets) !== JSON.stringify(config.remoteOpenTargets ?? []),
    ),
    Stream.map((targets) => ({ type: "remoteOpenTargetsResolved" as const, targets })),
  );

  const lateDirectEndpoints = Stream.fromEffect(directEndpoints.resolve()).pipe(
    Stream.catchCause(() => Stream.empty),
    Stream.map((endpoints) => ({ type: "directEndpointsResolved" as const, endpoints })),
  );

  return Stream.merge(
    liveUpdates,
    Stream.merge(lateEditorConfig, Stream.merge(lateRemoteOpenTargets, lateDirectEndpoints)),
  ).pipe(
    Stream.mapAccum(
      (): ClientServerConfig => config,
      (current, event): readonly [ClientServerConfig, ReadonlyArray<ServerConfigStreamEvent>] => {
        switch (event.type) {
          case "editorsResolved": {
            const {
              availableEditors: _editors,
              shellRevealInFileManager: _reveal,
              shellRevealInFileManagerKind: _revealKind,
              ...rest
            } = current;
            const next = { ...rest, ...event.editorConfig };
            return [next, [{ version: 1, type: "snapshot", config: next }]];
          }
          case "remoteOpenTargetsResolved": {
            const next = { ...current, remoteOpenTargets: event.targets };
            return [next, [{ version: 1, type: "snapshot", config: next }]];
          }
          case "directEndpointsResolved": {
            if (JSON.stringify(current.directEndpoints ?? []) === JSON.stringify(event.endpoints)) {
              return [current, []];
            }
            const next = { ...current, directEndpoints: event.endpoints };
            return [next, [{ version: 1, type: "snapshot", config: next }]];
          }
          case "keybindingsUpdated":
            return [{ ...current, ...event.payload }, [event]];
          case "providerStatuses":
            return [{ ...current, providers: event.payload.providers }, [event]];
          case "settingsUpdated":
            return [{ ...current, settings: event.payload.settings }, [event]];
          // Themes and usage-limit sources survive snapshots because snapshots never include them.
          default:
            return [current, [event]];
        }
      },
    ),
  );
};

// Discoveries run side by side so the slowest one, not their sum, bounds the
// server config snapshot. Each degrades on timeout rather than failing it.
export const resolveOpenDiscoveryForConfig = <T, D, E1, R1, E2, R2, E3, R3, E4, R4>(discovery: {
  readonly editors: Effect.Effect<ReadonlyArray<EditorId>, E1, R1>;
  readonly fileManagerRevealKind: Effect.Effect<FileManagerRevealKind | undefined, E2, R2>;
  readonly remoteOpenTargets: Effect.Effect<ReadonlyArray<T>, E3, R3>;
  readonly directEndpoints: Effect.Effect<ReadonlyArray<D>, E4, R4>;
}) =>
  Effect.all(
    {
      editorConfig: resolveAvailableEditorsForConfig(discovery.editors).pipe(
        Effect.flatMap((availableEditors) =>
          resolveEditorConfig(
            availableEditors,
            resolveFileManagerRevealKindForConfig(discovery.fileManagerRevealKind),
          ),
        ),
      ),
      // Same discovery-with-timeout treatment as editors: a slow probe must
      // not stall server.getConfig, so it degrades to an empty list.
      remoteOpenTargets: resolveAvailableEditorsForConfig(discovery.remoteOpenTargets),
      directEndpoints: resolveAvailableEditorsForConfig(discovery.directEndpoints),
    },
    { concurrency: "unbounded" },
  ).pipe(Effect.map(({ editorConfig, ...endpoints }) => ({ ...editorConfig, ...endpoints })));
// A failed scan leaves no cwd snapshot, so a client without the machine catalog gets it
// as a pending snapshot, which it shows while it retries the scan.
function workspaceSnapshotOrCatalog(
  provider: ServerProvider,
  cwd: string,
  catalogOnDemand: boolean,
) {
  const snapshots = (provider.workspaceSnapshots ?? []).filter((snapshot) => snapshot.cwd === cwd);
  if (snapshots.length > 0 || !catalogOnDemand) return snapshots;
  return [
    {
      cwd,
      checkedAt: provider.checkedAt,
      slashCommands: provider.slashCommands,
      slashCommandsPending: true,
      skills: provider.skills,
    },
  ];
}

// What an on-demand catalog client keeps of the machine catalog: full entries come from the
// cwd snapshot it fetches, and skill names and labels keep skill links working without one.
function machineCatalogNames(provider: Pick<ServerProvider, "slashCommands" | "skills">) {
  return {
    slashCommands: provider.slashCommands.map(({ name }) => ({ name })),
    skills: provider.skills.map(({ description: _d, shortDescription: _s, ...skill }) => skill),
  };
}

// Stable across restarts, so a client's cached lists stay current until the catalog changes.
// It covers the full entries: a changed description or input hint must reach the client too.
const machineCatalogDigest = (provider: Pick<ServerProvider, "slashCommands" | "skills">) =>
  NodeCrypto.createHash("sha256")
    .update(JSON.stringify([provider.slashCommands, provider.skills]))
    .digest("hex")
    .slice(0, 16);

// Names, or the digest that stands for them, still change the config when the machine catalog
// does, so the client refetches its cwd snapshot.
function withoutWorkspaceSnapshots(
  providers: ReadonlyArray<ServerProvider>,
  catalogsPerCwd: ReadonlySet<string> = new Set(),
  catalogDigests = false,
): ServerProvider[] {
  return providers.map(({ workspaceSnapshots: _workspaceSnapshots, ...provider }) => {
    if (!catalogsPerCwd.has(provider.instanceId)) return provider;
    return catalogDigests
      ? {
          ...provider,
          slashCommands: [],
          skills: [],
          catalogDigest: machineCatalogDigest(provider),
        }
      : { ...provider, ...machineCatalogNames(provider) };
  });
}

// Deltas are taken from the list this client last received, which a late snapshot replaces.
const withProviderStatusDeltas = (sent: ReadonlyArray<ServerProvider>) =>
  Stream.mapAccum(
    () => sent,
    (
      previous,
      event: ServerConfigStreamEvent,
    ): readonly [ReadonlyArray<ServerProvider>, ReadonlyArray<ServerConfigStreamEvent>] => {
      if (event.type === "snapshot") return [event.config.providers, [event]];
      if (event.type !== "providerStatuses") return [previous, [event]];
      const { providers } = event.payload;
      return [
        providers,
        [
          {
            version: 1,
            type: "providerStatusDeltas",
            payload: { providers: serverProviderDeltas(previous, providers) },
          },
        ],
      ];
    },
  );

function unexpectedCompatibilityError(error: never): never {
  throw new Error(`Unhandled compatibility error: ${String(error)}`);
}

const persistChatAttachments = Effect.fn("ws.assets.persistChatAttachments")(function* (input: {
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly attachments: ReadonlyArray<{
    readonly type: "image";
    readonly name: string;
    readonly mimeType: string;
    readonly sizeBytes: number;
    readonly dataUrl: string;
  }>;
}) {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* Effect.forEach(
    input.attachments.map((attachment, index) => ({ attachment, index })),
    Effect.fn("ws.assets.persistChatAttachment")(function* ({ attachment, index }) {
      const parsed = parseBase64DataUrl(attachment.dataUrl);
      if (parsed === null || parsed.mimeType !== attachment.mimeType.toLowerCase()) {
        return yield* new PersistChatAttachmentsError({
          message: `Attachment ${attachment.name} has an invalid image payload.`,
        });
      }
      const bytes = yield* Effect.fromResult(Base64.decode(parsed.base64)).pipe(
        Effect.mapError(
          (cause) =>
            new PersistChatAttachmentsError({
              message: `Attachment ${attachment.name} is not valid base64.`,
              cause,
            }),
        ),
      );
      if (bytes.byteLength !== attachment.sizeBytes) {
        return yield* new PersistChatAttachmentsError({
          message: `Attachment ${attachment.name} size does not match its payload.`,
        });
      }
      const rawId = createDeterministicAttachmentId(
        input.threadId,
        chatAttachmentStableKey(input.messageId, index, bytes),
      );
      if (rawId === null) {
        return yield* new PersistChatAttachmentsError({
          message: "Could not allocate an attachment identifier.",
        });
      }
      const persisted = {
        type: "image" as const,
        id: ChatAttachmentId.make(rawId),
        name: attachment.name,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
      };
      yield* fileSystem
        .writeFile(path.join(config.attachmentsDir, attachmentRelativePath(persisted)!), bytes)
        .pipe(
          Effect.mapError(
            (cause) =>
              new PersistChatAttachmentsError({
                message: `Could not persist attachment ${attachment.name}.`,
                cause,
              }),
          ),
        );
      return persisted;
    }),
    { concurrency: 2 },
  );
});

function projectEntriesFailureContext(error: WorkspaceEntries.WorkspaceEntriesError): {
  readonly failure: ProjectEntriesFailure;
  readonly normalizedCwd?: string;
  readonly timeout?: string;
  readonly detail?: string;
} {
  switch (error._tag) {
    case "WorkspaceRootNotExistsError":
      return {
        failure: "workspace_root_not_found",
        normalizedCwd: error.normalizedWorkspaceRoot,
      };
    case "WorkspaceRootCreateFailedError":
      return {
        failure: "workspace_root_create_failed",
        normalizedCwd: error.normalizedWorkspaceRoot,
      };
    case "WorkspaceRootStatFailedError":
      return {
        failure: "workspace_root_stat_failed",
        normalizedCwd: error.normalizedWorkspaceRoot,
        detail: error.phase,
      };
    case "WorkspaceRootNotDirectoryError":
      return {
        failure: "workspace_root_not_directory",
        normalizedCwd: error.normalizedWorkspaceRoot,
      };
    case "WorkspaceEntriesReadDirectoryError":
      return {
        failure: "directory_list_failed",
        ...(error.cwd !== undefined ? { normalizedCwd: error.cwd } : {}),
        detail: error.message,
      };
    case "WorkspaceSearchIndexCreateFailed":
      return {
        failure: "search_index_create_failed",
        normalizedCwd: error.cwd,
        detail: error.reason,
      };
    case "WorkspaceSearchIndexScanTimedOut":
      return {
        failure: "search_index_scan_timed_out",
        normalizedCwd: error.cwd,
        timeout: error.timeout,
      };
    case "WorkspaceSearchIndexSearchFailed":
      return {
        failure: "search_index_search_failed",
        normalizedCwd: error.cwd,
        detail: error.reason,
      };
    default:
      return unexpectedCompatibilityError(error);
  }
}

function filesystemBrowseFailureContext(error: WorkspaceEntries.WorkspaceEntriesBrowseError): {
  readonly failure: FilesystemBrowseFailure;
  readonly parentPath?: string;
  readonly platform?: string;
  readonly pathMissing?: boolean;
} {
  switch (error._tag) {
    case "WorkspaceEntriesWindowsPathUnsupportedError":
      return { failure: "windows_path_unsupported", platform: error.platform };
    case "WorkspaceEntriesCurrentProjectRequiredError":
      return { failure: "current_project_required" };
    case "WorkspaceEntriesReadDirectoryError":
      return {
        failure: "read_directory_failed",
        parentPath: error.parentPath,
        ...(error.pathMissing ? { pathMissing: true } : {}),
      };
    default:
      return unexpectedCompatibilityError(error);
  }
}

function projectFileFailureContext(
  error:
    | WorkspaceFileSystem.WorkspaceFileSystemError
    | WorkspacePaths.WorkspacePathOutsideRootError
    | KnownWorkspaces.UnknownWorkspaceError,
): {
  readonly failure: ProjectFileFailure;
  readonly resolvedPath?: string;
  readonly resolvedWorkspaceRoot?: string;
  readonly operation?: ProjectFileOperation;
  readonly operationPath?: string;
} {
  switch (error._tag) {
    case "WorkspacePathOutsideRootError":
    case "UnknownWorkspaceError":
      return { failure: "workspace_path_outside_root" };
    case "WorkspaceFileSystemOperationError":
      return {
        failure: "operation_failed",
        resolvedPath: error.resolvedPath,
        operation: error.operation,
        operationPath: error.operationPath,
      };
    case "WorkspaceFilePathEscapeError":
      return {
        failure: "resolved_path_outside_root",
        resolvedPath: error.resolvedPath,
        resolvedWorkspaceRoot: error.resolvedWorkspaceRoot,
      };
    case "WorkspacePathNotFileError":
      return { failure: "path_not_file", resolvedPath: error.resolvedPath };
    case "WorkspaceBinaryFileError":
      return { failure: "binary_file", resolvedPath: error.resolvedPath };
    default:
      return unexpectedCompatibilityError(error);
  }
}

const PROVIDER_STATUS_DEBOUNCE_MS = 200;

// Middleware added later wraps middleware added earlier, so instrumentation wraps authorization.
const ServerWsRpcGroup = WsRpcGroup.middleware(RpcInstrumentation);
// T3-CUSTOM(expbkt3): preserve one protocol while bounding native/fork handler inference.
const ForkWsRpcGroup = RpcGroup.make(...FORK_WS_RPCS);
const NativeWsRpcGroup = WsRpcGroup.omit(...FORK_WS_RPCS.map((rpc) => rpc._tag));

// RpcGroup.toLayer derives each handler's requirements by scanning every RPC in
// the group, so its type cost grows with handlers × RPCs. Near 200 methods that
// crosses TypeScript's instantiation limit and the layer's requirements degrade to
// `any`, so the handlers are registered as two disjoint, smaller groups.
/* T3-CUSTOM(expbkt3): split only the native group; fork RPCs use ForkWsRpcGroup. */
type ServerWsRpc = RpcGroup.Rpcs<typeof NativeWsRpcGroup>;
const SPLIT_WS_RPC_PREFIXES = [
  "server",
  "pullRequests",
  "issues",
  "issueTrackers",
  "provider",
  "orchestration",
] as const;
type SplitWsRpc = Extract<
  ServerWsRpc,
  { readonly _tag: `${(typeof SPLIT_WS_RPC_PREFIXES)[number]}.${string}` }
>;
const isSplitWsRpc = (rpc: ServerWsRpc): rpc is SplitWsRpc =>
  SPLIT_WS_RPC_PREFIXES.some((prefix) => rpc._tag.startsWith(`${prefix}.`));
const isOtherWsRpc = (rpc: ServerWsRpc): rpc is Exclude<ServerWsRpc, SplitWsRpc> =>
  !isSplitWsRpc(rpc);
const serverWsRpcs = Array.from(NativeWsRpcGroup.requests.values()); // T3-CUSTOM(expbkt3)
const SplitWsRpcGroup = RpcGroup.make(...serverWsRpcs.filter(isSplitWsRpc));
const OtherWsRpcGroup = RpcGroup.make(...serverWsRpcs.filter(isOtherWsRpc));
function toAuthAccessStreamEvent(
  change: Exclude<
    PairingGrantStore.BootstrapCredentialChange | SessionStore.SessionCredentialChange,
    { readonly type: "connectDevicesChanged" }
  >,
  revision: number,
  currentSessionId: AuthSessionId,
): AuthAccessStreamEvent {
  switch (change.type) {
    case "pairingLinkUpserted":
      return {
        version: 1,
        revision,
        type: "pairingLinkUpserted",
        payload: { ...change.pairingLink, ...authScopeResponse(change.pairingLink.scopes) },
      };
    case "pairingLinkRemoved":
      return {
        version: 1,
        revision,
        type: "pairingLinkRemoved",
        payload: { id: change.id },
      };
    case "clientUpserted":
      return {
        version: 1,
        revision,
        type: "clientUpserted",
        payload: {
          ...change.clientSession,
          ...authScopeResponse(change.clientSession.scopes),
          current: change.clientSession.sessionId === currentSessionId,
        },
      };
    case "clientRemoved":
      return {
        version: 1,
        revision,
        type: "clientRemoved",
        payload: { sessionId: change.sessionId },
      };
  }
}

const isClientSurface = Schema.is(ClientSurface);
const isClientConnectionMethod = Schema.is(ClientConnectionMethod);
const isClientDeviceType = Schema.is(ClientDeviceType);
const isClientOs = Schema.is(ClientOs);
const isClientWebDeployment = Schema.is(ClientWebDeployment);
const MAX_CLIENT_APP_VERSION_LENGTH = 64;
const MAX_CLIENT_BROWSER_LENGTH = 64;
const MAX_CLIENT_DEVICE_MODEL_LENGTH = 80;

function hasCompatibleOrchestrationProtocol(url: URL): boolean {
  return (
    url.searchParams.get(ORCHESTRATION_PROTOCOL_QUERY_PARAM) ===
    String(ORCHESTRATION_PROTOCOL_VERSION)
  );
}

function readSettingsClient(url: URL) {
  const capabilities = url.searchParams.get(CLIENT_CAPABILITIES_QUERY_PARAM)?.split(",") ?? [];
  return { secretReferences: capabilities.includes(SETTINGS_SECRET_REFERENCES_CAPABILITY) };
}

function shouldUseBoundedThreadSnapshot(input: {
  readonly acceptBoundedSnapshot?: boolean;
  readonly acceptDeferredWork?: boolean;
}): boolean {
  return input.acceptBoundedSnapshot === true;
}

// T3-CUSTOM(expbkt3): BEGIN — upstream deleted this with recordClientConnection; the fork
// still stores the connecting client's surface and app version on its session.
function readClientConnectionOrigin(
  request: HttpServerRequest.HttpServerRequest,
): OrchestrationClientOrigin {
  const url = requestUrl(request);
  if (Option.isNone(url)) {
    return {};
  }
  const surface = url.value.searchParams.get("clientSurface");
  const appVersion = url.value.searchParams.get("clientAppVersion")?.trim() ?? "";
  return {
    ...(isClientSurface(surface) ? { surface } : {}),
    ...(appVersion !== "" && appVersion.length <= MAX_CLIENT_APP_VERSION_LENGTH
      ? { appVersion }
      : {}),
  };
}
// T3-CUSTOM(expbkt3): END

// Keep telemetry per socket; several client types can connect simultaneously.
function readClientAnalyticsProps(request: HttpServerRequest.HttpServerRequest) {
  const url = requestUrl(request);
  if (Option.isNone(url)) {
    return {};
  }

  const surface = url.value.searchParams.get("clientSurface");
  const appVersion = url.value.searchParams.get("clientAppVersion")?.trim() ?? "";
  const deviceType = url.value.searchParams.get("clientDeviceType");
  const os = url.value.searchParams.get("clientOs");
  const webDeployment = url.value.searchParams.get("clientWebDeployment");
  const browser = url.value.searchParams.get("clientBrowser")?.trim() ?? "";
  const connectionMethod = url.value.searchParams.get("connectionMethod");
  const rawOsMajorVersion = url.value.searchParams.get("clientOsMajorVersion") ?? "";
  const osMajorVersion = Number(rawOsMajorVersion);
  const deviceModel = url.value.searchParams.get("clientDeviceModel")?.trim() ?? "";
  const isMobile = surface === "mobile";
  const hasOsMajorVersion =
    isMobile && rawOsMajorVersion !== "" && Number.isInteger(osMajorVersion) && osMajorVersion > 0;
  const hasDeviceModel =
    isMobile && deviceModel !== "" && deviceModel.length <= MAX_CLIENT_DEVICE_MODEL_LENGTH;

  return {
    ...(isClientSurface(surface) ? { surface } : {}),
    ...(appVersion !== "" && appVersion.length <= MAX_CLIENT_APP_VERSION_LENGTH
      ? { appVersion, clientAppVersion: appVersion }
      : {}),
    ...(isClientOs(os)
      ? {
          clientOs: os,
          ...(isMobile && (os === "iOS" || os === "Android") ? { os } : {}),
        }
      : {}),
    ...(isClientDeviceType(deviceType) ? { clientDeviceType: deviceType } : {}),
    ...(surface === "web" && isClientWebDeployment(webDeployment) ? { webDeployment } : {}),
    ...(surface === "web" && browser !== "" && browser.length <= MAX_CLIENT_BROWSER_LENGTH
      ? { clientBrowser: browser }
      : {}),
    ...(hasOsMajorVersion ? { osMajorVersion, clientOsMajorVersion: osMajorVersion } : {}),
    ...(hasDeviceModel ? { deviceModel, clientDeviceModel: deviceModel } : {}),
    ...(isClientConnectionMethod(connectionMethod) ? { connectionMethod } : {}),
  };
}

/**
 * Owners a connecting client reports: its hashed T3 Connect account and its
 * hashed device id. Only hashes are accepted, so a raw id never reaches analytics.
 */
function readClientOwners(
  request: HttpServerRequest.HttpServerRequest,
): ReadonlyArray<TelemetryOwner> {
  const url = requestUrl(request);
  if (Option.isNone(url)) {
    return [];
  }
  const params = url.value.searchParams;
  return (
    [
      ["connect", params.get("clientOwner")],
      ["device", params.get("clientDevice")],
    ] as const
  ).flatMap(([source, ownerId]) =>
    ownerId !== null && isTelemetryIdHash(ownerId) ? [{ source, ownerId }] : [],
  );
}

const enrichProjectShells = Effect.fn("ws.orchestrationV2.enrichProjectShells")(
  (projects: ReadonlyArray<OrchestrationProjectShell>) =>
    Effect.flatMap(ProjectEnrichmentService.ProjectEnrichmentService, (projectEnrichment) =>
      Effect.forEach(
        projects,
        (project) =>
          projectEnrichment.getAvailable(project.workspaceRoot).pipe(
            Effect.map((enrichment) => ({
              project: {
                ...project,
                repositoryIdentity: enrichment.repositoryIdentity,
              },
              repositoryIdentityResolved: enrichment.repositoryIdentityResolved,
            })),
          ),
        { concurrency: 16 },
      ).pipe(
        Effect.map((enriched) => ({
          projects: enriched.map((entry) => entry.project),
          resolvedRepositoryIdentityRoots: enriched
            .filter((entry) => entry.repositoryIdentityResolved)
            .map((entry) => entry.project.workspaceRoot),
        })),
      ),
    ),
);

export const subscribeOrchestrationV2Thread = Effect.fn("ws.orchestrationV2.subscribeThread")(
  function* (input: {
    readonly threadId: ThreadId;
    readonly afterSequence?: number;
    readonly requestCompletionMarker?: boolean;
    readonly acceptBoundedSnapshot?: boolean;
    readonly acceptDeferredWork?: boolean;
    readonly acceptCompactTurnItems?: boolean;
    readonly acceptDedupedBodies?: boolean;
    readonly acceptCompactIds?: boolean;
  }) {
    const threadManagement = yield* ThreadManagementService.ThreadManagementService;
    const dedupeBodies = input.acceptDedupedBodies === true;
    // Replay, snapshot, and live tail share one deduper: it must see every delivered record.
    const withLiveDedupe = <E, R>(stream: Stream.Stream<OrchestrationV2ThreadStreamItem, E, R>) =>
      dedupeBodies ? Stream.suspend(() => Stream.map(stream, makeLiveBodyDeduper())) : stream;
    const applicationEvents = yield* OrchestrationEventStore.OrchestrationEventStore;

    yield* Effect.annotateCurrentSpan({
      "orchestration_v2.thread_id": input.threadId,
    });
    yield* threadManagement.ensureLegacyTranscript(input.threadId).pipe(
      Effect.mapError(
        (cause) =>
          new OrchestrationV2GetThreadProjectionError({
            threadId: input.threadId,
            message: `Failed to hydrate migrated thread ${input.threadId}`,
            cause,
          }),
      ),
    );

    const eventStreamFrom = (afterSequence: number) =>
      threadManagement
        .streamStoredEventsFrom({
          threadId: input.threadId,
          afterSequence,
        })
        .pipe(
          Stream.map(threadStreamEventItem),
          coalesceThreadLiveStream,
          Stream.mapError(
            (cause) =>
              new OrchestrationV2GetThreadProjectionError({
                threadId: input.threadId,
                message: `Failed while streaming orchestration V2 thread ${input.threadId}`,
                cause,
              }),
          ),
        );

    const loadReplayThrough = (afterSequence: number, throughSequence: number) =>
      applicationEvents
        .readAgentEvents({
          threadId: input.threadId,
          afterSequence,
          throughSequence,
          limit: THREAD_RESUME_MAX_REPLAY_EVENTS + 1,
          // Downgrades can leave unknown rows; skip them and resume live from highWater so later events survive.
          skipUnknownEventTypes: true,
        })
        .pipe(
          Stream.map((stored) => ({
            kind: "event" as const,
            sequence: stored.sequence,
            event: projectDomainEventForWire(stored.event),
          })),
          Stream.runCollect,
          Effect.map((items) => Array.from(items)),
          Effect.mapError(
            (cause) =>
              new OrchestrationV2GetThreadProjectionError({
                threadId: input.threadId,
                message: `Failed while replaying orchestration V2 thread ${input.threadId}`,
                cause,
              }),
          ),
        );

    const completionMarker =
      input.requestCompletionMarker === true
        ? Stream.make({ kind: "synchronized" as const })
        : Stream.empty;

    const snapshotThenLive = Effect.fn("ws.orchestrationV2.threadSnapshotThenLive")(function* () {
      const useBoundedSnapshot = shouldUseBoundedThreadSnapshot(input);
      const snapshot = yield* (
        useBoundedSnapshot
          ? threadManagement.getThreadSnapshotWindow(input.threadId, {
              rowLimit: THREAD_HISTORY_SNAPSHOT_ROW_LIMIT,
              deferWork: input.acceptDeferredWork === true,
              userTurnLimit: THREAD_HISTORY_PAGE_POLICY.maxUserTurns,
            })
          : threadManagement.getThreadSnapshot(input.threadId)
      ).pipe(
        Effect.mapError(
          (cause) =>
            new OrchestrationV2GetThreadProjectionError({
              threadId: input.threadId,
              message: `Failed to load orchestration V2 thread ${input.threadId}`,
              cause,
            }),
        ),
      );
      const { snapshotSequence } = snapshot;
      const snapshotItem = useBoundedSnapshot
        ? buildBoundedThreadStreamSnapshot({
            ...snapshot,
            compactTurnItems: input.acceptCompactTurnItems === true,
            dedupeBodies,
            compactIds: input.acceptCompactIds === true,
          })
        : (() => {
            const projection = projectThreadProjectionForWire(snapshot.projection);
            return {
              kind: "snapshot" as const,
              snapshotSequence,
              projection: dedupeBodies ? dedupeSnapshotBodies(projection) : projection,
            };
          })();
      return rpcInitialItems([snapshotItem]).pipe(
        Stream.concat(completionMarker),
        Stream.concat(eventStreamFrom(snapshotSequence)),
        withLiveDedupe,
      );
    });

    // Subscribe before reading persisted events to retain concurrent publishes; clients dedupe overlap by sequence.
    if (input.afterSequence !== undefined) {
      const highWater = yield* applicationEvents.latestAgentSequence(input.threadId).pipe(
        Effect.mapError(
          (cause) =>
            new OrchestrationV2GetThreadProjectionError({
              threadId: input.threadId,
              message: `Failed to prepare orchestration V2 thread ${input.threadId} replay`,
              cause,
            }),
        ),
      );
      const prunedThrough = yield* applicationEvents.prunedThroughSequence.pipe(
        Effect.mapError(
          (cause) =>
            new OrchestrationV2GetThreadProjectionError({
              threadId: input.threadId,
              message: `Failed to prepare orchestration V2 thread ${input.threadId} replay`,
              cause,
            }),
        ),
      );
      // An idle thread's cursor sits at its own high-water: nothing was missed, so replay nothing.
      if (
        input.afterSequence > highWater ||
        (input.afterSequence < highWater && input.afterSequence < prunedThrough)
      ) {
        return yield* snapshotThenLive();
      }
      const stats = yield* applicationEvents
        .getAgentReplayStats({
          threadId: input.threadId,
          afterSequence: input.afterSequence,
          throughSequence: highWater,
          maxEvents: THREAD_RESUME_MAX_REPLAY_EVENTS,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new OrchestrationV2GetThreadProjectionError({
                threadId: input.threadId,
                message: `Failed to measure orchestration V2 thread ${input.threadId} replay`,
                cause,
              }),
          ),
        );
      // Bound stored and projected payload bytes separately; neither bounds process memory.
      if (
        stats.eventCount > THREAD_RESUME_MAX_REPLAY_EVENTS ||
        !isThreadReplayRawPayloadSafe(stats.rawPayloadBytes)
      ) {
        return yield* snapshotThenLive();
      }
      if (stats.hasCreateEvent) {
        const shell = yield* threadManagement.getThreadShell(input.threadId).pipe(
          Effect.mapError(
            (cause) =>
              new OrchestrationV2GetThreadProjectionError({
                threadId: input.threadId,
                message: `Failed to locate recreated orchestration V2 thread ${input.threadId}`,
                cause,
              }),
          ),
        );
        // Retained creation events may describe deleted threads; replace replay only if a snapshot exists.
        if (shell !== null) return yield* snapshotThenLive();
      }
      const replayed = yield* loadReplayThrough(input.afterSequence, highWater);
      // Pruning publishes its boundary before deleting, so a pass during the read shows up here.
      if (
        input.afterSequence < highWater &&
        input.afterSequence <
          (yield* applicationEvents.prunedThroughSequence.pipe(
            Effect.mapError(
              (cause) =>
                new OrchestrationV2GetThreadProjectionError({
                  threadId: input.threadId,
                  message: `Failed to prepare orchestration V2 thread ${input.threadId} replay`,
                  cause,
                }),
            ),
          ))
      ) {
        return yield* snapshotThenLive();
      }
      // A deleted thread reads as gone: its replay starts at the deletion.
      const deletion = replayed.findLastIndex((item) => item.event.type === "thread.deleted");
      const replay = coalesceLiveUpdatedEvents(
        deletion === -1 ? replayed : replayed.slice(deletion),
      );
      const plan = decideThreadResume({
        afterSequence: input.afterSequence,
        highWater,
        replayEventCount: replay.length,
        replayEncodedBytes: threadReplayEncodedBytes(replay),
      });
      if (plan.mode === "snapshot") {
        return yield* snapshotThenLive();
      }
      return rpcInitialItems(replay).pipe(
        Stream.concat(completionMarker),
        Stream.concat(eventStreamFrom(highWater)),
        withLiveDedupe,
      );
    }

    return yield* snapshotThenLive();
  },
);

export const subscribeOrchestrationV2Shell = Effect.fn("ws.orchestrationV2.subscribeShell")(
  // T3-CUSTOM(expbkt3): BEGIN — the shared shell feed is filtered for this user inside the stream.
  function* (
    input: {
      readonly afterSequence?: number;
      readonly httpSnapshotFallback?: true;
      readonly knownProjectIdentities?: string;
      readonly requestCompletionMarker?: boolean;
      readonly omitIdleSubagents?: boolean;
      readonly omitOlderSettled?: boolean;
    },
    options: { readonly actor?: UserId | null } = {},
  ) {
    // T3-CUSTOM(expbkt3): END
    const sql = yield* SqlClient.SqlClient;
    const threadManagement = yield* ThreadManagementService.ThreadManagementService;
    const applicationEvents = yield* OrchestrationEventStore.OrchestrationEventStore;
    const projects = yield* ProjectStore.ProjectStoreV2;
    const projectService = yield* ProjectService.ProjectService;
    const projectEnrichment = yield* ProjectEnrichmentService.ProjectEnrichmentService;
    let subagentThreadIds = new Set<string>();
    const filterSubagentTranscript = (stored: ApplicationStoredEvent) =>
      shouldPublishShellApplicationEvent(stored, subagentThreadIds);

    const enrichmentChanges = yield* projectEnrichment.subscribeChanges;
    const loadProjectMetadataSnapshot = Effect.fn("ws.orchestrationV2.loadProjectMetadataSnapshot")(
      function* (snapshotSequence: number) {
        const enriched = yield* enrichProjectShells(yield* projects.listShells());
        return {
          snapshot: {
            schemaVersion: ORCHESTRATION_V2_PROJECTION_SCHEMA_VERSION,
            snapshotSequence,
            projects: enriched.projects,
            threads: [],
            archivedThreads: [],
          } as OrchestrationV2ShellSnapshot,
          resolvedRepositoryIdentityRoots: enriched.resolvedRepositoryIdentityRoots,
        };
      },
    );
    const loadSnapshot = Effect.fn("ws.orchestrationV2.loadShellSnapshot")(function* () {
      const forSubscriber = yield* loadSubscriberShellSnapshot({
        sql,
        listShellIndex: threadManagement.listActiveShellIndex(),
        readThreads: (threadIds) =>
          threadManagement.readShellSnapshot({
            location: "active",
            ...(threadIds === undefined ? {} : { threadIds }),
          }),
        listProjects: projects.listShells(),
        latestSequence: applicationEvents.latestApplicationSequence,
        options: {
          omitIdleSubagents: input.omitIdleSubagents === true,
          // T3-CUSTOM(expbkt3): the per-user view needs every settled thread; trimmed counts and
          // pages are computed across all users, and the fork sidebar has no settled pager.
          omitOlderSettled: false,
        },
      });
      subagentThreadIds = forSubscriber.subagentThreadIds;
      const enriched = yield* enrichProjectShells(forSubscriber.snapshot.projects);
      return {
        snapshot: {
          ...forSubscriber.snapshot,
          projects: enriched.projects,
        } as OrchestrationV2ShellSnapshot,
        resolvedRepositoryIdentityRoots: enriched.resolvedRepositoryIdentityRoots,
      };
    });
    // T3-CUSTOM(expbkt3): BEGIN — one shared shell feed per server (TEC-1837). Each touched thread
    // is read once per batch for every client, not once per client, and text deltas read nothing.
    const actor = options.actor ?? null;
    const feedServices = {
      sql,
      eventStore: applicationEvents,
      readThreadShells: threadManagement.getThreadShells,
      getProject: projectService.getShell,
      listProjects: projects.listShells,
    };
    const feed = yield* acquireShellFeed(feedServices).pipe(
      Effect.mapError(
        (cause) =>
          new OrchestrationV2GetShellSnapshotError({
            message: "Failed to start the application shell feed",
            cause,
          }),
      ),
    );
    // Subscribe before any snapshot load, so a batch published after this reaches the client.
    // The tap drains into a bounded per-client buffer at once, so a client still receiving its
    // snapshot, or withholding acknowledgements, cannot make the shared feed retain batches.
    const tap = yield* tapShellFeed(feed);
    // The tick lets an idle client converge on a shell that changed only its `updatedAt`, from
    // memory: it reads nothing.
    const idleTicks = Stream.tick(Duration.seconds(5)).pipe(
      Stream.map((): ShellFeedBatch => ({ highSequence: 0, entries: [] })),
    );
    const liveFrom = (view: ReturnType<typeof makeActiveShellView>) =>
      bufferShellLiveStream(
        Stream.merge(Stream.fromEffectRepeat(tap.take), idleTicks).pipe(
          Stream.mapEffect(view.apply),
          Stream.flattenIterable,
        ),
      );
    // T3-CUSTOM(expbkt3): END

    const enrichmentRefreshes = Stream.fromSubscription(enrichmentChanges).pipe(
      Stream.filter((change) => change.repositoryIdentityResolved),
      Stream.groupedWithin(64, Duration.millis(25)),
      Stream.mapEffect((changes) =>
        Effect.gen(function* () {
          const identities = new Map(
            Array.from(changes, (change) => [
              change.workspaceRoot,
              change.enrichment.repositoryIdentity,
            ]),
          );
          const snapshotSequence = yield* applicationEvents.latestApplicationSequence;
          const changedProjects = (yield* projects.listShells()).flatMap((project) =>
            identities.has(project.workspaceRoot)
              ? [{ ...project, repositoryIdentity: identities.get(project.workspaceRoot) ?? null }]
              : [],
          );
          return shellStreamItemFromEnrichmentRefresh({
            snapshot: {
              schemaVersion: ORCHESTRATION_V2_PROJECTION_SCHEMA_VERSION,
              snapshotSequence,
              projects: changedProjects,
              threads: [],
              archivedThreads: [],
            } as OrchestrationV2ShellSnapshot,
            changes: Array.from(changes),
          });
        }),
      ),
    );

    // Subscribe before loading for racing enrichments; initial refresh covers pre-subscription completions and cold HTTP snapshots.
    const completionMarker =
      input.requestCompletionMarker === true
        ? Stream.make({ kind: "synchronized" as const })
        : Stream.empty;
    const initialSnapshotItems = (loaded: {
      readonly snapshot: OrchestrationV2ShellSnapshot;
      readonly resolvedRepositoryIdentityRoots: ReadonlyArray<string>;
    }) =>
      rpcInitialItems(
        shellStreamItemsFromInitialSnapshot({
          snapshot: loaded.snapshot,
          resolvedRepositoryIdentityRoots: loaded.resolvedRepositoryIdentityRoots,
        }),
      );
    const initialEnrichmentItems = (loaded: {
      readonly snapshot: OrchestrationV2ShellSnapshot;
      readonly resolvedRepositoryIdentityRoots: ReadonlyArray<string>;
    }) =>
      rpcInitialItems(
        shellStreamItemsFromResumeSnapshot({
          snapshot: loaded.snapshot,
          resolvedRepositoryIdentityRoots: loaded.resolvedRepositoryIdentityRoots,
        }),
      );
    // T3-CUSTOM(expbkt3): BEGIN — snapshot and live tail share one per-user view of the feed.
    // The initial frame always drains first; enrichment merges only with the post-prefix
    // tail, so a marked refresh cannot interleave before the authoritative initial frame.
    const snapshotThenLive = Effect.gen(function* () {
      const loaded = yield* loadSnapshot();
      const snapshot = filterNativeShell(loaded.snapshot, actor);
      const view = makeActiveShellView({
        actor,
        afterSequence: snapshot.snapshotSequence,
        projects: snapshot.projects,
        threads: snapshot.threads,
        feed,
        projectService,
      });
      return composeShellStreamWithEnrichment({
        initial: initialSnapshotItems({ ...loaded, snapshot }),
        tail: Stream.concat(completionMarker, liveFrom(view)),
        enrichment: enrichmentRefreshes.pipe(Stream.map(view.filterEnrichment)),
      });
    });

    const stream = yield* Effect.gen(function* () {
      if (input.afterSequence === undefined) {
        return yield* snapshotThenLive;
      }
      const afterSequence = input.afterSequence;
      const snapshotRequired: Stream.Stream<OrchestrationV2ShellStreamItem> = Stream.make({
        kind: "snapshot-required",
      });
      const fromSnapshot =
        input.httpSnapshotFallback === true ? Effect.succeed(snapshotRequired) : snapshotThenLive;
      const highWater = yield* applicationEvents.latestApplicationSequence;
      if (!(yield* canResumeShellFrom(applicationEvents, afterSequence, highWater))) {
        return yield* fromSnapshot;
      }

      // A filtered user may only be told to remove rows it could see at its cursor. When the
      // feed cannot prove which rows those were (it started, or forgot a change, after that
      // cursor), resend a filtered snapshot instead of replaying the gap.
      const held = actor === null ? undefined : feed.visibleAt(actor, afterSequence);
      if (actor !== null && held === undefined) {
        return yield* fromSnapshot;
      }

      subagentThreadIds = new Set(yield* threadManagement.listActiveSubagentThreadIds());

      const loaded = yield* loadProjectMetadataSnapshot(highWater);
      // Read before replying: the range is budgeted above, and a prune pass during the read
      // publishes its boundary first, so the recheck below catches deleted rows.
      const replayed = yield* applicationEvents
        .readApplicationEvents({
          afterSequence,
          throughSequence: highWater,
          // A row a newer build wrote (e.g. after a downgrade) must not fail
          // every shell resubscribe. The live tail below resumes from
          // highWater, so a dropped row never hides later events.
          skipUnknownEventTypes: true,
        })
        .pipe(Stream.filter(filterSubagentTranscript), Stream.runCollect);
      if (
        afterSequence < highWater &&
        afterSequence < (yield* applicationEvents.prunedThroughSequence)
      ) {
        return yield* fromSnapshot;
      }
      const snapshot = filterNativeShell(loaded.snapshot, actor);
      const view = makeActiveShellView({
        actor,
        afterSequence: highWater,
        projects: snapshot.projects,
        threads: [],
        // An unrestricted operator may hold any row, so it gets every removal.
        ...(held === undefined ? { removeUnheld: true } : { held }),
        feed,
        projectService,
      });
      // One batched read of the distinct threads in the gap, not one read per event.
      const replay = Stream.unwrap(
        readShellReplay({
          events: Stream.fromIterable(replayed),
          reads: shellFeedSources(feedServices),
        }).pipe(Effect.flatMap(view.applyReplay), Effect.map(rpcInitialItems)),
      );
      return composeShellStreamWithEnrichment({
        initial: initialEnrichmentItems({
          snapshot,
          resolvedRepositoryIdentityRoots: resumeIdentityRoots({
            projects: snapshot.projects,
            resolvedRepositoryIdentityRoots: loaded.resolvedRepositoryIdentityRoots,
            knownProjectIdentities: input.knownProjectIdentities,
          }),
        }),
        tail: Stream.concat(Stream.concat(replay, completionMarker), liveFrom(view)),
        enrichment: enrichmentRefreshes.pipe(Stream.map(view.filterEnrichment)),
      });
      // T3-CUSTOM(expbkt3): END
    }).pipe(
      Effect.mapError(
        (cause) =>
          new OrchestrationV2GetShellSnapshotError({
            message: "Failed to prepare the application shell stream",
            cause,
          }),
      ),
    );

    return stream.pipe(
      dedupeShellEnrichment,
      Stream.mapError(
        (cause) =>
          new OrchestrationV2GetShellSnapshotError({
            message: "Failed while streaming the application shell",
            cause,
          }),
      ),
    );
  },
);

export const layerWsRpc = (
  currentSession: EnvironmentAuth.AuthenticatedSession,
  clientAnalyticsProps: Readonly<Record<string, unknown>>,
  serverBrowser: ServerBrowser.ServerBrowser["Service"],
  reportProfiles: ServerBrowser.ProfileReporter,
  settingsClient: { readonly secretReferences: boolean },
) =>
  // T3-CUSTOM(expbkt3): both handler groups capture the same connection services.
  Layer.unwrap(
    Effect.gen(function* () {
      const currentSessionId = currentSession.sessionId;
      const sql = yield* SqlClient.SqlClient;
      const threadManagement = yield* ThreadManagementService.ThreadManagementService;
      const intakeContext = yield* Effect.context<
        | ThreadManagementService.ThreadManagementService
        | ThreadLaunchService.ThreadLaunchService
        | FileSystem.FileSystem
        | ServerConfig.ServerConfig
        | ServerSettings.ServerSettingsService
        | DocumentText.DocumentText
      >();
      const applicationEvents = yield* OrchestrationEventStore.OrchestrationEventStore;
      const projectStore = yield* ProjectStore.ProjectStoreV2;
      const projectService = yield* ProjectService.ProjectService;
      const managedFolders = yield* ManagedProjectFolders.ManagedProjectFolders;
      const scratchThreadPromotion = yield* ScratchThreadPromotion.ScratchThreadPromotion;
      const eventLoopMonitor = yield* EventLoopMonitor.EventLoopMonitor;
      const threadSearch = yield* ThreadSearch.ThreadSearch;

      const providerSessionsV2 = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const mcpAppRequests = yield* McpAppRequests.McpAppRequests;
      const mcpSignIn = yield* McpSignIn.McpSignIn;
      const analytics = yield* AnalyticsService.AnalyticsService;
      const originProps = clientAnalyticsProps;
      // T3-CUSTOM(expbkt3): client events carry the signed-in user (TEC-1631).
      const analyticsUser =
        currentSession.userId === null ? undefined : { userId: currentSession.userId };
      const recordClientCommandAnalytics = (command: OrchestrationV2Command) => {
        const usage = commandFeatureUsage(command);
        return Effect.all(
          [
            command.type === "message.dispatch"
              ? // T3-CUSTOM(expbkt3): client events carry the signed-in user (TEC-1631).
                analytics.record("client.turn.requested", originProps, analyticsUser)
              : Effect.void,
            usage === undefined
              ? Effect.void
              : analytics.record("feature.used", {
                  ...usage,
                  ...(originProps.surface === undefined ? {} : { surface: originProps.surface }),
                }),
          ],
          { discard: true },
        ).pipe(Effect.ignore);
      };
      const threadLaunch = yield* ThreadLaunchService.ThreadLaunchService;
      const commandOutputHub = yield* CommandOutputHub.CommandOutputHub;
      const threadViewers = yield* ThreadViewers.ThreadViewers;
      const providerSessionManager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const scheduledTasks = yield* ScheduledTasks.ScheduledTaskService;
      const workflows = yield* Workflows.Workflows;
      const workflowDefinitions = yield* WorkflowRuntime.WorkflowDefinitions;
      // The service's messages are built from its own attributes, so they are safe to send.
      const toWorkflowRequestError = (error: Workflows.WorkflowError) =>
        new WorkflowRequestError({ message: error.message });
      const secretRequests = yield* SecretRequests.SecretRequests;
      const feedbackStore = yield* FeedbackStore.FeedbackStore;
      const guestShares = yield* GuestShareService.GuestShareService;
      const pullRequests = yield* PullRequestService.PullRequestService;
      const issues = yield* IssueService.IssueService;
      const threadIssues = yield* ThreadIssueService.ThreadIssueService;
      const issueTrackers = yield* IssueTrackerConnections.IssueTrackerConnections;
      const reviewGuides = yield* PullRequestReviewGuideService.PullRequestReviewGuideService;
      const pullRequestSync = yield* PullRequestSyncReactor.PullRequestSyncReactor;
      const deviceService = yield* DeviceService.DeviceService;
      const deviceHostContext =
        yield* Effect.context<Effect.Services<ReturnType<typeof remoteSshDeviceHosts>>>();
      // T3-CUSTOM(expbkt3): BEGIN the transport user controls visibility and credentials.
      const nativeOrchestrator = yield* Orchestrator.OrchestratorV2;
      const accessControl = yield* OrchestrationAccessControl;
      const clerkDirectory = yield* ClerkDirectory;
      const actorUserId = Option.getOrNull(
        accessControl.actorFor(currentSession.subject, currentSession.userId),
      );
      const orchestrationEngine = {
        ...nativeOrchestrator,
        dispatch: (command: OrchestrationV2Command) =>
          nativeOrchestrator.dispatch(command, { actorUserId }),
      };
      const legacyEngine = yield* OrchestrationEngine.OrchestrationEngineService;
      const projectionSnapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
      const personalMcpUserId = actorUserId ?? UserId.make("local-user");
      const personalMcpProfiles = yield* UserMcpProfileStore.UserMcpProfileStore;
      const httpClient = yield* HttpClient.HttpClient;
      const actorIsAdmin =
        actorUserId === null ? false : yield* clerkDirectory.isOrgAdmin(actorUserId);
      const { visibleAggregateIdsForActor, requireThreadAccess } = makeWsVisibility({
        projectionSnapshotQuery,
        accessControl,
        actorUserId,
        actorIsAdmin,
      });
      const gitVcsDriver = yield* GitVcsDriver.GitVcsDriver; // T3-CUSTOM(expbkt3): HTTPS/profile validation.
      const sourceControlProfiles = yield* SourceControlProfileService.SourceControlProfileService;
      const sourceControlActionLock =
        yield* ThreadSourceControlActionLock.ThreadSourceControlActionLock;
      const sessionArchive = yield* SessionArchiveService.SessionArchiveService;
      const environmentUsers = yield* EnvironmentUserService.EnvironmentUserService;
      // T3-CUSTOM(expbkt3): END

      const random = yield* SecureRandom.SecureRandom;
      // RPC client ids are only unique within one socket; terminals share viewers across sockets.
      const terminalViewerPrefix = yield* random.uuidV4();
      const terminalViewerId = (metadata: { readonly client: { readonly id: number } }) =>
        `${terminalViewerPrefix}:${metadata.client.id}`;
      const serverCommandId = (tag: string) =>
        random.uuidV4().pipe(
          Effect.orDie,
          Effect.map((id) => CommandId.make(`server:${tag}:${id}`)),
        );
      const resolvePullRequestSyncKey = (reference: PullRequestRef) =>
        reference.host !== undefined && reference.repository.includes("/")
          ? Effect.succeed(pullRequestSyncKey(reference))
          : projectService.getShell(reference.projectId).pipe(
              Effect.map((project) =>
                pullRequestSyncKey(reference, Option.getOrUndefined(project)?.repositoryIdentity),
              ),
              Effect.orElseSucceed(() => null),
            );
      const usage = yield* UsageService.UsageService;
      const usageLimitSources = yield* UsageLimitSources.UsageLimitSources;
      const worktreeSetupTracker = yield* WorktreeSetupTracker.WorktreeSetupTracker;
      const projectCloneTracker = yield* ProjectCloneTracker.ProjectCloneTracker;
      const repositoryIdentityResolver =
        yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
      const projectEnrichment = yield* ProjectEnrichmentService.ProjectEnrichmentService;
      const agentSessionScanner = yield* AgentSessionScanner.AgentSessionScanner;
      const agentSessionImporter = yield* AgentSessionImporter.AgentSessionImporter;
      const checkpointDiffQuery = yield* CheckpointDiffQuery.CheckpointDiffQuery;
      const nativeChildWork = yield* NativeChildWorkQuery.NativeChildWorkQuery;
      const keybindings = yield* Keybindings.Keybindings;
      const featureFlags = yield* FeatureFlags.FeatureFlags;
      const environmentTheme = yield* EnvironmentTheme.EnvironmentThemeService;
      const externalLauncher = yield* ExternalLauncher.ExternalLauncher;
      const remoteOpenTargets = yield* RemoteOpenTargets.RemoteOpenTargets;
      const directEndpoints = yield* DirectEndpoints.DirectEndpoints;
      const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
      const review = yield* ReviewService.ReviewService;
      const vcsProvisioning = yield* VcsProvisioningService.VcsProvisioningService;
      const vcsStatusBroadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      const terminalManager = yield* TerminalManager.TerminalManager;
      const prepareTerminalLaunch = yield* makePrepareTerminalLaunch(
        threadManagement.getThreadShell,
      );
      const previewManager = yield* PreviewManager.PreviewManager;
      const portDiscovery = yield* PortScanner.PortDiscovery;
      const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
      const providerInstances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
      const acpRegistryCatalog = yield* AcpRegistrySupport.AcpRegistryCatalog;
      const acpRegistryRuntimeCoordinator =
        yield* AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator;
      const acpRegistrySessions = yield* AcpRegistrySessions.AcpRegistrySessions;
      const providerMaintenanceRunner = yield* ProviderMaintenanceRunner.ProviderMaintenanceRunner;
      const providerAuth = yield* ProviderAuthService.ProviderAuthService;
      const providerInstallation = yield* ProviderInstallation.ProviderInstallation;
      const serverSelfUpdate = yield* ServerSelfUpdate.ServerSelfUpdate;
      const npmRelease = yield* NpmRelease.NpmRelease;
      const config = yield* ServerConfig.ServerConfig;
      const lifecycleEvents = yield* ServerLifecycleEvents.ServerLifecycleEvents;
      const storageCleanup = yield* StorageCleanup.StorageCleanup;
      const databaseStorage = yield* DatabaseStorage.DatabaseStorage;
      const serverSettings = yield* ServerSettings.ServerSettingsService;
      const secretResolver = yield* SecretResolver.SecretResolver;
      const peerLinks = yield* PeerLinks.PeerLinks;
      const peerLinkRequests = yield* PeerLinkRequests.PeerLinkRequests;
      const peerThreadRelay = yield* PeerThreadRelay.PeerThreadRelay;
      const peerClientPairing = yield* PeerClientPairing.PeerClientPairing;
      const startup = yield* ServerRuntimeStartup.ServerRuntimeStartup;
      const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
      const workspaceFolders = yield* WorkspaceFolders.WorkspaceFolders;
      const taskFolders = yield* TaskFolders.TaskFolders;
      const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
      const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
      const backgroundPolicy = yield* BackgroundPolicy.BackgroundPolicy;
      const rpcClientIds = yield* Ref.make(new Set<RpcClientId>());
      yield* Effect.addFinalizer(() =>
        Ref.get(rpcClientIds).pipe(
          Effect.flatMap((clientIds) =>
            Effect.forEach(
              clientIds,
              (clientId) => backgroundPolicy.removeRpcClient(currentSessionId, clientId),
              {
                discard: true,
              },
            ),
          ),
          Effect.ignore,
        ),
      );
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      // T3-CUSTOM(expbkt3): BEGIN native plan review connection state.
      const planReview = yield* PlanReviewService;
      // T3-CUSTOM(expbkt3): agent-rendered UI surfaces in chat.
      const agentUi = yield* AgentUiService;
      // T3-CUSTOM(expbkt3): review comments on assistant messages in chat.
      const threadComments = yield* ThreadCommentsService;
      // T3-CUSTOM(expbkt3): Claude account profiles per thread.
      const claudeAccounts = yield* ClaudeAccountsService;
      // Resolved once per connection: it only labels this actor's own comments.
      const actorLabel =
        actorUserId === null
          ? null
          : yield* clerkDirectory.listOrgMembers().pipe(
              Effect.map((members) => {
                const member = members.find((user) => user.id === actorUserId);
                return member?.name ?? member?.email ?? null;
              }),
              Effect.orElseSucceed(() => null),
            );
      // T3-CUSTOM(expbkt3): END native plan review connection state.
      const sourceControlDiscovery = yield* SourceControlDiscovery.SourceControlDiscovery;
      const secretCheck = yield* SecretCheck.SecretCheck;
      const otlpEndpointCheck = yield* OtlpEndpointCheck.OtlpEndpointCheck;
      const textGenerators = yield* TextGenerators.TextGenerators;
      const sourceControlRepositories =
        yield* SourceControlRepositoryService.SourceControlRepositoryService;
      const sourceControlSignIn = yield* SourceControlSignIn.SourceControlSignIn;
      const withPullRequestViewer = pullRequests.withRoutingCredential;
      // The panel's reads for a pull request the user opened go out during a rate-limit pause.
      const openedPullRequestRead = Effect.provideService(SourceControlRateLimit.Interactive, true);
      const bootstrapCredentials = yield* PairingGrantStore.PairingGrantStore;
      const sessions = yield* SessionStore.SessionStore;
      const processDiagnostics = yield* ProcessDiagnostics.ProcessDiagnostics;
      const triage = yield* TriageService.TriageService;
      const hostResources = yield* HostResources.HostResources;
      const processResourceMonitor = yield* ProcessResourceMonitor.ProcessResourceMonitor;
      const resourceTelemetry = yield* ResourceTelemetry.ResourceTelemetry;
      const relayClient = yield* RelayClient.RelayClient;
      // Webhook URLs start agents; expose them only to operate-scoped sessions while keeping tasks readable.
      const withVisibleWebhookUrls = (result: ScheduledTaskListResult): ScheduledTaskListResult =>
        currentSession.scopes.includes(AuthOrchestrationOperateScope)
          ? result
          : {
              ...result,
              tasks: result.tasks.map(({ webhook: _webhook, ...task }) => task),
            };
      const authorizeEffect = <A, E, R>(
        requiredScope: AuthEnvironmentScope,
        effect: Effect.Effect<A, E, R>,
      ): Effect.Effect<A, E | EnvironmentAuthorizationError, R> =>
        currentSession.scopes.includes(requiredScope)
          ? effect
          : Effect.fail(rpcAuthorizationError(requiredScope));

      // T3-CUSTOM(expbkt3): BEGIN — native ACP session tools preserve project access.
      const acpRegistryProject = Effect.fn("ws.acpRegistry.project")(function* (
        projectId: AcpRegistryListSessionsInput["projectId"],
      ) {
        if (
          actorUserId !== null &&
          !(yield* accessControl
            .canAccessProject(actorUserId, projectId)
            .pipe(Effect.orElseSucceed(() => false)))
        )
          return yield* new AcpRegistryOperationError({
            reason: "project_not_found",
            message: "Project not found.",
          });
        return yield* acpRegistrySessions.project(projectId);
      });
      // T3-CUSTOM(expbkt3): END

      const listAcpRegistrySessions = Effect.fn("ws.acpRegistry.listSessions")(function* (
        input: AcpRegistryListSessionsInput,
      ) {
        // T3-CUSTOM(expbkt3): resolve the project through the fork's access check.
        const project = yield* acpRegistryProject(input.projectId);
        const { instance, manager } = yield* acpRegistrySessions.sessionManager(input.instanceId);
        // Only a probed agent advertises listing, so a read never installs or first-starts one.
        const snapshot = yield* instance.snapshot.getSnapshot;
        if (snapshot.nativeSessions?.canList !== true) {
          return yield* new AcpRegistryOperationError({
            reason: "session_list_unsupported",
            message: "The ACP agent does not advertise session listing.",
          });
        }
        const listed = yield* manager.listSessions({
          cwd: project.workspaceRoot,
          ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
        });
        const sessions = yield* Effect.forEach(
          listed.sessions,
          (session) => {
            const idInput = {
              driver: instance.driverKind,
              instanceId: input.instanceId,
              sessionId: session.sessionId,
            };
            return acpRegistrySessions.findOwner(idInput).pipe(
              Effect.flatMap((owner) => {
                const threadId = owner ?? AcpRegistrySessions.importedThreadId(idInput);
                return threadManagement.getThreadShell(threadId).pipe(
                  Effect.map((thread) => ({
                    ...session,
                    importedThreadId: thread === null ? null : threadId,
                    ...(thread !== null &&
                    AgentSessionImporter.isNativeHistoryPending({
                      historyOrigin: thread.historyOrigin,
                      hasRun: thread.latestRunId !== null,
                    })
                      ? { nativeHistoryPending: true }
                      : {}),
                  })),
                  Effect.mapError(
                    (cause) =>
                      new AcpRegistryOperationError({
                        reason: "session_import_failed",
                        message: "Could not inspect existing imported ACP sessions.",
                        cause,
                      }),
                  ),
                );
              }),
            );
          },
          { concurrency: 16 },
        );
        return { ...listed, sessions };
      });

      const deleteAcpRegistrySession = Effect.fn("ws.acpRegistry.deleteSession")(function* (
        input: AcpRegistryDeleteSessionInput,
      ) {
        return yield* acpRegistryRuntimeCoordinator.withSessionMutation(
          Effect.gen(function* () {
            // T3-CUSTOM(expbkt3): resolve the project through the fork's access check.
            const project = yield* acpRegistryProject(input.projectId);
            const { instance, manager } = yield* acpRegistrySessions.sessionManager(
              input.instanceId,
            );
            const snapshot = yield* instance.snapshot.getSnapshot;
            if (snapshot.nativeSessions?.canDelete !== true) {
              return yield* new AcpRegistryOperationError({
                reason: "session_delete_unsupported",
                message: "The ACP agent does not advertise session deletion.",
              });
            }
            const idInput = {
              driver: instance.driverKind,
              instanceId: input.instanceId,
              sessionId: input.sessionId,
            };
            const threadId =
              (yield* acpRegistrySessions.findOwner(idInput)) ??
              AcpRegistrySessions.importedThreadId(idInput);
            const importedThread = yield* threadManagement.getThreadShell(threadId).pipe(
              Effect.mapError(
                (cause) =>
                  new AcpRegistryOperationError({
                    reason: "session_delete_failed",
                    message: "Could not inspect the imported ACP session mapping.",
                    cause,
                  }),
              ),
            );
            if (importedThread !== null) {
              return yield* new AcpRegistryOperationError({
                reason: "session_delete_failed",
                message: "Delete the imported T3 thread before deleting its native ACP session.",
              });
            }
            yield* manager.deleteSession({
              cwd: project.workspaceRoot,
              sessionId: input.sessionId,
            });
            return { deleted: true } as const;
          }),
        );
      });

      const listAcpRegistryProviders = Effect.fn("ws.acpRegistry.listProviders")(function* (
        input: AcpRegistryListProvidersInput,
      ) {
        // T3-CUSTOM(expbkt3): resolve the project through the fork's access check.
        const project = yield* acpRegistryProject(input.projectId);
        const { instance, manager } = yield* acpRegistrySessions.sessionManager(input.instanceId);
        const snapshot = yield* instance.snapshot.getSnapshot;
        if (snapshot.configurableProviders !== true) {
          return yield* new AcpRegistryOperationError({
            reason: "providers_unsupported",
            message: "The ACP agent does not advertise provider configuration.",
          });
        }
        return yield* manager.listProviders(project.workspaceRoot);
      });

      const setAcpRegistryProvider = Effect.fn("ws.acpRegistry.setProvider")(function* (
        input: AcpRegistrySetProviderInput,
      ) {
        // T3-CUSTOM(expbkt3): resolve the project through the fork's access check.
        const project = yield* acpRegistryProject(input.projectId);
        const { manager } = yield* acpRegistrySessions.sessionManager(input.instanceId);
        if (input.headers !== undefined && Object.keys(input.headers).length > 32) {
          return yield* new AcpRegistryOperationError({
            reason: "provider_configuration_failed",
            message: "ACP provider configuration accepts at most 32 headers.",
          });
        }
        const listed = yield* manager.listProviders(project.workspaceRoot);
        const provider = listed.providers.find(
          (candidate) => candidate.providerId === input.providerId,
        );
        if (provider === undefined || !provider.supported.includes(input.apiType)) {
          return yield* new AcpRegistryOperationError({
            reason: "provider_configuration_failed",
            message: `Provider ${input.providerId} does not support ${input.apiType}.`,
          });
        }
        yield* providerSessionManager.closeInstance(input.instanceId).pipe(
          Effect.mapError(
            (cause) =>
              new AcpRegistryOperationError({
                reason: "provider_configuration_failed",
                message: "Could not stop live sessions before updating the ACP provider.",
                cause,
              }),
          ),
        );
        yield* manager.setProvider({
          cwd: project.workspaceRoot,
          providerId: input.providerId,
          apiType: input.apiType,
          baseUrl: input.baseUrl,
          ...(input.headers === undefined ? {} : { headers: input.headers }),
        });
        yield* providerRegistry.refreshInstance(input.instanceId);
        return { configured: true } as const;
      });

      const disableAcpRegistryProvider = Effect.fn("ws.acpRegistry.disableProvider")(function* (
        input: AcpRegistryDisableProviderInput,
      ) {
        // T3-CUSTOM(expbkt3): resolve the project through the fork's access check.
        const project = yield* acpRegistryProject(input.projectId);
        const { manager } = yield* acpRegistrySessions.sessionManager(input.instanceId);
        const listed = yield* manager.listProviders(project.workspaceRoot);
        const provider = listed.providers.find(
          (candidate) => candidate.providerId === input.providerId,
        );
        if (provider === undefined || provider.required) {
          return yield* new AcpRegistryOperationError({
            reason: "provider_configuration_failed",
            message:
              provider === undefined
                ? `Provider ${input.providerId} was not advertised by the ACP agent.`
                : `Provider ${input.providerId} is required and cannot be disabled.`,
          });
        }
        yield* providerSessionManager.closeInstance(input.instanceId).pipe(
          Effect.mapError(
            (cause) =>
              new AcpRegistryOperationError({
                reason: "provider_configuration_failed",
                message: "Could not stop live sessions before disabling the ACP provider.",
                cause,
              }),
          ),
        );
        yield* manager.disableProvider({
          cwd: project.workspaceRoot,
          providerId: input.providerId,
        });
        yield* providerRegistry.refreshInstance(input.instanceId);
        return { disabled: true } as const;
      });
      // T3-CUSTOM(expbkt3): BEGIN — RpcInstrumentation middleware traces every RPC.
      // These wrappers keep the fork RPC handlers' scope check, which repeats
      // RpcScopeAuthorization because the MCP web-UI bridge
      // (mcp/toolkits/webUi/bridge.ts) calls these handlers without the RPC server middleware.
      const authorizeStream = <A, E, R>(
        requiredScope: AuthEnvironmentScope,
        stream: Stream.Stream<A, E, R>,
      ): Stream.Stream<A, E | EnvironmentAuthorizationError, R> =>
        currentSession.scopes.includes(requiredScope)
          ? stream
          : Stream.fail(rpcAuthorizationError(requiredScope));
      const observeRpcEffect = <A, E, R>(
        method: string,
        effect: Effect.Effect<A, E, R>,
        traceAttributes?: Readonly<Record<string, unknown>>,
      ) =>
        authorizeEffect(
          RpcAuthorization.requiredScopeForRpcMethod(method),
          traceAttributes === undefined
            ? effect
            : Effect.annotateCurrentSpan(traceAttributes).pipe(Effect.andThen(effect)),
        ).pipe(Effect.provideService(CurrentOrchestrationActorUserId, actorUserId));
      const observeRpcStream = <A, E, R>(
        method: string,
        stream: Stream.Stream<A, E, R>,
        _traceAttributes?: Readonly<Record<string, unknown>>,
      ) =>
        authorizeStream(RpcAuthorization.requiredScopeForRpcMethod(method), stream).pipe(
          Stream.provideService(CurrentOrchestrationActorUserId, actorUserId),
        );
      // A denied caller sees the same answer as a tool call with no app.
      const requireMcpAppThreadAccess = (threadId: ThreadId) =>
        requireThreadAccess(threadId).pipe(
          Effect.mapError(
            (cause) => new McpAppRequestError({ threadId, reason: "not-an-app", cause }),
          ),
        );
      // Native handlers no longer pass through these wrappers, so the bridge-path scope
      // check is applied to the whole handler map: a method this session may not call is
      // replaced by a failure before any handler code runs.
      const withSessionScopeCheck = <H extends object>(group: H): H => {
        const denied = Object.keys(group).flatMap((method) => {
          const requiredScope = RpcAuthorization.requiredScopeForRpcMethod(method);
          if (currentSession.scopes.includes(requiredScope)) return [];
          const rpc = WsRpcGroup.requests.get(method);
          const stream = rpc !== undefined && RpcSchema.isStreamSchema(rpc.successSchema);
          const error = rpcAuthorizationError(requiredScope);
          return [[method, () => (stream ? Stream.fail(error) : Effect.fail(error))] as const];
        });
        return denied.length === 0 ? group : { ...group, ...Object.fromEntries(denied) };
      };
      // T3-CUSTOM(expbkt3): END
      const loadAuthAccessSnapshot = () =>
        Effect.all({
          pairingLinks: serverAuth.listPairingLinks(),
          clientSessions: serverAuth.listClientSessions(currentSessionId),
          connectDevices: serverAuth.listConnectDevices(),
        }).pipe(
          Effect.mapError(
            (error) =>
              new AuthAccessStreamError({
                message: error.message,
              }),
          ),
        );

      const loadServerConfig = Effect.fn("ws.loadServerConfig")(function* (options: {
        readonly usageLimitsCommand: boolean;
        readonly workspaceSnapshotsOnDemand: boolean;
        readonly deferNetworkDiscovery: boolean;
        readonly catalogsPerCwd?: ReadonlySet<string>;
        readonly catalogDigests?: boolean;
      }) {
        const keybindingsConfig = yield* keybindings.loadConfigState;
        const currentProviders = yield* providerRegistry.getProviders;
        const commandProviders = options.usageLimitsCommand
          ? withUsageLimitsCommands(currentProviders, yield* usageLimitSources.current)
          : currentProviders;
        const providers = options.workspaceSnapshotsOnDemand
          ? withoutWorkspaceSnapshots(
              commandProviders,
              options.catalogsPerCwd,
              options.catalogDigests,
            )
          : commandProviders;
        const settings = ServerSettings.redactServerSettingsForClient(
          yield* serverSettings.getSettings,
          settingsClient,
        );
        const environment = yield* serverEnvironment.getDescriptor;
        const auth = yield* serverAuth.getDescriptor();
        const scratchWorkspaceRoot = yield* managedFolders.scratchRoot;
        const lastEventLoopStall = yield* eventLoopMonitor.latestNoticeableStall;
        const discovery = yield* resolveOpenDiscoveryForConfig({
          editors: externalLauncher.resolveAvailableEditors(),
          fileManagerRevealKind: externalLauncher.resolveFileManagerRevealKind(),
          remoteOpenTargets: options.deferNetworkDiscovery
            ? Effect.succeed([])
            : remoteOpenTargets.resolveTargets(),
          directEndpoints: options.deferNetworkDiscovery
            ? directEndpoints.resolveAvailable()
            : directEndpoints.resolve(),
        });

        return {
          environment,
          auth,
          cwd: config.cwd,
          hostname: yield* HostProcess.Hostname,
          keybindingsConfigPath: config.keybindingsConfigPath,
          keybindings: keybindingsConfig.keybindings,
          issues: keybindingsConfig.issues,
          providers,
          ...discovery,
          observability: {
            logsDirectoryPath: config.logsDir,
            localTracingEnabled: true,
            ...(config.otlpTracesUrl !== undefined
              ? {
                  otlpTracesUrl: config.otlpTracesUrl,
                  otlpTracesSource: config.otlpTracesSource,
                  otlpTracesVariable: config.otlpTracesVariable,
                }
              : {}),
            otlpTracesEnabled: config.otlpTracesUrl !== undefined,
            ...(config.otlpMetricsUrl !== undefined
              ? {
                  otlpMetricsUrl: config.otlpMetricsUrl,
                  otlpMetricsSource: config.otlpMetricsSource,
                  otlpMetricsVariable: config.otlpMetricsVariable,
                }
              : {}),
            otlpMetricsEnabled: config.otlpMetricsUrl !== undefined,
            ...(config.otlpLogsUrl !== undefined
              ? {
                  otlpLogsUrl: config.otlpLogsUrl,
                  otlpLogsSource: config.otlpLogsSource,
                  otlpLogsVariable: config.otlpLogsVariable,
                }
              : {}),
            otlpLogsEnabled: config.otlpLogsUrl !== undefined,
          },
          settings,
          // T3-CUSTOM(expbkt3): clients resume the shell cursor only on the same server instance.
          serverInstanceId: SERVER_INSTANCE_ID,
          ...(serverSettings.managedPolicy === undefined
            ? {}
            : { managedPolicy: serverSettings.managedPolicy }),
          shellResumeCompletionMarker: true,
          shellThreadFamilies: true,
          threadLinkMetadata: true,
          shellOlderSettled: true,
          threadResumeCompletionMarker: true,
          threadSnapshotPagination: true,
          threadFind: true,
          threadFindProgressive: true,
          secretProviderSettings: true,
          secretReferences: true,
          secretRequestReferences: true,
          featureFlags: {
            secretProviders: featureFlags.secretProviders,
            tanstackSource: featureFlags.tanstackSource,
          },
          ...Option.match(scratchWorkspaceRoot, {
            onNone: () => ({}),
            onSome: (root) => ({ scratchWorkspaceRoot: root }),
          }),
          newProjectsRoot: managedFolders.namedProjectsRoot,
          ...(lastEventLoopStall === undefined ? {} : { lastEventLoopStall }),
          serverTime: DateTime.formatIso(yield* DateTime.now),
        };
      });

      const refreshGitStatus = (cwd: string) =>
        vcsStatusBroadcaster
          .refreshStatus(cwd)
          .pipe(Effect.ignoreCause({ log: true }), Effect.forkDetach, Effect.asVoid);

      const getOrchestrationV2ArchivedShellSnapshot = Effect.gen(function* () {
        const { threads, projects, snapshotSequence } = yield* loadShellSnapshotParts({
          sql,
          readThreads: threadManagement.readShellSnapshot({ location: "archive" }),
          listProjects: projectStore.listShells(),
          latestSequence: applicationEvents.latestApplicationSequence,
        });
        return {
          schemaVersion: threads.schemaVersion,
          snapshotSequence,
          projects,
          threads: threads.archivedThreads,
        } as const;
      }).pipe(
        Effect.flatMap((snapshot) =>
          enrichProjectShells(snapshot.projects).pipe(
            Effect.map(({ projects }) => ({ ...snapshot, projects })),
          ),
        ),
        Effect.mapError(
          (cause) =>
            new OrchestrationV2GetShellSnapshotError({
              message: "Failed to load archived thread snapshot",
              cause,
            }),
        ),
      );

      // Rows the shell can omit, read with the same snapshot sequence the shell uses.
      const readOmittableShellRows = Effect.fn("ws.orchestrationV2.readOmittableShellRows")(
        function* (
          options: { readonly familyOf: ThreadId } | { readonly worktreePath: string },
          message: string,
        ) {
          const { threads, snapshotSequence } = yield* loadShellSnapshotParts({
            sql,
            readThreads: threadManagement.readShellSnapshot({ location: "active", ...options }),
            listProjects: Effect.succeed([]),
            latestSequence: applicationEvents.latestApplicationSequence,
          }).pipe(
            Effect.mapError(
              (cause) => new OrchestrationV2GetShellSnapshotError({ message, cause }),
            ),
          );
          return { snapshotSequence, threads: threads.threads };
        },
      );
      // T3-CUSTOM(expbkt3): shell rows a filtered user may see, for upstream's omittable-row reads.
      const visibleShellThreads = <T extends Parameters<typeof owns>[0]>(
        threads: ReadonlyArray<T>,
      ): ReadonlyArray<T> =>
        actorUserId === null ? threads : threads.filter((thread) => owns(thread, actorUserId));

      // T3-CUSTOM(expbkt3): the requested threads this user may access, for title and link reads.
      const accessibleThreadIds = (threadIds: ReadonlyArray<ThreadId>) =>
        actorUserId === null
          ? Effect.succeed(threadIds)
          : Effect.forEach(threadIds, (threadId) =>
              accessControl.canAccessThread(actorUserId, threadId).pipe(
                Effect.orElseSucceed(() => false),
                Effect.map((allowed) => (allowed ? threadId : null)),
              ),
            ).pipe(Effect.map((ids) => ids.filter((threadId) => threadId !== null)));

      // T3-CUSTOM(expbkt3): native mutation routes use the same owner/member rules.
      const authorizeNativeCommand = (command: OrchestrationV2Command | ProjectMutation) =>
        checkCommandAccess(accessControl, actorUserId, actorIsAdmin, command).pipe(
          Effect.orElseSucceed(() => false),
          Effect.flatMap((allowed) =>
            allowed
              ? Effect.void
              : Effect.fail(
                  new EnvironmentAuthorizationError({
                    message: "Thread or project not found.",
                    requiredScope: "orchestration:operate",
                  }),
                ),
          ),
        );
      // T3-CUSTOM(expbkt3): workflow runs and definitions carry no owner, so only org admins and
      // unrestricted operators read or steer them. Members see empty live views, not errors.
      const workflowsAllowed = actorUserId === null || actorIsAdmin;
      const noWorkflowRuns: WorkflowRunsSnapshot = { workflows: [], runs: [], questions: [] };
      const noWorkflowCounts: WorkflowCounts = { needsYou: 0, active: 0, total: 0 };
      const withWorkflowAccess = <A, E, R>(
        effect: Effect.Effect<A, E, R>,
      ): Effect.Effect<A, E | EnvironmentAuthorizationError, R> =>
        workflowsAllowed
          ? effect
          : Effect.fail(
              new EnvironmentAuthorizationError({
                message: "Workflows are available to administrators only.",
                requiredScope: "orchestration:operate",
              }),
            );
      const workflowRequest = <A, R>(effect: Effect.Effect<A, Workflows.WorkflowError, R>) =>
        withWorkflowAccess(effect.pipe(Effect.mapError(toWorkflowRequestError)));
      // T3-CUSTOM(expbkt3): tracker accounts hold shared credentials and linked environments
      // read another machine's threads with a link's own credential: admins and operators only.
      const adminOnlyError = (message: string) =>
        new EnvironmentAuthorizationError({ message, requiredScope: "settings:write" });
      const withAdminAccess = <A, E, R>(
        message: string,
        effect: Effect.Effect<A, E, R>,
      ): Effect.Effect<A, E | EnvironmentAuthorizationError, R> =>
        workflowsAllowed ? effect : Effect.fail(adminOnlyError(message));
      const trackerAdminMessage = "Issue tracker accounts are managed by administrators only.";
      const peerAdminMessage = "Linked environments are available to administrators only.";
      // T3-CUSTOM(expbkt3): BEGIN issue calls act through a project's tracker binding, so they
      // need project access; a denied caller reads the project as missing.
      const withProjectAccess = <A, E, R>(
        projectId: ProjectId,
        effect: Effect.Effect<A, E, R>,
      ): Effect.Effect<A, E | EnvironmentAuthorizationError, R> =>
        actorUserId === null
          ? effect
          : accessControl.canAccessProject(actorUserId, projectId).pipe(
              Effect.orElseSucceed(() => false),
              Effect.flatMap((allowed) =>
                allowed
                  ? effect
                  : Effect.fail(
                      new EnvironmentAuthorizationError({
                        message: "Project not found.",
                        requiredScope: "orchestration:operate",
                      }),
                    ),
              ),
            );
      // A listing reads only the projects this user may see, so every scope, cursor, viewer and
      // tracker in the answer comes from those projects alone.
      const listVisibleIssues = (input: IssueListInput) =>
        actorUserId === null
          ? issues.list(input)
          : visibleAggregateIdsForActor(actorUserId).pipe(
              Effect.map(
                ({ projectIds }) => new Set([...projectIds].map((id) => ProjectId.make(id))),
              ),
              Effect.orElseSucceed(() => new Set<ProjectId>()),
              Effect.flatMap((projectIds) => issues.list(input, projectIds)),
            );
      // T3-CUSTOM(expbkt3): END
      const mutateProject = Effect.fn("ws.projects.mutate")(function* (mutation: ProjectMutation) {
        yield* authorizeNativeCommand(mutation); // T3-CUSTOM(expbkt3)
        return yield* mutateProjectWithClone(projectService, projectCloneTracker, mutation);
      });

      // T3-CUSTOM(expbkt3): BEGIN source-control identity — per-thread/user profile
      // resolution and environment injection for Git operations.
      const resolveSelectedSourceControlEnvironment = Effect.fn(
        "ws.resolveSelectedSourceControlEnvironment",
      )(function* (
        profileId:
          | SourceControlProfileService.SourceControlExecutionContext["profileId"]
          | undefined,
      ) {
        const settings = yield* serverSettings.getSettings.pipe(
          Effect.mapError(
            () =>
              new SourceControlProfileError({
                operation: "resolve-profile",
                reason: "profile-persist-failed",
                detail: "Could not read source-control identity settings.",
              }),
          ),
        );
        if (settings.sourceControlIdentityMode === "thread-profile") {
          if (currentSession.userId === null) {
            return yield* new SourceControlProfileError({
              operation: "resolve-profile",
              reason: "missing-profile",
              detail: "Sign in before using authenticated source-control operations.",
            });
          }
          const context = yield* sourceControlProfiles.resolveUserExecutionContext(
            UserId.make(currentSession.userId),
            {},
          );
          if (context === null) {
            return null;
          }
          return {
            profileId: context.profileId,
            environment: context.environment,
          };
        }
        if (profileId !== undefined) {
          const context = yield* sourceControlProfiles.resolveExecutionContext(profileId, {});
          return {
            profileId: context.profileId,
            environment: context.environment,
          };
        }
        return null;
      });

      const resolveThreadSourceControlEnvironment = Effect.fn(
        "ws.resolveThreadSourceControlEnvironment",
      )(function* (threadId: ThreadId | undefined) {
        const settings = yield* serverSettings.getSettings.pipe(
          Effect.mapError(
            () =>
              new SourceControlProfileError({
                operation: "resolve-thread-profile",
                reason: "profile-persist-failed",
                detail: "Could not read source-control identity settings.",
                ...(threadId !== undefined ? { threadId } : {}),
              }),
          ),
        );
        if (settings.sourceControlIdentityMode === "machine") {
          return null;
        }
        if (threadId === undefined) {
          return yield* new SourceControlProfileError({
            operation: "resolve-thread-profile",
            reason: "missing-profile",
            detail: "This Git operation must identify its owning thread.",
          });
        }

        const thread = yield* projectionSnapshotQuery.getThreadShellById(threadId).pipe(
          Effect.mapError(
            () =>
              new SourceControlProfileError({
                operation: "resolve-thread-profile",
                reason: "thread-not-found",
                detail: "Could not read the thread's GitHub owner.",
                threadId,
              }),
          ),
        );
        if (Option.isNone(thread)) {
          return yield* new SourceControlProfileError({
            operation: "resolve-thread-profile",
            reason: "thread-not-found",
            detail: "The selected thread no longer exists.",
            threadId,
          });
        }
        const context = yield* sourceControlProfiles.resolveThreadExecutionContext(
          threadId,
          thread.value.ownerUserId,
          {},
        );
        return context === null
          ? null
          : { profileId: context.profileId, environment: context.environment };
      });

      const withThreadSourceControl = <A, E, R>(
        threadId: ThreadId | undefined,
        effect: Effect.Effect<A, E, R>,
      ): Effect.Effect<A, E | SourceControlProfileError, R> =>
        Effect.flatMap(resolveThreadSourceControlEnvironment(threadId), (executionEnvironment) =>
          withSourceControlExecutionEnvironment(effect, executionEnvironment),
        );

      const withThreadActionLock = <A, E, R>(
        threadId: ThreadId | undefined,
        effect: Effect.Effect<A, E, R>,
      ): Effect.Effect<A, E, R> =>
        threadId === undefined ? effect : sourceControlActionLock.runExclusive(threadId, effect);

      const withThreadSourceControlStream = <A, E, R>(
        threadId: ThreadId | undefined,
        stream: Stream.Stream<A, E, R>,
      ): Stream.Stream<A, E | SourceControlProfileError, R> =>
        Stream.unwrap(
          resolveThreadSourceControlEnvironment(threadId).pipe(
            Effect.map((executionEnvironment) =>
              stream.pipe(
                Stream.provideService(
                  CurrentSourceControlExecutionEnvironment,
                  executionEnvironment,
                ),
              ),
            ),
          ),
        );

      const ensureGitHubRemotesUseHttps = Effect.fn("ws.ensureGitHubRemotesUseHttps")(
        function* (input: { readonly cwd: string; readonly threadId?: ThreadId | undefined }) {
          const executionEnvironment = yield* resolveThreadSourceControlEnvironment(input.threadId);
          if (executionEnvironment === null) return;
          const remote = yield* withSourceControlExecutionEnvironment(
            gitVcsDriver.execute({
              operation: "SourceControlRemote.validateHttps",
              cwd: input.cwd,
              args: ["remote", "get-url", "origin"],
              allowNonZeroExit: true,
            }),
            executionEnvironment,
          ).pipe(
            Effect.mapError(
              () =>
                new SourceControlProfileError({
                  operation: "validate-remote",
                  reason: "validation-failed",
                  detail: "GitHub remotes could not be validated before the authenticated action.",
                  profileId: executionEnvironment.profileId,
                  ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
                }),
            ),
          );
          if (remote.exitCode === 0 && githubSshRemoteToHttps(remote.stdout.trim()) !== null) {
            return yield* new SourceControlProfileError({
              operation: "validate-remote",
              reason: "ssh-remote",
              detail:
                "Convert the GitHub remote to HTTPS before fetching, pushing, or preparing a pull request.",
              profileId: executionEnvironment.profileId,
              ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
            });
          }
        },
      );

      const withThreadSourceControlEnvironment = Effect.fn("ws.withThreadSourceControlEnvironment")(
        function* <
          A extends {
            readonly threadId: string;
            readonly env?: Readonly<Record<string, string>> | undefined;
          },
        >(input: A): Effect.fn.Return<A, SourceControlProfileError> {
          const threadId = ThreadId.make(input.threadId);
          const settings = yield* serverSettings.getSettings.pipe(
            Effect.mapError(
              () =>
                new SourceControlProfileError({
                  operation: "resolve-terminal-profile",
                  reason: "profile-persist-failed",
                  detail: "Could not read source-control identity settings.",
                  threadId,
                }),
            ),
          );
          if (settings.sourceControlIdentityMode === "machine") {
            return input;
          }
          const thread = yield* projectionSnapshotQuery.getThreadShellById(threadId).pipe(
            Effect.mapError(
              () =>
                new SourceControlProfileError({
                  operation: "resolve-terminal-profile",
                  reason: "thread-not-found",
                  detail: "Could not read the terminal's thread owner.",
                  threadId,
                }),
            ),
          );
          if (Option.isNone(thread)) {
            return yield* new SourceControlProfileError({
              operation: "resolve-terminal-profile",
              reason: "thread-not-found",
              detail: "The terminal's thread no longer exists.",
              threadId,
            });
          }
          const context = yield* sourceControlProfiles.resolveThreadExecutionContext(
            threadId,
            thread.value.ownerUserId,
            {},
          );
          if (context === null) {
            return input;
          }
          const merged = SourceControlProfileService.mergeSourceControlEnvironment(
            input.env ?? {},
            context.environment,
          );
          const env = Object.fromEntries(
            Object.entries(merged).filter(
              (entry): entry is [string, string] => entry[1] !== undefined,
            ),
          );
          return { ...input, env } as A;
        },
      );
      // T3-CUSTOM(expbkt3): END

      // T3-CUSTOM(expbkt3): BEGIN fork RPC handlers (wsForkHandlers.ts)
      const forkHandlers = makeForkWsHandlers({
        currentSessionId,
        actorUserId,
        personalMcpUserId,
        personalMcpProfiles,
        httpClient,
        sourceControlProfiles,
        environmentUsers,
        planReview,
        agentUi,
        threadComments,
        actorLabel,
        usage,
        projectionSnapshotQuery,
        orchestrationEngine: legacyEngine,
        gitVcsDriver,
        sessionArchive,
        sourceControlActionLock,
        enrichOrchestrationEvents: (events) => Effect.succeed(events),
        observeRpcEffect,
        observeRpcStream,
        requireThreadAccess,
        visibleAggregateIdsForActor,
        claudeAccounts,
        // T3-CUSTOM(expbkt3): Claude account access per user is admin-managed.
        actorIsAdmin,
        clerkDirectory,
      });
      // T3-CUSTOM(expbkt3): END

      const handlers = NativeWsRpcGroup.of({
        // T3-CUSTOM(expbkt3): BEGIN issue reads and writes keep to the caller's projects.
        [WS_METHODS.issuesList]: (input) =>
          input.projectId === undefined
            ? listVisibleIssues(input)
            : withProjectAccess(input.projectId, listVisibleIssues(input)),
        [WS_METHODS.issuesDetail]: (input) =>
          withProjectAccess(input.projectId, issues.detail(input)),
        [WS_METHODS.issuesComments]: (input) =>
          withProjectAccess(input.projectId, issues.comments(input)),
        [WS_METHODS.issuesTemplates]: (input) =>
          withProjectAccess(input.projectId, issues.templates(input)),
        [WS_METHODS.issuesCandidates]: (input) =>
          withProjectAccess(input.projectId, issues.candidates(input)),
        // Linked threads name only threads this user may access.
        [WS_METHODS.issuesLinkedThreads]: (input) =>
          threadIssues.linkedThreads(input).pipe(
            Effect.flatMap((result) =>
              accessibleThreadIds(result.threads.map((thread) => thread.id)).pipe(
                Effect.map((threadIds) => ({
                  ...result,
                  threads: result.threads.filter((thread) => threadIds.includes(thread.id)),
                })),
              ),
            ),
          ),
        [WS_METHODS.issuesCreate]: (input) =>
          withProjectAccess(input.projectId, issues.create(input)),
        [WS_METHODS.issuesComment]: (input) =>
          withProjectAccess(input.projectId, issues.comment(input)),
        [WS_METHODS.issuesUpdate]: (input) =>
          withProjectAccess(input.projectId, issues.update(input)),
        [WS_METHODS.issuesSetState]: (input) =>
          withProjectAccess(input.projectId, issues.setState(input)),
        [WS_METHODS.issuesReact]: (input) =>
          withProjectAccess(input.projectId, issues.react(input)),
        // Tracker accounts and bindings are admin-managed; members list none.
        [WS_METHODS.issueTrackersList]: () =>
          workflowsAllowed
            ? issueTrackers.list
            : Effect.succeed({ trackers: [], accounts: [], bindings: {}, accountBindings: {} }),
        [WS_METHODS.issueTrackersConnect]: (input) =>
          withAdminAccess(trackerAdminMessage, issueTrackers.connect(input)),
        [WS_METHODS.issueTrackersBindProject]: (input) =>
          withAdminAccess(
            trackerAdminMessage,
            withProjectAccess(input.projectId, issueTrackers.bindProject(input)),
          ),
        // T3-CUSTOM(expbkt3): END
        [ORCHESTRATION_V2_WS_METHODS.dispatchCommand]: (command) =>
          Effect.annotateCurrentSpan({
            "orchestration_v2.command_id": command.commandId,
            "orchestration_v2.command_type": command.type,
            "orchestration_v2.thread_id":
              command.type === "thread.fork" || command.type === "thread.merge_back"
                ? command.targetThreadId
                : command.type === "delegated_task.request" ||
                    command.type === "delegated_task.wake-policy" ||
                    command.type === "delegated_task.completion-delivery.acknowledge" ||
                    command.type === "delegated_task.completion-delivery.dispose" ||
                    command.type === "thread.created.record"
                  ? command.parentThreadId
                  : command.threadId,
            ...(command.type === "thread.fork" || command.type === "thread.merge_back"
              ? { "orchestration_v2.source_thread_id": command.sourceThreadId }
              : {}),
          }).pipe(
            Effect.andThen(
              startup
                .enqueueCommand(
                  // T3-CUSTOM(expbkt3): preserve fork identity, access and integration behavior.
                  authorizeNativeCommand(command).pipe(
                    Effect.andThen(
                      // A retry also restarts the preparation work the launch owns.
                      (command.type === "prepared-run.retry"
                        ? threadLaunch.retryPreparation(command)
                        : ThreadMessageIntake.dispatchCommand(
                            ThreadManagementService.withCreationProvenance(command, {
                              createdBy: "user",
                              creationSource:
                                "creationSource" in command ? command.creationSource : "web",
                            }),
                            {
                              managesProviders:
                                currentSession.scopes.includes(AuthProvidersManageScope),
                            },
                          )
                      ).pipe(
                        Effect.provide(intakeContext),
                        // T3-CUSTOM(expbkt3): preserve fork identity, access and integration behavior.
                        Effect.provideService(Orchestrator.OrchestratorV2, orchestrationEngine),
                        Effect.provideService(CurrentOrchestrationActorUserId, actorUserId),
                      ),
                    ),
                  ),
                )
                .pipe(
                  Effect.tap((result) =>
                    result.replayed ? Effect.void : recordClientCommandAnalytics(command),
                  ),
                  Effect.map((result) => ({ sequence: result.sequence })),
                  Effect.mapError((cause) => {
                    if (cause._tag === "EnvironmentAuthorizationError") return cause;
                    const detail = userFacingDispatchErrorMessage(cause);
                    return new OrchestrationV2DispatchCommandError({
                      commandId: command.commandId,
                      commandType: command.type,
                      message: detail ?? "Failed to dispatch orchestration V2 command",
                      ...(detail === undefined ? {} : { detail }),
                      cause,
                    });
                  }),
                ),
            ),
          ),
        [ORCHESTRATION_V2_WS_METHODS.stopWorkflow]: (input) =>
          // T3-CUSTOM(expbkt3): stopping a thread's workflow needs thread access.
          requireThreadAccess(input.threadId).pipe(
            Effect.mapError(
              (cause) =>
                new OrchestrationV2StopWorkflowError({
                  threadId: input.threadId,
                  subagentId: input.subagentId,
                  reason: "unavailable",
                  cause,
                }),
            ),
            Effect.andThen(threadManagement.stopWorkflow(input)),
          ),
        // T3-CUSTOM(expbkt3): force-stopping a thread needs thread access.
        [ORCHESTRATION_V2_WS_METHODS.forceStopThread]: (input) =>
          requireThreadAccess(input.threadId).pipe(
            Effect.mapError(
              (cause) =>
                new OrchestrationV2ForceStopThreadError({ threadId: input.threadId, cause }),
            ),
            Effect.andThen(threadManagement.forceStopThread(input)),
          ),
        [ORCHESTRATION_V2_WS_METHODS.getWorkflowScript]: (input) =>
          readWorkflowScript({ scriptPath: input.scriptPath }),
        [ORCHESTRATION_V2_WS_METHODS.getNativeChildWork]: (input) =>
          // T3-CUSTOM(expbkt3): a subagent's work is thread content, so it needs thread access.
          requireThreadAccess(input.threadId).pipe(
            Effect.mapError(
              (cause) =>
                new OrchestrationV2GetNativeChildWorkError({ threadId: input.threadId, cause }),
            ),
            Effect.andThen(nativeChildWork.getNativeChildWork(input)),
          ),
        [ORCHESTRATION_V2_WS_METHODS.getTurnItem]: (input) =>
          // T3-CUSTOM(expbkt3): a turn item holds tool output, so it needs thread access.
          requireThreadAccess(input.threadId).pipe(
            Effect.andThen(threadManagement.getTurnItem(input)),
            Effect.mapError(
              (cause) =>
                new OrchestrationV2GetThreadProjectionError({
                  threadId: input.threadId,
                  message: "Failed to load turn item",
                  cause,
                }),
            ),
          ),
        [ORCHESTRATION_V2_WS_METHODS.getTurnDiff]: (input) =>
          // T3-CUSTOM(expbkt3): preserve fork identity, access and integration behavior.
          requireThreadAccess(input.threadId).pipe(
            Effect.andThen(checkpointDiffQuery.getTurnDiff(input)),
            Effect.mapError(
              (cause) =>
                new OrchestrationGetTurnDiffError({
                  message: "Failed to load turn diff",
                  cause,
                }),
            ),
          ),
        [ORCHESTRATION_V2_WS_METHODS.getFullThreadDiff]: (input) =>
          // T3-CUSTOM(expbkt3): preserve fork identity, access and integration behavior.
          requireThreadAccess(input.threadId).pipe(
            Effect.andThen(checkpointDiffQuery.getFullThreadDiff(input)),
            Effect.mapError(
              (cause) =>
                new OrchestrationGetFullThreadDiffError({
                  message: "Failed to load full thread diff",
                  cause,
                }),
            ),
          ),
        [ORCHESTRATION_V2_WS_METHODS.searchThread]: (input) =>
          // T3-CUSTOM(expbkt3): searching inside a thread reads its transcript.
          requireThreadAccess(input.threadId).pipe(
            Effect.andThen(threadManagement.searchThread(input)),
            Effect.mapError((cause) => new OrchestrationV2SearchThreadError({ cause })),
          ),
        [ORCHESTRATION_V2_WS_METHODS.searchThreadStream]: (input) =>
          // T3-CUSTOM(expbkt3): searching inside a thread reads its transcript.
          Stream.unwrap(
            requireThreadAccess(input.threadId).pipe(
              Effect.as(threadManagement.searchThreadStream(input)),
            ),
          ).pipe(Stream.mapError((cause) => new OrchestrationV2SearchThreadError({ cause }))),
        [ORCHESTRATION_V2_WS_METHODS.searchThreads]: (input) =>
          ThreadSearch.searchThreadsWithOlderSettledRows({
            request: input,
            search: threadSearch.search,
            searchOlderSettled: threadSearch.searchOlderSettled,
            sql,
            readThreads: (threadIds) =>
              threadManagement.readShellSnapshot({ location: "active", threadIds }),
            latestSequence: applicationEvents.latestApplicationSequence,
          }).pipe(
            // T3-CUSTOM(expbkt3): BEGIN — search must not reveal hidden conversations.
            (search) =>
              actorUserId === null
                ? search
                : search.pipe(
                    Effect.flatMap((result) =>
                      Effect.forEach(result.matches, (match) =>
                        accessControl.canAccessThread(actorUserId, match.threadId).pipe(
                          Effect.orElseSucceed(() => false),
                          Effect.map((allowed) => (allowed ? match : null)),
                        ),
                      ).pipe(
                        Effect.map((matches) => ({
                          ...result,
                          matches: matches.filter((match) => match !== null),
                          ...(result.threads === undefined
                            ? {}
                            : { threads: visibleShellThreads(result.threads) }),
                        })),
                      ),
                    ),
                  ),
            // T3-CUSTOM(expbkt3): END
            Effect.mapError(
              (cause) =>
                new OrchestrationSearchThreadsError({
                  message: "Failed to search threads",
                  cause,
                }),
            ),
          ),
        [ORCHESTRATION_V2_WS_METHODS.getArchivedShellSnapshot]: (_input) =>
          // T3-CUSTOM(expbkt3): preserve fork identity, access and integration behavior.
          getOrchestrationV2ArchivedShellSnapshot.pipe(
            Effect.map((snapshot) => filterNativeShell(snapshot, actorUserId)),
          ),
        [ORCHESTRATION_V2_WS_METHODS.getThreadFamily]: (input) =>
          readOmittableShellRows(
            { familyOf: input.threadId },
            "Failed to load the thread family",
          ).pipe(
            // T3-CUSTOM(expbkt3): a family lists only the threads this user may see.
            Effect.map((family) => ({ ...family, threads: visibleShellThreads(family.threads) })),
          ),
        [ORCHESTRATION_V2_WS_METHODS.getThreadLinkMetadata]: (input) =>
          // T3-CUSTOM(expbkt3): link metadata only for threads this user may access.
          accessibleThreadIds(input.threadIds).pipe(
            Effect.flatMap((threadIds) => threadManagement.getThreadLinkMetadata(threadIds)),
            Effect.mapError(
              (cause) =>
                new OrchestrationV2GetShellSnapshotError({
                  message: "Failed to load thread link metadata",
                  cause,
                }),
            ),
          ),
        [ORCHESTRATION_V2_WS_METHODS.getThreadTitles]: (input) =>
          // T3-CUSTOM(expbkt3): titles only for threads this user may access.
          accessibleThreadIds(input.threadIds).pipe(
            Effect.flatMap((threadIds) => threadManagement.getThreadTitles(threadIds)),
            Effect.mapError(
              (cause) =>
                new OrchestrationV2GetShellSnapshotError({
                  message: "Failed to load thread titles",
                  cause,
                }),
            ),
          ),
        [ORCHESTRATION_V2_WS_METHODS.getOlderSettledThreads]: (input) =>
          loadOlderSettledThreadsPage({
            sql,
            listThreads: threadManagement.listOlderSettledThreads(input),
            readThreads: (threadIds) =>
              threadManagement.readShellSnapshot({ location: "active", threadIds }),
            latestSequence: applicationEvents.latestApplicationSequence,
          }).pipe(
            // T3-CUSTOM(expbkt3): a page lists only the threads this user may see. Counts span
            // every user's threads, so a filtered user gets none; fork shells never omit settled rows.
            Effect.map((page) => ({
              ...page,
              threads: visibleShellThreads(page.threads),
              counts: actorUserId === null ? page.counts : [],
            })),
            Effect.mapError(
              (cause) =>
                new OrchestrationV2GetShellSnapshotError({
                  message: "Failed to load older settled threads",
                  cause,
                }),
            ),
          ),
        [ORCHESTRATION_V2_WS_METHODS.getWorktreeThreadIds]: (input) =>
          readOmittableShellRows(
            { worktreePath: input.worktreePath },
            "Failed to load the worktree's threads",
          ).pipe(
            // T3-CUSTOM(expbkt3): only the threads this user may see.
            Effect.map(({ threads }) => ({
              threadIds: visibleShellThreads(threads).map((thread) => thread.id),
            })),
          ),
        // T3-CUSTOM(expbkt3): native transcript reads obey the same team visibility.
        [ORCHESTRATION_V2_WS_METHODS.getThreadProjection]: (input) =>
          Effect.annotateCurrentSpan({ "orchestration_v2.thread_id": input.threadId }).pipe(
            Effect.andThen(
              // Bound compatibility snapshots so pre-pagination clients cannot materialize unlimited transcripts.
              requireThreadAccess(input.threadId).pipe(
                Effect.andThen(
                  threadManagement.getThreadSnapshotWindow(input.threadId, {
                    rowLimit: THREAD_HISTORY_SNAPSHOT_ROW_LIMIT,
                  }),
                ),
                Effect.map(
                  (snapshot) =>
                    buildBoundedThreadProjection({
                      projection: projectThreadProjectionForWire(snapshot.projection),
                      snapshotSequence: snapshot.snapshotSequence,
                    }).projection,
                ),
                Effect.mapError(
                  (cause) =>
                    new OrchestrationV2GetThreadProjectionError({
                      threadId: input.threadId,
                      message: `Failed to load orchestration V2 thread ${input.threadId}`,
                      cause,
                    }),
                ),
              ),
            ),
          ),
        [ORCHESTRATION_V2_WS_METHODS.launchThread]: (input) =>
          Effect.annotateCurrentSpan({
            "orchestration_v2.command_id": input.commandId,
            "orchestration_v2.project_id": input.projectId,
          }).pipe(
            Effect.andThen(
              startup
                .enqueueCommand(
                  Effect.gen(function* () {
                    if (
                      actorUserId !== null &&
                      !(yield* accessControl
                        .canAccessProject(actorUserId, input.projectId)
                        .pipe(Effect.orElseSucceed(() => false)))
                    )
                      return yield* new OrchestrationV2ThreadLaunchError({
                        commandId: input.commandId,
                        projectId: input.projectId,
                        message: "Project not found.",
                      });
                    // T3-CUSTOM(expbkt3): shared-project access does not grant access to another member's thread.
                    if (input.reuseExistingThread === true && input.threadId !== undefined) {
                      yield* requireThreadAccess(input.threadId).pipe(
                        Effect.mapError(
                          (cause) =>
                            new OrchestrationV2ThreadLaunchError({
                              commandId: input.commandId,
                              projectId: input.projectId,
                              message: "Thread not found.",
                              cause,
                            }),
                        ),
                      );
                    }
                    return yield* threadLaunch
                      .checkWorktreeBase({
                        commandId: input.commandId,
                        projectId: input.projectId,
                        workspaceStrategy: input.workspaceStrategy,
                      })
                      .pipe(
                        Effect.andThen(
                          ThreadMessageIntake.launchThread({
                            // T3-CUSTOM(expbkt3): forward schema-validated creation metadata before upstream field normalization.
                            ...forkThreadLaunchMetadata(input),
                            commandId: input.commandId,
                            ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
                            ...(input.reuseExistingThread === undefined
                              ? {}
                              : { reuseExistingThread: input.reuseExistingThread }),
                            projectId: input.projectId,
                            title: input.title,
                            ...(input.generateTitle === undefined
                              ? {}
                              : { generateTitle: input.generateTitle }),
                            modelSelection: input.modelSelection,
                            runtimeMode: input.runtimeMode,
                            interactionMode: input.interactionMode,
                            workspaceStrategy: input.workspaceStrategy,
                            ...(input.initialMessage === undefined
                              ? {}
                              : {
                                  initialMessage: {
                                    ...(input.initialMessage.messageId === undefined
                                      ? {}
                                      : { messageId: input.initialMessage.messageId }),
                                    text: input.initialMessage.text,
                                    attachments: input.initialMessage.attachments,
                                    ...(input.initialMessage.context === undefined
                                      ? {}
                                      : { context: input.initialMessage.context }),
                                  },
                                }),
                            createdBy: "user",
                            creationSource: input.creationSource ?? "web",
                          }),
                        ),
                        Effect.provide(intakeContext),
                        Effect.provideService(Orchestrator.OrchestratorV2, orchestrationEngine),
                        Effect.provideService(CurrentOrchestrationActorUserId, actorUserId),
                      );
                  }),
                )
                .pipe(
                  // A resumed launch is a retry of one already counted.
                  Effect.tap((result) =>
                    result.resumed
                      ? Effect.void
                      : analytics
                          // T3-CUSTOM(expbkt3): client events carry the signed-in user (TEC-1631).
                          .record(
                            "client.thread.started",
                            {
                              ...originProps,
                              workspaceStrategy: input.workspaceStrategy.type,
                            },
                            analyticsUser,
                          )
                          .pipe(
                            Effect.andThen(
                              input.initialMessage === undefined
                                ? Effect.void
                                : analytics.record(
                                    "client.turn.requested",
                                    originProps,
                                    analyticsUser,
                                  ),
                            ),
                            Effect.ignore,
                          ),
                  ),
                  Effect.map((result) => ({
                    ...result,
                    projection: projectThreadProjectionForWire(result.projection),
                  })),
                  Effect.catchTags({
                    AttachmentClaimError: (cause) =>
                      new OrchestrationV2ThreadLaunchError({
                        commandId: input.commandId,
                        projectId: input.projectId,
                        message: cause.message,
                        cause,
                      }),
                    ThreadLaunchError: (cause) =>
                      new OrchestrationV2ThreadLaunchError({
                        commandId: input.commandId,
                        projectId: input.projectId,
                        message: "Failed to launch thread",
                        cause,
                      }),
                    ServerRuntimeStartupError: (cause) =>
                      new OrchestrationV2ThreadLaunchError({
                        commandId: input.commandId,
                        projectId: input.projectId,
                        message: "Failed to launch thread",
                        cause,
                      }),
                    ThreadManagementProviderInstanceDisabledError: (cause) =>
                      new OrchestrationV2ThreadLaunchError({
                        commandId: input.commandId,
                        projectId: input.projectId,
                        message: cause.message,
                        cause,
                      }),
                    ThreadLaunchBaseRefError: (cause) =>
                      new OrchestrationV2ThreadLaunchError({
                        commandId: input.commandId,
                        projectId: input.projectId,
                        message: cause.message,
                        cause,
                      }),
                    ThreadLaunchBranchExistsError: (cause) =>
                      new OrchestrationV2ThreadLaunchError({
                        commandId: input.commandId,
                        projectId: input.projectId,
                        message: cause.message,
                        cause,
                      }),
                    ThreadLaunchBranchConflictError: (cause) =>
                      new OrchestrationV2ThreadLaunchError({
                        commandId: input.commandId,
                        projectId: input.projectId,
                        message: cause.message,
                        cause,
                      }),
                    ThreadLaunchNotRepositoryError: (cause) =>
                      new OrchestrationV2ThreadLaunchError({
                        commandId: input.commandId,
                        projectId: input.projectId,
                        message: cause.message,
                        cause,
                      }),
                    TaskFolderError: (cause) =>
                      new OrchestrationV2ThreadLaunchError({
                        commandId: input.commandId,
                        projectId: input.projectId,
                        message: cause.message,
                        cause,
                      }),
                  }),
                ),
            ),
          ),
        [ORCHESTRATION_V2_WS_METHODS.subscribeShell]: (input) =>
          // T3-CUSTOM(expbkt3): live shell obeys team visibility inside the stream.
          Stream.unwrap(subscribeOrchestrationV2Shell(input, { actor: actorUserId })),
        [ORCHESTRATION_V2_WS_METHODS.subscribeThread]: (input) =>
          Stream.unwrap(
            Effect.annotateCurrentSpan({ "orchestration_v2.thread_id": input.threadId }).pipe(
              // T3-CUSTOM(expbkt3): a thread stream needs thread access.
              Effect.andThen(requireThreadAccess(input.threadId)),
              Effect.mapError(
                (cause) =>
                  new OrchestrationV2GetThreadProjectionError({
                    threadId: input.threadId,
                    message: "Thread not found.",
                    cause,
                  }),
              ),
              Effect.andThen(threadViewers.view(input.threadId)),
              Effect.andThen(subscribeOrchestrationV2Thread(input)),
            ),
          ),
        [ORCHESTRATION_V2_WS_METHODS.subscribeCommandOutput]: (input) =>
          Stream.unwrap(
            Effect.annotateCurrentSpan({ "orchestration_v2.thread_id": input.threadId }).pipe(
              // T3-CUSTOM(expbkt3): command output is tool output, so it needs thread access.
              Effect.andThen(requireThreadAccess(input.threadId)),
              Effect.mapError(
                (cause) =>
                  new OrchestrationV2CommandOutputError({
                    threadId: input.threadId,
                    message: "Thread not found.",
                    cause,
                  }),
              ),
              Effect.as(commandOutputHub.subscribe(input)),
            ),
          ),
        [ORCHESTRATION_V2_WS_METHODS.subscribePromptSuggestion]: (input) =>
          Stream.unwrap(
            // T3-CUSTOM(expbkt3): a suggested prompt is thread content, so it needs thread access.
            requireThreadAccess(input.threadId).pipe(
              Effect.mapError(
                () =>
                  new EnvironmentAuthorizationError({
                    message: "Thread not found.",
                    requiredScope: "orchestration:read",
                  }),
              ),
              Effect.as(providerSessionManager.subscribePromptSuggestion(input.threadId)),
            ),
          ),
        // T3-CUSTOM(expbkt3): BEGIN workflows are limited to admins and unrestricted operators.
        [WS_METHODS.workflowsSubscribe]: (_input) =>
          workflowsAllowed ? workflows.watch : Stream.succeed(noWorkflowRuns),
        [WS_METHODS.workflowsCounts]: (_input) =>
          workflowsAllowed ? workflows.counts : Stream.succeed(noWorkflowCounts),
        [WS_METHODS.workflowsGet]: (input) => workflowRequest(workflows.get(input.runId)),
        [WS_METHODS.workflowsAnswer]: (input) =>
          workflowRequest(
            workflows.answer(input.runId, input.name, {
              choice: input.choice,
              ...(input.reason === undefined ? {} : { reason: input.reason }),
            }),
          ),
        [WS_METHODS.workflowsResume]: (input) => workflowRequest(workflows.resume(input.runId)),
        [WS_METHODS.workflowsCancel]: (input) =>
          workflowRequest(workflows.cancel(input.runId, input.reason)),
        [WS_METHODS.workflowsGetDefinition]: (_input) =>
          withWorkflowAccess(workflowDefinitions.read),
        [WS_METHODS.workflowsSaveDefinition]: (input) =>
          withWorkflowAccess(workflowDefinitions.save(input.name, input.source)),
        [WS_METHODS.workflowsDeleteDefinition]: (input) =>
          withWorkflowAccess(workflowDefinitions.remove(input.name)),
        // T3-CUSTOM(expbkt3): END
        [WS_METHODS.scheduledTasksSubscribe]: (_input) =>
          scheduledTasks.subscribeList().pipe(Stream.map(withVisibleWebhookUrls)),
        [WS_METHODS.scheduledTasksUpsert]: (input) => scheduledTasks.upsert(input),
        [WS_METHODS.scheduledTasksSetEnabled]: (input) =>
          Effect.annotateCurrentSpan({ "scheduled_task.id": input.id }).pipe(
            Effect.andThen(scheduledTasks.setEnabled(input)),
          ),
        [WS_METHODS.scheduledTasksDelete]: (input) =>
          Effect.annotateCurrentSpan({ "scheduled_task.id": input.id }).pipe(
            Effect.andThen(scheduledTasks.delete(input)),
          ),
        [WS_METHODS.scheduledTasksRunNow]: (input) =>
          Effect.annotateCurrentSpan({ "scheduled_task.id": input.id }).pipe(
            Effect.andThen(scheduledTasks.runNow(input)),
          ),
        [WS_METHODS.scheduledTasksRotateWebhookToken]: (input) =>
          Effect.annotateCurrentSpan({ "scheduled_task.id": input.id }).pipe(
            Effect.andThen(scheduledTasks.rotateWebhookToken(input)),
          ),
        [WS_METHODS.guestShareCreate]: (input) =>
          Effect.annotateCurrentSpan({ "orchestration_v2.thread_id": input.threadId }).pipe(
            Effect.andThen(guestShares.create(input)),
          ),
        [WS_METHODS.secretsAnswerRequest]: (input) =>
          Effect.annotateCurrentSpan({ "orchestration_v2.thread_id": input.threadId }).pipe(
            // T3-CUSTOM(expbkt3): only members who can access the thread answer its secret
            // requests; a denied caller sees the same reason as a missing request.
            Effect.andThen(requireThreadAccess(input.threadId)),
            Effect.mapError(() => new SecretRequestError({ reason: "not_found" })),
            Effect.andThen(secretRequests.answer(input)),
          ),
        [WS_METHODS.agentFeedbackAnswerRequest]: (input) =>
          // T3-CUSTOM(expbkt3): only members who can access the thread answer its feedback cards;
          // a denied caller sees the same reason as a missing card.
          requireThreadAccess(input.threadId).pipe(
            Effect.mapError(() => new AgentFeedbackRequestError({ reason: "not_found" })),
            Effect.andThen(feedbackStore.answer(input)),
          ),
        [WS_METHODS.scheduledTasksListWebhookDeliveries]: (input) =>
          Effect.annotateCurrentSpan({ "scheduled_task.id": input.id }).pipe(
            Effect.andThen(scheduledTasks.listWebhookDeliveries(input)),
          ),
        [WS_METHODS.scheduledTasksGetWebhookDelivery]: (input) =>
          Effect.annotateCurrentSpan({ "scheduled_task.id": input.id }).pipe(
            Effect.andThen(scheduledTasks.getWebhookDelivery(input)),
          ),
        [WS_METHODS.serverProbe]: (_input) =>
          Effect.map(DateTime.now, (now) => ({ serverTime: DateTime.formatIso(now) })),
        [WS_METHODS.serverGetConfig]: (_input) =>
          loadServerConfig({
            usageLimitsCommand: false,
            workspaceSnapshotsOnDemand: false,
            deferNetworkDiscovery: false,
          }),
        [WS_METHODS.serverSearchAcpRegistry]: (input) =>
          acpRegistryCatalog
            .search(input)
            .pipe(Effect.mapError(AcpRegistrySupport.toAcpRegistryOperationError)),
        [WS_METHODS.serverPrepareAcpRegistryAgent]: (input) =>
          Effect.annotateCurrentSpan({ "acp_registry.agent_id": input.agentId }).pipe(
            Effect.andThen(
              Effect.suspend(() => {
                const blocked = ManagedProviders.disallowedDriverReason(
                  serverSettings.managedPolicy,
                  ProviderDriverKind.make("acpRegistry"),
                );
                return blocked === undefined
                  ? acpRegistryCatalog
                      .prepare(input)
                      .pipe(Effect.mapError(AcpRegistrySupport.toAcpRegistryOperationError))
                  : Effect.fail(
                      new AcpRegistryOperationError({ reason: "install_failed", message: blocked }),
                    );
              }),
            ),
          ),
        [WS_METHODS.serverUninstallAcpRegistryManagedBinary]: (input) =>
          Effect.annotateCurrentSpan({ "acp_registry.agent_id": input.agentId }).pipe(
            Effect.andThen(
              acpRegistryCatalog
                .uninstallManagedBinary(input)
                .pipe(Effect.mapError(AcpRegistrySupport.toAcpRegistryOperationError)),
            ),
          ),
        [WS_METHODS.serverAcceptAcpRegistryUrlAuth]: (input) =>
          Effect.annotateCurrentSpan({ "provider.instance_id": input.instanceId }).pipe(
            Effect.andThen(
              acpRegistryRuntimeCoordinator
                .acceptUrlAuthentication(input)
                .pipe(Effect.map((accepted) => ({ accepted }))),
            ),
          ),
        [WS_METHODS.serverListAcpRegistrySessions]: (input) =>
          Effect.annotateCurrentSpan({
            "provider.instance_id": input.instanceId,
            "project.id": input.projectId,
          }).pipe(Effect.andThen(listAcpRegistrySessions(input))),
        [WS_METHODS.serverImportAcpRegistrySession]: (input) =>
          Effect.annotateCurrentSpan({
            "provider.instance_id": input.instanceId,
            "project.id": input.projectId,
          }).pipe(
            // T3-CUSTOM(expbkt3): the import checks project access first.
            Effect.andThen(acpRegistryProject(input.projectId)),
            Effect.andThen(acpRegistrySessions.importSession(input)),
          ),
        [WS_METHODS.serverDeleteAcpRegistrySession]: (input) =>
          Effect.annotateCurrentSpan({
            "provider.instance_id": input.instanceId,
            "project.id": input.projectId,
          }).pipe(Effect.andThen(deleteAcpRegistrySession(input))),
        [WS_METHODS.serverListAcpRegistryProviders]: (input) =>
          Effect.annotateCurrentSpan({
            "provider.instance_id": input.instanceId,
            "project.id": input.projectId,
          }).pipe(Effect.andThen(listAcpRegistryProviders(input))),
        [WS_METHODS.serverSetAcpRegistryProvider]: (input) =>
          Effect.annotateCurrentSpan({
            "provider.instance_id": input.instanceId,
            "project.id": input.projectId,
          }).pipe(Effect.andThen(setAcpRegistryProvider(input))),
        [WS_METHODS.serverDisableAcpRegistryProvider]: (input) =>
          Effect.annotateCurrentSpan({
            "provider.instance_id": input.instanceId,
            "project.id": input.projectId,
          }).pipe(Effect.andThen(disableAcpRegistryProvider(input))),
        [WS_METHODS.serverLogoutAcpRegistry]: (input) =>
          Effect.annotateCurrentSpan({ "provider.instance_id": input.instanceId }).pipe(
            Effect.andThen(
              Effect.gen(function* () {
                const { instance, manager } = yield* acpRegistrySessions.sessionManager(
                  input.instanceId,
                );
                const snapshot = yield* instance.snapshot.getSnapshot;
                if (snapshot.auth.canLogout !== true) {
                  return yield* new AcpRegistryOperationError({
                    reason: "logout_unsupported",
                    message: "The ACP agent does not advertise logout.",
                  });
                }
                if (instance.auth) {
                  yield* providerAuth.logout(input).pipe(
                    Effect.mapError(
                      (cause) =>
                        new AcpRegistryOperationError({
                          reason: "logout_failed",
                          message: "Could not sign out of the ACP agent.",
                          cause,
                        }),
                    ),
                  );
                } else {
                  yield* providerSessionManager.closeInstance(input.instanceId).pipe(
                    Effect.mapError(
                      (cause) =>
                        new AcpRegistryOperationError({
                          reason: "logout_failed",
                          message: "Could not stop live sessions before ACP logout.",
                          cause,
                        }),
                    ),
                  );
                  yield* manager.logout(config.cwd);
                }
                yield* providerRegistry.refreshInstance(input.instanceId);
                return { loggedOut: true } as const;
              }),
            ),
          ),
        [WS_METHODS.serverRefreshProviders]:
          /* Request instrumentation already owns the span; keep this helper in that context. */
          Effect.fnUntraced(function* (input) {
            if (input.modelCatalogOnly === true) {
              yield* providerRegistry.refreshModelCatalog;
              return { providers: [] };
            }
            if (input.refreshModels) {
              yield* providerRegistry.invalidateModelCaches({
                instanceId: input.instanceId,
                cwd: input.cwd,
                fresh: input.fresh,
              });
            }
            if (input.reloadSecrets === true && input.instanceId === undefined) {
              yield* invalidateSettingsSecrets(secretResolver, serverSettings.getSettings);
            }
            // Await refresh; RPC scope closure would interrupt a fork before the hub answered.
            if (input.instanceId === undefined) {
              yield* usageLimitSources.refresh;
            }
            let providers = yield* input.cwd !== undefined && input.instanceId !== undefined
              ? providerRegistry.refreshWorkspaceSnapshot({
                  instanceId: input.instanceId,
                  cwd: input.cwd,
                  scanCwd: yield* projectService.workspaceScanDirectory(input.cwd),
                  fresh: input.fresh === true,
                })
              : input.reloadSecrets === true
                ? providerRegistry.reloadSecretsAndRefresh(input.instanceId)
                : input.instanceId !== undefined
                  ? providerRegistry.refreshInstance(input.instanceId)
                  : providerRegistry.refresh();
            if (input.refreshModels) {
              const instances = yield* providerInstances.listInstances;
              for (const instance of instances) {
                if (
                  !instance.refreshModels ||
                  (input.instanceId !== undefined && input.instanceId !== instance.instanceId) ||
                  !providers.some(
                    (provider) =>
                      provider.instanceId === instance.instanceId &&
                      provider.enabled &&
                      provider.installed,
                  )
                )
                  continue;
                yield* instance.refreshModels().pipe(
                  Effect.mapError(
                    (error) =>
                      new ProviderSetupError({
                        instanceId: instance.instanceId,
                        operation: "refresh-models",
                        detail: error.detail,
                      }),
                  ),
                );
                providers = yield* providerRegistry.refreshInstance(instance.instanceId);
              }
            }
            const { instanceId, cwd } = input;
            if (input.omitProviders === true && (instanceId === undefined || cwd === undefined)) {
              return { providers: [] };
            }
            if (input.workspaceSnapshotsOnDemand !== true) return { providers };
            const commandProviders =
              input.usageLimitsCommand === true
                ? withUsageLimitsCommands(providers, yield* usageLimitSources.current)
                : providers;
            if (instanceId === undefined || cwd === undefined) {
              return { providers: withoutWorkspaceSnapshots(commandProviders) };
            }
            const catalogOnDemand =
              input.providerCatalogsOnDemand === true &&
              (yield* providerInstances.getInstance(instanceId))?.snapshotForCwd !== undefined;
            return {
              providers: commandProviders
                .filter((provider) => provider.instanceId === instanceId)
                .map((provider) => {
                  const catalog =
                    catalogOnDemand && input.machineCatalog === true
                      ? machineCatalogNames(provider)
                      : undefined;
                  return {
                    ...provider,
                    // Callers read only the cwd snapshot; the config stream carries the rest.
                    models: [],
                    slashCommands: catalog?.slashCommands ?? [],
                    skills: catalog?.skills ?? [],
                    ...(catalog === undefined
                      ? {}
                      : { catalogDigest: machineCatalogDigest(provider) }),
                    workspaceSnapshots: workspaceSnapshotOrCatalog(provider, cwd, catalogOnDemand),
                  };
                }),
            };
          }),
        // T3-CUSTOM(expbkt3): BEGIN an app runs in its thread's session, so it needs thread access.
        [WS_METHODS.mcpAppsCallTool]: (input) =>
          requireMcpAppThreadAccess(input.threadId).pipe(
            Effect.andThen(mcpAppRequests.callTool(input)),
          ),
        [WS_METHODS.mcpAppsToolInfo]: (input) =>
          requireMcpAppThreadAccess(input.threadId).pipe(
            Effect.andThen(mcpAppRequests.toolInfo(input)),
          ),
        [WS_METHODS.mcpAppsUpdateModelContext]: (input) =>
          requireMcpAppThreadAccess(input.threadId).pipe(
            Effect.andThen(requireMcpAppThreadAccess(input.conversationThreadId)),
            Effect.andThen(mcpAppRequests.updateModelContext(input)),
          ),
        [WS_METHODS.mcpAppsReadResource]: (input) =>
          requireMcpAppThreadAccess(input.threadId).pipe(
            Effect.andThen(mcpAppRequests.readResource(input)),
          ),
        // T3-CUSTOM(expbkt3): END
        [WS_METHODS.providerMcpSignInStart]: (input) => mcpSignIn.start(input),
        [WS_METHODS.providerMcpSignInComplete]: (input) => mcpSignIn.complete(input),
        [WS_METHODS.providerUploadFeedback]:
          /* Request instrumentation already owns the span; keep this helper in that context. */
          Effect.fnUntraced(
            function* (input) {
              const projection = yield* threadManagement.getThreadRecords(input.threadId, [
                "providerThreads",
              ]);
              const providerThread =
                projection.providerThreads.find(
                  (candidate) => candidate.id === projection.thread.activeProviderThreadId,
                ) ?? projection.providerThreads.at(-1);
              const providerSessionId = providerThread?.providerSessionId ?? null;
              if (providerThread === undefined || providerSessionId === null) {
                return yield* new ProviderUploadFeedbackError({
                  threadId: input.threadId,
                  cause: "No provider session has run in this thread yet.",
                });
              }
              const runtime = Option.getOrNull(yield* providerSessionsV2.get(providerSessionId));
              if (runtime === null) {
                return yield* new ProviderUploadFeedbackError({
                  threadId: input.threadId,
                  cause: "The provider session is no longer running. Send a message first.",
                });
              }
              if (runtime.uploadFeedback === undefined) {
                return yield* new ProviderUploadFeedbackError({
                  threadId: input.threadId,
                  cause: `Provider '${runtime.driver}' does not support feedback uploads.`,
                });
              }
              return yield* runtime.uploadFeedback({
                providerThread,
                ...(input.reason === undefined ? {} : { reason: input.reason }),
              });
            },
            (effect, input) =>
              effect.pipe(
                Effect.mapError((cause) =>
                  isProviderUploadFeedbackError(cause)
                    ? cause
                    : new ProviderUploadFeedbackError({
                        threadId: input.threadId,
                        cause,
                      }),
                ),
              ),
          ),
        [WS_METHODS.serverUpdateProvider]: (input) =>
          providerMaintenanceRunner.updateProvider(input),
        [WS_METHODS.providerConsumeResetCredit]:
          /* Request instrumentation already owns the span; keep this helper in that context. */
          Effect.fnUntraced(function* (input) {
            if ("sourceId" in input) return yield* usageLimitSources.consumeResetCredit(input);
            const instance = yield* providerInstances.getInstance(input.instanceId);
            if (instance === undefined || !instance.enabled) {
              return yield* new ProviderSetupError({
                instanceId: input.instanceId,
                operation: "consume-reset-credit",
                detail: instance ? "This provider is disabled." : "Provider instance not found.",
              });
            }
            if (instance.consumeResetCredit === undefined) {
              return yield* new ProviderSetupError({
                instanceId: input.instanceId,
                operation: "consume-reset-credit",
                detail: "This provider does not bank reset credits.",
              });
            }
            const outcome = yield* instance.consumeResetCredit(input.creditId).pipe(
              Effect.mapError(
                (error) =>
                  new ProviderSetupError({
                    instanceId: input.instanceId,
                    operation: "consume-reset-credit",
                    detail: error.detail,
                    cause: error,
                  }),
              ),
            );
            return { outcome };
          }),
        [WS_METHODS.providerAuthStart]: (input) => providerAuth.start(input, currentSessionId),
        [WS_METHODS.providerAuthRespond]: (input) =>
          Effect.annotateCurrentSpan({ instanceId: input.instanceId }).pipe(
            Effect.andThen(providerAuth.respond(input, currentSessionId)),
          ),
        [WS_METHODS.providerAuthComplete]: (input) =>
          providerAuth.complete(input, currentSessionId),
        [WS_METHODS.chatGptReconnectProfile]: (input) => providerAuth.reconnectProfile(input),
        [WS_METHODS.chatGptImportProfile]: (input) => providerAuth.importProfile(input),
        [WS_METHODS.chatGptHandoffSubscribe]: (input) =>
          subscribeChatGptHandoff(input, currentSessionId),
        [WS_METHODS.providerAuthCancel]: (input) => providerAuth.cancel(input, currentSessionId),
        [WS_METHODS.providerAuthRemoveMethod]: (input) => providerAuth.removeMethod(input),
        [WS_METHODS.providerAuthLogout]: (input) => providerAuth.logout(input),
        [WS_METHODS.providerAuthSubscribe]: (input) =>
          providerAuth.subscribe(input, currentSessionId),
        [WS_METHODS.providerInstallStart]: (input) => providerInstallation.start(input),
        [WS_METHODS.providerInstallCancel]: (input) => providerInstallation.cancel(input),
        [WS_METHODS.providerInstallSubscribe]: (input) => providerInstallation.subscribe(input),
        [WS_METHODS.providerInstallRemove]: (input) => providerInstallation.remove(input),
        [WS_METHODS.serverUpdateServer]: (input) => serverSelfUpdate.update(input),
        [WS_METHODS.serverGetNpmRelease]: (input) => npmRelease.get(input),
        [WS_METHODS.serverUpdateServerWithProgress]: (input) =>
          ServerSelfUpdate.updateProgressStream(serverSelfUpdate, input),
        [WS_METHODS.serverCommitDesktopUpdate]: (input) =>
          serverSelfUpdate.commitDesktopUpdate(input.requestId),
        [WS_METHODS.serverUpsertKeybinding]:
          /* Request instrumentation already owns the span; keep this helper in that context. */
          Effect.fnUntraced(function* (rule) {
            return yield* keybindings.upsertKeybindingRule(rule);
          }),
        [WS_METHODS.serverRemoveKeybinding]:
          /* Request instrumentation already owns the span; keep this helper in that context. */
          Effect.fnUntraced(function* (rule) {
            return yield* keybindings.removeKeybindingRule(rule);
          }),
        [WS_METHODS.serverRunStorageCleanup]: () => storageCleanup.runNow,
        [WS_METHODS.serverGetStorageCleanupReport]: () => storageCleanup.reports,
        [WS_METHODS.serverGetDatabaseStorage]: () => databaseStorage.status,
        [WS_METHODS.serverReclaimDatabaseSpace]: () => databaseStorage.requestReclaim,
        [WS_METHODS.peerLinksList]: (_input) =>
          peerLinks.list.pipe(Effect.map((links) => ({ links }))),
        [WS_METHODS.peerLinksNames]: (_input) =>
          peerLinks.names.pipe(Effect.map((links) => ({ links }))),
        [WS_METHODS.peerLinksLink]: (input) => peerLinks.link(input),
        [WS_METHODS.peerLinksUnlink]: ({ environmentId }) => peerLinks.unlink(environmentId),
        // T3-CUSTOM(expbkt3): BEGIN a link's credential is not scoped to the local caller,
        // so only admins and operators read or answer linked threads through it.
        [WS_METHODS.peerLinksSubscribeThread]: (input) =>
          workflowsAllowed
            ? peerThreadRelay.subscribe(input)
            : Stream.fail(adminOnlyError(peerAdminMessage)),
        [WS_METHODS.peerLinksThreadHistoryPage]: (input) =>
          Effect.annotateCurrentSpan({ "orchestration_v2.thread_id": input.threadId }).pipe(
            Effect.andThen(withAdminAccess(peerAdminMessage, peerThreadRelay.historyPage(input))),
          ),
        [WS_METHODS.peerLinksThreadItem]: (input) =>
          Effect.annotateCurrentSpan({ "orchestration_v2.thread_id": input.threadId }).pipe(
            Effect.andThen(withAdminAccess(peerAdminMessage, peerThreadRelay.item(input))),
          ),
        // T3-CUSTOM(expbkt3): END
        [WS_METHODS.peerLinksPairClient]: (input) =>
          peerClientPairing.request(input, currentSession),
        [WS_METHODS.peerLinksPairLink]: (input) =>
          peerClientPairing.requestForLink(input, currentSession),
        [WS_METHODS.peerLinksAnswerRequest]: (input) =>
          Effect.annotateCurrentSpan({ "orchestration_v2.thread_id": input.threadId }).pipe(
            // T3-CUSTOM(expbkt3)
            Effect.andThen(withAdminAccess(peerAdminMessage, peerLinkRequests.answer(input))),
          ),
        [WS_METHODS.serverGetSettings]: (_input) =>
          Effect.map(serverSettings.getSettings, (settings) =>
            ServerSettings.redactServerSettingsForClient(settings, settingsClient),
          ),
        // T3-CUSTOM(expbkt3): BEGIN — profile metadata guard and user-administrator settings.
        [WS_METHODS.serverUpdateSettings]: ({ patch, providerInstanceMutation }) => {
          // Profile metadata is writable only through the credential-aware
          // source-control profile RPCs. A generic settings client must not be
          // able to replace a validated login/account binding.
          const { sourceControlProfiles: _ignoredProfileMetadata, ...clientWritablePatch } = patch;
          const requiresUserAdministrator =
            patch.environmentUserIdentityMode !== undefined ||
            patch.sourceControlIdentityMode !== undefined;
          return Effect.gen(function* () {
            if (requiresUserAdministrator) {
              yield* environmentUsers.assertAdministrator(currentSessionId);
            }
            const deviceHosts = patch.deviceHosts
              ? yield* remoteSshDeviceHosts(patch.deviceHosts).pipe(
                  Effect.provide(deviceHostContext),
                )
              : undefined;
            const nextPatch = { ...clientWritablePatch, ...(deviceHosts ? { deviceHosts } : {}) };
            const settings = yield* providerInstanceMutation === undefined
              ? serverSettings.updateSettings(nextPatch)
              : serverSettings.updateProviderInstance(providerInstanceMutation, nextPatch);
            if (patch.environmentUserIdentityMode === "required") {
              yield* environmentUsers.revokeUnidentifiedSessions;
            }
            return ServerSettings.redactServerSettingsForClient(settings, settingsClient);
          });
        },
        // T3-CUSTOM(expbkt3): END
        [WS_METHODS.serverDiscoverSourceControl]: (_input) => sourceControlDiscovery.discover,
        [WS_METHODS.serverCheckSecretSource]: (input) => secretCheck.check(input.source),
        [WS_METHODS.serverGetTraceDiagnostics]: (_input) =>
          TraceDiagnostics.readTraceDiagnostics({
            traceFilePath: config.serverTracePath,
            maxFiles: config.traceMaxFiles,
          }),
        [WS_METHODS.serverGetProcessDiagnostics]: (_input) => processDiagnostics.read,
        [WS_METHODS.serverGetHostResources]: (_input) => hostResources.read,
        [WS_METHODS.serverGetProcessResourceHistory]: (input) =>
          processResourceMonitor.readHistory(input),
        [WS_METHODS.serverGetResourceTelemetryHistory]: (input) =>
          resourceTelemetry.readHistory(input),
        [WS_METHODS.serverGetUsageSummary]: (input) => usage.readSummary(input),
        [WS_METHODS.serverRefreshUsageRates]: (_input) => usage.refreshRates,
        [WS_METHODS.serverRetryResourceTelemetry]: (_input) => resourceTelemetry.retry,
        [WS_METHODS.serverCheckOtlpEndpoint]: (input) => otlpEndpointCheck.check(input),
        [WS_METHODS.serverListTextGeneratorModels]: (input) => textGenerators.listModels(input),
        [WS_METHODS.serverPrepareTriage]: (input) => triage.prepare(input),
        [WS_METHODS.serverSignalProcess]: (input) => processDiagnostics.signal(input),
        [WS_METHODS.serverReportClientActivity]: (input, metadata) =>
          Ref.update(rpcClientIds, (clientIds) => {
            const next = new Set(clientIds);
            next.add(RpcClientId.make(metadata.client.id));
            return next;
          }).pipe(
            Effect.andThen(
              backgroundPolicy.reportClientActivity(
                currentSessionId,
                RpcClientId.make(metadata.client.id),
                input,
              ),
            ),
          ),
        [WS_METHODS.cloudGetRelayClientStatus]: (_input) => relayClient.resolve,
        [WS_METHODS.cloudInstallRelayClient]: (_input) =>
          Stream.callback<RelayClientInstallProgressEvent, RelayClientInstallFailedError>((queue) =>
            relayClient
              .installWithProgress((event) => Queue.offer(queue, event).pipe(Effect.asVoid))
              .pipe(
                Effect.flatMap((status) =>
                  Queue.offer(queue, {
                    type: "complete",
                    status,
                  }),
                ),
                Effect.catchTags({
                  RelayClientInstallError: (error) =>
                    Queue.fail(
                      queue,
                      new RelayClientInstallFailedError({
                        reason: error.reason,
                        message: error.message,
                      }),
                    ),
                }),
                Effect.andThen(Queue.end(queue)),
                Effect.forkScoped,
              ),
          ),
        [WS_METHODS.pullRequestsList]: (input) => pullRequests.list(input),
        [WS_METHODS.pullRequestsListStats]: (input) => pullRequests.listStats(input),
        [WS_METHODS.pullRequestsFilterOptions]: (input) => pullRequests.filterOptions(input),
        [WS_METHODS.pullRequestsRoutingIdentity]: (input) => pullRequests.routingIdentity(input),
        [WS_METHODS.pullRequestsRouting]: (input) => pullRequests.routing(input),
        [WS_METHODS.pullRequestsSummary]: (input) =>
          withPullRequestViewer(input, pullRequests.summary(input)),
        [WS_METHODS.pullRequestsStack]: (input) =>
          withPullRequestViewer(input, pullRequests.stack(input)),
        [WS_METHODS.pullRequestsLinkedThreads]: (input) =>
          resolvePullRequestSyncKey(input).pipe(
            Effect.flatMap((key) =>
              key === null
                ? Effect.succeed({ threads: [] })
                : listLinkedPullRequestThreads(key).pipe(
                    Effect.provideService(SqlClient.SqlClient, sql),
                  ),
            ),
          ),
        [WS_METHODS.pullRequestsDetail]: (input) =>
          withPullRequestViewer(input, openedPullRequestRead(pullRequests.detail(input))),
        [WS_METHODS.pullRequestsPreview]: (input) =>
          withPullRequestViewer(input, pullRequests.preview(input)),
        [WS_METHODS.pullRequestsChecks]: (input) =>
          withPullRequestViewer(input, pullRequests.checks(input)),
        [WS_METHODS.pullRequestsActivity]: (input) =>
          withPullRequestViewer(input, openedPullRequestRead(pullRequests.activity(input))),
        [WS_METHODS.pullRequestsReviewGuide]: (input) =>
          withPullRequestViewer(input, reviewGuides.get(input)),
        [WS_METHODS.pullRequestsGenerateReviewGuide]: (input) =>
          withPullRequestViewer(input, reviewGuides.generate(input)),
        [WS_METHODS.pullRequestsThreadComments]: (input) =>
          withPullRequestViewer(input, pullRequests.threadComments(input)),
        [WS_METHODS.pullRequestsDiffFileContents]: (input) =>
          withPullRequestViewer(input, pullRequests.diffFileContents(input)),
        [WS_METHODS.pullRequestsFilesViewed]: (input) =>
          withPullRequestViewer(input, pullRequests.filesViewed(input)),
        [WS_METHODS.pullRequestsChangeBreakdown]: (input) =>
          withPullRequestViewer(input, pullRequests.changeBreakdown(input)),
        [WS_METHODS.pullRequestsSetFilesViewed]: (input) =>
          withPullRequestViewer(input, pullRequests.setFilesViewed(input)),
        [WS_METHODS.pullRequestsRunAction]: (input) =>
          withPullRequestViewer(input, pullRequests.runAction(input)).pipe(
            Effect.tap(() =>
              resolvePullRequestSyncKey(input).pipe(
                Effect.flatMap((key) =>
                  key === null ? Effect.void : pullRequestSync.requestSync(key),
                ),
              ),
            ),
          ),
        [WS_METHODS.pullRequestsUpdate]: (input) =>
          withPullRequestViewer(input, pullRequests.update(input)),
        [WS_METHODS.pullRequestsComment]: (input) =>
          withPullRequestViewer(input, pullRequests.comment(input)),
        [WS_METHODS.pullRequestsUpdateComment]: (input) =>
          withPullRequestViewer(input, pullRequests.updateComment(input)),
        [WS_METHODS.pullRequestsSubmitReview]: (input) =>
          withPullRequestViewer(input, pullRequests.submitReview(input)),
        [WS_METHODS.pullRequestsReplyToThread]: (input) =>
          withPullRequestViewer(input, pullRequests.replyToThread(input)),
        [WS_METHODS.pullRequestsSetThreadResolution]: (input) =>
          withPullRequestViewer(input, pullRequests.setThreadResolution(input)),
        [WS_METHODS.pullRequestsSetReaction]: (input) =>
          withPullRequestViewer(input, pullRequests.setReaction(input)),
        [WS_METHODS.pullRequestsReportState]: (input) => pullRequests.reportState(input),
        [WS_METHODS.pullRequestsInvalidate]: (input) =>
          pullRequests
            .invalidate(input, { notifyReaders: true })
            .pipe(
              Effect.andThen(
                input.reference === undefined || input.filesViewedOnly === true
                  ? Effect.void
                  : resolvePullRequestSyncKey(input.reference).pipe(
                      Effect.flatMap((key) =>
                        key === null ? Effect.void : pullRequestSync.requestSync(key),
                      ),
                    ),
              ),
            ),
        [WS_METHODS.pullRequestsSubscribeRefreshes]: () => pullRequests.subscribeRefreshes,
        [WS_METHODS.pullRequestsSubscribeLinkedThreadRefreshes]: () =>
          pullRequests.subscribeLinkedThreadRefreshes,
        [WS_METHODS.pullRequestsReviewerCandidates]: (input) =>
          withPullRequestViewer(input, pullRequests.reviewerCandidates(input)),
        [WS_METHODS.pullRequestsRequestReviewers]: (input) =>
          withPullRequestViewer(input, pullRequests.requestReviewers(input)),
        [WS_METHODS.pullRequestsLabelCandidates]: (input) =>
          withPullRequestViewer(input, pullRequests.labelCandidates(input)),
        [WS_METHODS.pullRequestsSetLabels]: (input) =>
          withPullRequestViewer(input, pullRequests.setLabels(input)),
        // T3-CUSTOM(expbkt3): BEGIN — lookup and clone run under the selected source-control profile.
        [WS_METHODS.sourceControlLookupRepository]: Effect.fn("ws.sourceControl.lookupRepository")(
          function* (input: SourceControlRepositoryLookupInput) {
            const executionEnvironment = yield* resolveSelectedSourceControlEnvironment(
              input.sourceControlProfileId,
            );
            return yield* withSourceControlExecutionEnvironment(
              sourceControlRepositories.lookupRepository(input),
              executionEnvironment,
            );
          },
        ),
        [WS_METHODS.sourceControlCloneRepository]: Effect.fn("ws.sourceControl.cloneRepository")(
          function* (input: SourceControlCloneRepositoryInput) {
            const executionEnvironment = yield* resolveSelectedSourceControlEnvironment(
              input.sourceControlProfileId,
            );
            if (
              executionEnvironment !== null &&
              input.remoteUrl !== undefined &&
              githubSshRemoteToHttps(input.remoteUrl) !== null
            ) {
              return yield* new SourceControlProfileError({
                operation: "clone-repository",
                reason: "ssh-remote",
                detail: "Use the repository's HTTPS clone URL with a GitHub profile.",
                profileId: executionEnvironment.profileId,
              });
            }
            const cloneInput =
              executionEnvironment === null ? input : { ...input, protocol: "https" as const };
            return yield* withSourceControlExecutionEnvironment(
              sourceControlRepositories.cloneRepository(cloneInput),
              executionEnvironment,
            );
          },
        ),
        // T3-CUSTOM(expbkt3): END
        [WS_METHODS.sourceControlSignInStart]: (input) => sourceControlSignIn.start(input),
        [WS_METHODS.sourceControlSignInWait]: (input) => sourceControlSignIn.wait(input),
        [WS_METHODS.sourceControlSignInCancel]: (input) => sourceControlSignIn.cancel(input),
        [WS_METHODS.sourceControlAppAccess]: (input) => sourceControlSignIn.access(input),
        [WS_METHODS.sourceControlStarred]: (input) => sourceControlSignIn.starred(input),
        [WS_METHODS.sourceControlStar]: (input) => sourceControlSignIn.star(input),
        [WS_METHODS.projectCloneStart]: (input) =>
          projectCloneTracker.start(input, {
            createProject: (project) =>
              projectService
                .create({
                  commandId: CommandId.make(`project-clone-create:${project.projectId}`),
                  projectId: project.projectId,
                  title: project.title,
                  workspaceRoot: project.workspaceRoot,
                  createWorkspaceRootIfMissing: true,
                })
                .pipe(
                  Effect.asVoid,
                  Effect.mapError((cause) =>
                    cause._tag === "ProjectConflictError"
                      ? cause
                      : new OrchestrationDispatchCommandError({
                          message: "Failed to create clone project.",
                          cause,
                        }),
                  ),
                ),
            onCloned: (project) =>
              repositoryIdentityResolver.resolve(project.workspaceRoot, { refresh: true }).pipe(
                Effect.andThen(
                  projectService.update({
                    commandId: CommandId.make(`project-clone-done:${project.projectId}`),
                    projectId: project.projectId,
                  }),
                ),
                Effect.andThen(refreshGitStatus(project.workspaceRoot)),
                // The folder was empty when the project was created, so the cached
                // enrichment says "no repository" and clients cannot group it yet.
                Effect.andThen(projectEnrichment.invalidate([project.workspaceRoot])),
                Effect.andThen(projectEnrichment.request(project.workspaceRoot)),
                Effect.ignoreCause({ log: true }),
              ),
          }),
        [WS_METHODS.projectsEnsureScratch]: () =>
          managedFolders.ensureScratchProject.pipe(
            Effect.mapError(
              (cause) => new OrchestrationDispatchCommandError({ message: cause.message, cause }),
            ),
          ),
        [WS_METHODS.projectsCreateNew]: (input) =>
          managedFolders
            .createNamedProject(input)
            .pipe(
              Effect.mapError(
                (cause) => new OrchestrationDispatchCommandError({ message: cause.message, cause }),
              ),
            ),
        [WS_METHODS.projectsCreateFromThread]: (input) =>
          scratchThreadPromotion
            // T3-CUSTOM(expbkt3): promotion moves threads, so each one needs this user's access.
            .promote(input, {
              authorize: (threadIds) =>
                Effect.forEach(threadIds, (threadId) => requireThreadAccess(threadId), {
                  discard: true,
                }).pipe(
                  Effect.mapError(
                    () =>
                      new ScratchThreadPromotion.ScratchThreadPromotionError({
                        reason: "Thread not found.",
                      }),
                  ),
                ),
            })
            .pipe(
              Effect.mapError(
                (cause) => new OrchestrationDispatchCommandError({ message: cause.message, cause }),
              ),
            ),
        [WS_METHODS.projectCloneCancel]: (input) =>
          projectCloneTracker.cancel(input.projectId).pipe(Effect.map((applied) => ({ applied }))),
        [WS_METHODS.projectCloneRetry]: (input) =>
          projectCloneTracker.retry(input.projectId).pipe(Effect.map((applied) => ({ applied }))),
        [WS_METHODS.subscribeProjectClones]: () => projectCloneTracker.stream,
        // T3-CUSTOM(expbkt3): BEGIN — publish runs under the selected source-control profile.
        [WS_METHODS.sourceControlPublishRepository]: Effect.fn(
          "ws.sourceControl.publishRepository",
        )(function* (input: SourceControlPublishRepositoryInput) {
          const executionEnvironment = yield* resolveSelectedSourceControlEnvironment(
            input.sourceControlProfileId,
          );
          const publishInput =
            executionEnvironment === null ? input : { ...input, protocol: "https" as const };
          return yield* withSourceControlExecutionEnvironment(
            sourceControlRepositories.publishRepository(publishInput).pipe(
              // A failed push still leaves the new remote added.
              Effect.ensuring(
                repositoryIdentityResolver
                  .resolve(input.cwd, { refresh: true })
                  .pipe(Effect.andThen(refreshGitStatus(input.cwd))),
              ),
            ),
            executionEnvironment,
          );
        }),
        // T3-CUSTOM(expbkt3): END
        [WS_METHODS.projectsSearchEntries]: (input) =>
          workspaceEntries.search(input).pipe(
            Effect.mapError(
              (cause) =>
                new ProjectSearchEntriesError({
                  cwd: input.cwd,
                  queryLength: input.query.length,
                  limit: input.limit,
                  ...projectEntriesFailureContext(cause),
                  cause,
                }),
            ),
          ),
        [WS_METHODS.projectsSearchContents]: (input) =>
          workspaceEntries.searchContents(input).pipe(
            Effect.mapError(
              (cause) =>
                new ProjectSearchContentsError({
                  cwd: input.cwd,
                  queryLength: input.query.length,
                  limit: input.limit,
                  ...projectEntriesFailureContext(cause),
                  cause,
                }),
            ),
          ),
        [WS_METHODS.projectsListEntries]: (input) =>
          workspaceEntries.list(input).pipe(
            Effect.mapError(
              (cause) =>
                new ProjectListEntriesError({
                  ...input,
                  ...projectEntriesFailureContext(cause),
                  cause,
                }),
            ),
          ),
        [WS_METHODS.projectsListIgnoredFiles]: (input) =>
          workspaceEntries.listIgnoredFiles(input).pipe(
            Effect.mapError(
              (cause) =>
                new ProjectListEntriesError({
                  ...input,
                  ...projectEntriesFailureContext(cause),
                  cause,
                }),
            ),
          ),
        [WS_METHODS.projectsReadFile]: (input) =>
          workspaceFileSystem.readFile(input).pipe(
            Effect.mapError(
              (cause) =>
                new ProjectReadFileError({
                  ...input,
                  ...projectFileFailureContext(cause),
                  cause,
                }),
            ),
          ),
        [WS_METHODS.projectsWriteFile]: (input) =>
          workspaceFileSystem.writeFile(input).pipe(
            Effect.mapError(
              (cause) =>
                new ProjectWriteFileError({
                  cwd: input.cwd,
                  relativePath: input.relativePath,
                  ...projectFileFailureContext(cause),
                  cause,
                }),
            ),
          ),
        [WS_METHODS.projectsMutate]: (mutation) =>
          startup.enqueueCommand(mutateProject(mutation)).pipe(
            Effect.mapError(
              (cause) =>
                new ProjectMutationError({
                  commandId: mutation.commandId,
                  message:
                    cause._tag === "ProjectNotEmptyError" || cause._tag === "ProjectInvalidError"
                      ? cause.message
                      : "Failed to mutate project.",
                  cause,
                }),
            ),
          ),
        [WS_METHODS.shellOpenInEditor]: (input) => externalLauncher.launchEditor(input),
        [WS_METHODS.filesystemGetMetadata]: (input) => workspaceFileSystem.getMetadata(input),
        [WS_METHODS.filesystemBrowse]: (input) =>
          workspaceEntries.browse(input).pipe(
            Effect.mapError(
              (cause) =>
                new FilesystemBrowseError({
                  ...input,
                  ...filesystemBrowseFailureContext(cause),
                  cause,
                }),
            ),
          ),
        [WS_METHODS.workspaceListFolders]: (input) => workspaceFolders.list(input),
        [WS_METHODS.workspaceScanFolders]: (input) => workspaceFolders.scan(input),
        [WS_METHODS.workspaceTaskFolder]: (input) =>
          taskFolders.find(input.worktreePath).pipe(Effect.map((taskFolder) => ({ taskFolder }))),
        // T3-CUSTOM(expbkt3): adding a repository changes the thread's worktree, so it needs
        // thread access.
        [WS_METHODS.workspaceAddTaskFolderRepository]: (input) =>
          requireThreadAccess(input.threadId).pipe(
            Effect.mapError(
              () =>
                new EnvironmentAuthorizationError({
                  message: "Thread not found.",
                  requiredScope: "orchestration:operate",
                }),
            ),
            Effect.andThen(taskFolders.addRepository(input)),
          ),
        [WS_METHODS.attachmentsCreateUploadUrl]: (input) => issueAttachmentUploadUrl(input),
        [WS_METHODS.attachmentsDelete]: (input) => deletePendingAttachment(input.attachmentId),
        [WS_METHODS.agentSessionsScan]: () => agentSessionScanner.scan,
        // T3-CUSTOM(expbkt3): imports require the authenticated project access. Request
        // instrumentation already owns the span, so this handler stays untraced.
        [WS_METHODS.agentSessionsImport]: Effect.fnUntraced(function* (input) {
          if (
            actorUserId !== null &&
            !(yield* accessControl
              .canAccessProject(actorUserId, input.projectId)
              .pipe(Effect.orElseSucceed(() => false)))
          )
            return yield* new EnvironmentAuthorizationError({
              message: "Project not found.",
              requiredScope: "orchestration:operate",
            });
          return yield* agentSessionImporter.importRecentAgentThreads(input);
        }), // T3-CUSTOM(expbkt3): imports retain actor ownership and visibility.
        [WS_METHODS.assetsCreateUrl]:
          /* Request instrumentation already owns the span; keep this helper in that context. */
          Effect.fnUntraced(function* (input) {
            const path = yield* Path.Path;
            if (
              input.resource._tag === "attachment" ||
              input.resource._tag === "native-app-icon" ||
              input.resource._tag === "environment-theme-background" ||
              input.resource._tag === "tool-output-image" ||
              input.resource._tag === SOURCE_CONTROL_MEDIA_ASSET ||
              // A network path is served only from the thread's project, looked up below.
              (input.resource._tag === "media-file" &&
                path.isAbsolute(input.resource.path) &&
                !isNetworkPath(input.resource.path))
            ) {
              return yield* issueAssetUrl({ resource: input.resource });
            }
            if (input.resource._tag === "draft-workspace-file") {
              return yield* issueAssetUrl({
                resource: input.resource,
                workspaceRoot: input.resource.cwd,
              });
            }
            if (input.resource._tag === "project-favicon") {
              const project = yield* projectStore
                .findActiveByWorkspaceRoot(input.resource.cwd)
                .pipe(
                  Effect.mapError(
                    (cause) =>
                      new AssetWorkspaceContextResolutionError({
                        resource: input.resource,
                        cause,
                      }),
                  ),
                );
              if (Option.isNone(project)) {
                return yield* new AssetWorkspaceContextNotFoundError({
                  resource: input.resource,
                });
              }
              // Clone projects precede their files; clients retry asset URLs after clone completion.
              const clone = yield* projectCloneTracker.get(project.value.projectId);
              return yield* issueAssetUrl({
                resource: input.resource,
                ...(project.value.faviconPath
                  ? { projectFaviconPath: project.value.faviconPath }
                  : {}),
                ...(clone !== null && clone.destinationPath === project.value.workspaceRoot
                  ? { projectCheckout: clone.phase === "done" ? "cloned" : "pending" }
                  : {}),
              });
            }
            const thread = yield* threadManagement
              .getThreadRecords(input.resource.threadId, [])
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new AssetWorkspaceContextResolutionError({
                      resource: input.resource,
                      cause,
                    }),
                ),
              );
            const project = yield* projectService.getById(thread.thread.projectId).pipe(
              Effect.mapError(
                (cause) =>
                  new AssetWorkspaceContextResolutionError({
                    resource: input.resource,
                    cause,
                  }),
              ),
            );
            if (Option.isNone(project)) {
              return yield* new AssetWorkspaceContextNotFoundError({
                resource: input.resource,
              });
            }
            return yield* issueAssetUrl({
              resource: input.resource,
              workspaceRoot: thread.thread.worktreePath ?? project.value.workspaceRoot,
            });
          }),
        [WS_METHODS.assetsPersistChatAttachments]: (input) =>
          persistChatAttachments(input).pipe(Effect.map((attachments) => ({ attachments }))),
        [WS_METHODS.subscribeVcsBranch]: (input) => vcsStatusBroadcaster.streamBranchStatus(input),
        [WS_METHODS.vcsRefreshBranch]: (input) =>
          vcsStatusBroadcaster.refreshBranchStatus(input).pipe(Effect.asVoid),
        // T3-CUSTOM(expbkt3): retain per-thread credential and action isolation.
        [WS_METHODS.subscribeVcsStatus]: (input) =>
          withThreadSourceControlStream(input.threadId, vcsStatusBroadcaster.streamStatus(input)),
        [WS_METHODS.subscribeWorktreeSetup]: (input) => worktreeSetupTracker.stream(input.threadId),
        [WS_METHODS.worktreeSetupCancel]: (input) =>
          worktreeSetupTracker
            .cancel(input.threadId)
            .pipe(Effect.map((cancelled) => ({ cancelled }))),
        // T3-CUSTOM(expbkt3): retain per-thread credential and action isolation.
        [WS_METHODS.vcsRefreshStatus]: (input) =>
          withThreadSourceControl(
            input.threadId,
            vcsStatusBroadcaster.refreshStatus(input.cwd, { localOnly: input.localOnly ?? false }),
          ),
        // T3-CUSTOM(expbkt3): retain per-thread credential and action isolation.
        [WS_METHODS.vcsPull]: (input) =>
          withThreadActionLock(
            input.threadId,
            Effect.gen(function* () {
              yield* ensureGitHubRemotesUseHttps(input);
              return yield* withThreadSourceControl(
                input.threadId,
                gitWorkflow.pullCurrentBranch(input.cwd).pipe(
                  Effect.matchCauseEffect({
                    onFailure: (cause) => Effect.failCause(cause),
                    onSuccess: (result) =>
                      refreshGitStatus(input.cwd).pipe(
                        Effect.ignore({ log: true }),
                        Effect.as(result),
                      ),
                  }),
                ),
              );
            }),
          ),
        // T3-CUSTOM(expbkt3): preserve actor credentials while retaining native PR refresh.
        [WS_METHODS.gitRunStackedAction]: (input) =>
          withThreadSourceControlStream(
            input.threadId,
            Stream.callback<
              GitActionProgressEvent,
              GitManagerServiceError | SourceControlProfileError
            >((queue) =>
              withThreadActionLock(
                input.threadId,
                Effect.gen(function* () {
                  if (input.action !== "commit") yield* ensureGitHubRemotesUseHttps(input);
                  return yield* gitWorkflow
                    .runStackedAction(input, {
                      actionId: input.actionId,
                      progressReporter: {
                        publish: (event) => Queue.offer(queue, event).pipe(Effect.asVoid),
                      },
                    })
                    .pipe(
                      Effect.matchCauseEffect({
                        // Earlier steps (branch, commit) may have landed before the failing one.
                        onFailure: (cause) =>
                          refreshGitStatus(input.cwd).pipe(
                            Effect.andThen(Queue.failCause(queue, cause)),
                          ),
                        onSuccess: (result) =>
                          (input.threadId === undefined
                            ? Effect.void
                            : linkCreatedPullRequest({
                                threadId: input.threadId,
                                cwd: input.cwd,
                                result,
                                commandId: serverCommandId("pr-created-link"),
                              }).pipe(
                                Effect.provideService(
                                  Orchestrator.OrchestratorV2,
                                  orchestrationEngine,
                                ),
                                Effect.provideService(
                                  ProjectService.ProjectService,
                                  projectService,
                                ),
                                Effect.provideService(
                                  RepositoryIdentityResolver.RepositoryIdentityResolver,
                                  repositoryIdentityResolver,
                                ),
                              )
                          ).pipe(
                            Effect.andThen(
                              refreshPushedPullRequests(input, result).pipe(
                                Effect.provideService(
                                  Orchestrator.OrchestratorV2,
                                  orchestrationEngine,
                                ),
                                Effect.provideService(ProjectStore.ProjectStoreV2, projectStore),
                                Effect.provideService(
                                  PullRequestService.PullRequestService,
                                  pullRequests,
                                ),
                              ),
                            ),
                            Effect.andThen(refreshGitStatus(input.cwd)),
                            Effect.andThen(Queue.end(queue).pipe(Effect.asVoid)),
                          ),
                      }),
                    );
                }),
              ).pipe(Effect.catchCause((cause) => Queue.failCause(queue, cause))),
            ),
          ),
        // T3-CUSTOM(expbkt3): retain per-thread credential and action isolation.
        [WS_METHODS.gitResolvePullRequest]: (input) =>
          withThreadSourceControl(input.threadId, gitWorkflow.resolvePullRequest(input)),
        // T3-CUSTOM(expbkt3): retain per-thread credential and action isolation.
        [WS_METHODS.gitPreparePullRequestThread]: (input) =>
          withThreadActionLock(
            input.threadId,
            Effect.gen(function* () {
              if (input.mode === "local") {
                yield* assertCheckoutIdle("GitWorkflowService.preparePullRequestThread", input.cwd);
              }
              yield* ensureGitHubRemotesUseHttps(input);
              return yield* withThreadSourceControl(
                input.threadId,
                gitWorkflow
                  .preparePullRequestThread(input)
                  .pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
              );
            }),
          ),
        [WS_METHODS.vcsListRefs]: (input) => gitWorkflow.listRefs(input),
        [WS_METHODS.vcsCreateWorktree]: (input) =>
          // A project that tracks repositories gets a task folder, as its new worktree threads do.
          taskFolders.createForProjectFolder(input).pipe(
            Effect.mapError(
              (cause) =>
                new GitCommandError({
                  operation: "TaskFolders.create",
                  command: "git worktree add",
                  cwd: input.cwd,
                  detail: cause.detail,
                }),
            ),
            Effect.filterOrElse(
              (created) => created !== null,
              () => gitWorkflow.createWorktree(input),
            ),
            Effect.tap(() => refreshGitStatus(input.cwd)),
          ),
        [WS_METHODS.vcsRemoveWorktree]: (input) =>
          // A thread's worktree may be a task folder: its repositories' worktrees go with it.
          taskFolders.removeIfTaskFolder({ path: input.path, force: input.force === true }).pipe(
            Effect.mapError(
              (cause) =>
                new GitCommandError({
                  operation: "TaskFolders.remove",
                  command: "git worktree remove",
                  cwd: input.cwd,
                  detail: cause.detail,
                }),
            ),
            Effect.flatMap((removed) =>
              removed ? Effect.void : gitWorkflow.removeWorktree(input),
            ),
            // No project-root refresh here: the client awaits vcs.refreshStatus right after, and a
            // second refresh would queue behind this one and reread an unchanged repository.
            // Subscribers of the removed checkout learn it is no longer a repository.
            Effect.tap(() =>
              vcsStatusBroadcaster
                .refreshLocalStatus(input.path)
                .pipe(Effect.ignoreCause({ log: true }), Effect.forkDetach, Effect.asVoid),
            ),
          ),
        [WS_METHODS.vcsCreateRef]: (input) =>
          (input.switchRef
            ? assertCheckoutIdle("GitWorkflowService.createRef", input.cwd)
            : Effect.void
          ).pipe(
            Effect.andThen(gitWorkflow.createRef(input)),
            Effect.tap(() =>
              input.switchRef
                ? vcsStatusBroadcaster.refreshAfterCheckout(input.cwd)
                : refreshGitStatus(input.cwd),
            ),
          ),
        [WS_METHODS.vcsSwitchRef]: (input) =>
          assertCheckoutIdle("GitWorkflowService.switchRef", input.cwd).pipe(
            Effect.andThen(gitWorkflow.switchRef(input)),
            Effect.tap(() => vcsStatusBroadcaster.refreshAfterCheckout(input.cwd)),
          ),
        [WS_METHODS.vcsInit]: (input) =>
          vcsProvisioning.initRepository(input).pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
        [WS_METHODS.reviewGetBranchCommits]: (input) => review.getBranchCommits(input),
        [WS_METHODS.reviewGetDiffPreview]: (input) => review.getDiffPreview(input),
        [WS_METHODS.reviewGetDiffFileContents]: (input) => review.getDiffFileContents(input),
        // T3-CUSTOM(expbkt3): retain per-thread credential and action isolation.
        [WS_METHODS.terminalOpen]: (input) =>
          withThreadActionLock(
            ThreadId.make(input.threadId),
            prepareTerminalLaunch(input).pipe(
              Effect.flatMap((launch) =>
                withThreadSourceControlEnvironment(launch.input).pipe(
                  Effect.flatMap((resolvedInput) =>
                    terminalManager
                      .open(resolvedInput)
                      .pipe(
                        Effect.provideService(TerminalManager.TerminalCwdRecovery, launch.recover),
                      ),
                  ),
                ),
              ),
            ),
          ),
        // T3-CUSTOM(expbkt3): retain per-thread credential and action isolation.
        [WS_METHODS.terminalAttach]: (input, metadata) =>
          Stream.unwrap(
            withThreadActionLock(
              ThreadId.make(input.threadId),
              prepareTerminalLaunch(input).pipe(
                Effect.flatMap((launch) =>
                  withThreadSourceControlEnvironment(launch.input).pipe(
                    Effect.map((resolvedInput) =>
                      terminalManager
                        .attachOutputStream(resolvedInput, terminalViewerId(metadata))
                        .pipe(
                          Stream.provideService(
                            TerminalManager.TerminalCwdRecovery,
                            launch.recover,
                          ),
                        ),
                    ),
                  ),
                ),
              ),
            ),
          ),
        // T3-CUSTOM(expbkt3): retain per-thread credential and action isolation.
        [WS_METHODS.terminalWrite]: (input, metadata) =>
          withThreadActionLock(
            ThreadId.make(input.threadId),
            terminalManager.write(input, terminalViewerId(metadata)),
          ),
        [WS_METHODS.terminalResize]: (input, metadata) =>
          terminalManager.resize(input, terminalViewerId(metadata)),
        [WS_METHODS.terminalClear]: (input) => terminalManager.clear(input),
        [WS_METHODS.terminalClose]: (input) => terminalManager.close(input),
        [WS_METHODS.terminalObserve]: (input) =>
          // T3-CUSTOM(expbkt3): observing a terminal reads thread output, so it needs thread access.
          Stream.unwrap(
            requireThreadAccess(ThreadId.make(input.threadId)).pipe(
              Effect.mapError(
                () =>
                  new EnvironmentAuthorizationError({
                    message: "Thread not found.",
                    requiredScope: RpcAuthorization.requiredScopeForRpcMethod(
                      WS_METHODS.terminalObserve,
                    ),
                  }),
              ),
              Effect.as(
                terminalOutputStream(
                  (listener, registerCleanup) =>
                    terminalManager.observeStream(input, listener, registerCleanup),
                  (listener, registerCleanup) =>
                    terminalManager.resyncStream(input, listener, registerCleanup),
                ),
              ),
            ),
          ),
        [WS_METHODS.subscribeTerminalMetadata]: (_input) =>
          Stream.callback<TerminalMetadataStreamEvent>((queue) =>
            Effect.acquireRelease(
              terminalManager.subscribeMetadata((event) => Queue.offer(queue, event)),
              (unsubscribe) => Effect.sync(unsubscribe),
            ),
          ),
        [WS_METHODS.previewOpen]: (input) => previewManager.open(input),
        [WS_METHODS.previewResize]: (input) => previewManager.resize(input),
        [WS_METHODS.previewAdjust]: (input) => previewManager.adjust(input),
        [WS_METHODS.previewClose]: (input) => previewManager.close(input),
        [WS_METHODS.previewList]: (input) => previewManager.list(input),
        [WS_METHODS.previewClearProfile]: (input) => serverBrowser.clearProfile(input.profileId),
        [WS_METHODS.previewReportProfiles]: (input) => reportProfiles(input),
        [WS_METHODS.previewReportStatus]: (input) => previewManager.reportStatus(input),
        [WS_METHODS.subscribePreviewEvents]: (_input) => previewManager.events,
        [WS_METHODS.deviceConfigure]: (input) => deviceService.configure(input),
        [WS_METHODS.deviceTestHost]: (input) => deviceService.testHost(input),
        [WS_METHODS.deviceEasAccount]: (input) => deviceService.easAccount(input),
        [WS_METHODS.deviceSimlockIdentity]: (input) => deviceService.simlockIdentity(input),
        [WS_METHODS.deviceList]: (input) =>
          input.inspectOnly && !input.updateTool
            ? deviceService.inspect
            : authorizeEffect(
                requiredScopeForDeviceList(input),
                input.updateTool
                  ? deviceService.updateTool(input.updateTool)
                  : input.retryHostId
                    ? deviceService.retryHost(input.retryHostId)
                    : deviceService.list,
              ),
        [WS_METHODS.deviceOpen]: (input) =>
          threadWorkspaceRoot(input.threadId).pipe(
            Effect.flatMap((workspaceRoot) => deviceService.open(input, { workspaceRoot })),
          ),
        [WS_METHODS.deviceClose]: (input) => deviceService.close(input),
        [WS_METHODS.deviceShutdown]: (input) => deviceService.shutdown(input),
        [WS_METHODS.deviceDetail]: (input) => deviceService.detail(input),
        [WS_METHODS.deviceAction]: (input) => deviceService.action(input),
        [WS_METHODS.subscribeDeviceState]: (_input) => DeviceService.stateStream(deviceService),
        [WS_METHODS.previewStopLocalServer]: (input) => portDiscovery.stopServer(input),
        [WS_METHODS.subscribeDiscoveredLocalServers]: (input) =>
          Stream.callback<DiscoveredLocalServerList>((queue) =>
            Effect.gen(function* () {
              const configuredUrls = input.configuredUrls ?? [];
              yield* portDiscovery.retain;
              const initial = yield* portDiscovery.scan(configuredUrls);
              const initialScannedAt = DateTime.formatIso(yield* DateTime.now);
              yield* Queue.offer(queue, {
                servers: initial,
                scannedAt: initialScannedAt,
                configuredUrlProbing: true,
              });
              yield* portDiscovery.subscribe(
                { configuredUrls, initialSnapshot: initial },
                (servers) =>
                  Effect.gen(function* () {
                    const scannedAt = DateTime.formatIso(yield* DateTime.now);
                    yield* Queue.offer(queue, {
                      servers,
                      scannedAt,
                      configuredUrlProbing: true,
                    });
                  }),
              );
            }),
          ),
        [WS_METHODS.subscribeServerConfig]: (input) =>
          Stream.unwrap(
            Effect.gen(function* () {
              const usageLimitsCommand = input.usageLimitsCommand === true;
              const workspaceSnapshotsOnDemand = input.workspaceSnapshotsOnDemand === true;
              // Only providers that can scan a cwd answer the client's on-demand catalog fetch.
              // Read per update, since a replaced instance can change that.
              const currentCatalogsPerCwd =
                workspaceSnapshotsOnDemand && input.providerCatalogsOnDemand === true
                  ? providerInstances.listInstances.pipe(
                      Effect.map(
                        (instances) =>
                          new Set(
                            instances
                              .filter((instance) => instance.snapshotForCwd !== undefined)
                              .map((instance) => instance.instanceId),
                          ),
                      ),
                    )
                  : Effect.succeed(new Set<string>());
              const catalogDigests = input.providerCatalogDigests === true;
              // Buffer changes through discovery and the initial snapshot's send.
              const keybindingsChanges = yield* keybindings.subscribeChanges;
              const settingsChanges = yield* serverSettings.subscribeChanges;
              const remoteTargets = yield* Effect.forkScoped(remoteOpenTargets.resolveTargets(), {
                startImmediately: true,
              });
              const directResult = yield* Effect.forkScoped(
                directEndpoints
                  .resolve()
                  .pipe(Effect.catchCause(() => directEndpoints.resolveAvailable())),
                { startImmediately: true },
              );
              const config = yield* loadServerConfig({
                usageLimitsCommand,
                workspaceSnapshotsOnDemand,
                deferNetworkDiscovery: true,
                catalogsPerCwd: yield* currentCatalogsPerCwd,
                catalogDigests,
              });
              const keybindingsUpdates = keybindingsChanges.pipe(
                Stream.map((event) => ({
                  version: 1 as const,
                  type: "keybindingsUpdated" as const,
                  payload: {
                    keybindings: event.keybindings,
                    issues: event.issues,
                  },
                })),
              );
              const providerStatuses = Stream.zipLatestWith(
                // Seed the changes-only stream so early source refreshes pair with current providers.
                Stream.concat(
                  Stream.fromEffect(providerRegistry.getProviders),
                  providerRegistry.streamChanges,
                ),
                usageLimitSources.streamChanges.pipe(
                  Stream.changesWith(
                    usageLimitsCommand ? sameUsageLimitCommandCoverage : () => true,
                  ),
                ),
                (providers, sources) =>
                  usageLimitsCommand ? withUsageLimitsCommands(providers, sources) : providers,
              ).pipe(
                // Stripped before the de-dupe below, so snapshot-only changes send nothing.
                Stream.mapEffect((commandProviders) =>
                  workspaceSnapshotsOnDemand
                    ? currentCatalogsPerCwd.pipe(
                        Effect.map((catalogsPerCwd) =>
                          withoutWorkspaceSnapshots(
                            commandProviders,
                            catalogsPerCwd,
                            catalogDigests,
                          ),
                        ),
                      )
                    : Effect.succeed(commandProviders),
                ),
                // Compare initial paired values with the snapshot; blindly dropping them loses changes between snapshot and subscription.
                (updates) => Stream.concat(rpcInitialItems([config.providers]), updates),
                Stream.changesWith(
                  (previous, next) => JSON.stringify(previous) === JSON.stringify(next),
                ),
                Stream.drop(1),
                Stream.map((providers) => ({
                  version: 1 as const,
                  type: "providerStatuses" as const,
                  payload: { providers },
                })),
                Stream.debounce(Duration.millis(PROVIDER_STATUS_DEBOUNCE_MS)),
              );
              // Gate capability-specific events; older clients reject them and lose their config subscription.
              const environmentThemeUpdates =
                input.environmentThemes === true
                  ? environmentTheme.streamChanges.pipe(
                      Stream.map((themes) => ({
                        version: 1 as const,
                        type: "environmentThemesUpdated" as const,
                        payload: { themes },
                      })),
                    )
                  : Stream.empty;
              const usageLimitSourceUpdates =
                input.usageLimitSources === true
                  ? usageLimitSources.streamChanges.pipe(
                      Stream.map((sources) => ({
                        version: 1 as const,
                        type: "usageLimitSourcesUpdated" as const,
                        payload: { sources },
                      })),
                    )
                  : Stream.empty;
              const settingsUpdates = settingsChanges.pipe(
                Stream.map((settings) =>
                  ServerSettings.redactServerSettingsForClient(settings, settingsClient),
                ),
                Stream.map((settings) => ({
                  version: 1 as const,
                  type: "settingsUpdated" as const,
                  payload: { settings },
                })),
              );

              const liveUpdates = Stream.merge(
                keybindingsUpdates,
                Stream.merge(
                  providerStatuses,
                  Stream.merge(
                    settingsUpdates,
                    Stream.merge(environmentThemeUpdates, usageLimitSourceUpdates),
                  ),
                ),
              );

              const remoteResult = yield* Effect.sync(() => remoteTargets.pollUnsafe());
              const initialConfig =
                remoteResult?._tag === "Success"
                  ? { ...config, remoteOpenTargets: remoteResult.value }
                  : config;
              const updates = withLateConfigDiscovery(
                initialConfig,
                liveUpdates,
                externalLauncher,
                {
                  resolveTargets: () => Fiber.join(remoteTargets),
                },
                { resolve: () => Fiber.join(directResult) },
              );
              return Stream.concat(
                rpcInitialItems([
                  { version: 1 as const, type: "snapshot" as const, config: initialConfig },
                ]),
                input.providerStatusDeltas === true
                  ? updates.pipe(withProviderStatusDeltas(initialConfig.providers))
                  : updates,
              );
            }),
          ),
        [WS_METHODS.subscribeServerLifecycle]: (_input) =>
          Stream.unwrap(
            Effect.gen(function* () {
              const liveBuffer = yield* Queue.unbounded<ServerLifecycleStreamEvent>();
              yield* Effect.forkScoped(
                lifecycleEvents.stream.pipe(
                  Stream.runForEach((event) => Queue.offer(liveBuffer, event)),
                ),
                { startImmediately: true },
              );
              const snapshot = yield* lifecycleEvents.snapshot;
              const snapshotEvents = Array.from(snapshot.events).toSorted(
                (left, right) => left.sequence - right.sequence,
              );
              const liveEvents = Stream.fromQueue(liveBuffer).pipe(
                Stream.filter((event) => event.sequence > snapshot.sequence),
              );
              return Stream.concat(rpcInitialItems(snapshotEvents), liveEvents);
            }),
          ),
        [WS_METHODS.subscribeAuthAccess]: (_input) =>
          Stream.unwrap(
            Effect.gen(function* () {
              const liveBuffer = yield* Queue.unbounded<
                PairingGrantStore.BootstrapCredentialChange | SessionStore.SessionCredentialChange
              >();
              // Each store subscribes only when consumed, so start both before the snapshot read.
              yield* Effect.forkScoped(
                Stream.runForEach(bootstrapCredentials.streamChanges, (change) =>
                  Queue.offer(liveBuffer, change),
                ),
                { startImmediately: true },
              );
              yield* Effect.forkScoped(
                Stream.runForEach(sessions.streamChanges, (change) =>
                  Queue.offer(liveBuffer, change),
                ),
                { startImmediately: true },
              );
              const initialSnapshot = yield* loadAuthAccessSnapshot();
              const revisionRef = yield* Ref.make(1);

              const liveEvents: Stream.Stream<AuthAccessStreamEvent, AuthAccessStreamError> =
                Stream.fromQueue(liveBuffer).pipe(
                  Stream.mapEffect((change) =>
                    Ref.updateAndGet(revisionRef, (revision) => revision + 1).pipe(
                      Effect.flatMap((revision) =>
                        // Device trust has no incremental event older clients could decode.
                        change.type === "connectDevicesChanged"
                          ? loadAuthAccessSnapshot().pipe(
                              Effect.map((payload): AuthAccessStreamEvent => ({
                                version: 1,
                                revision,
                                type: "snapshot",
                                payload,
                              })),
                            )
                          : Effect.succeed(
                              toAuthAccessStreamEvent(change, revision, currentSessionId),
                            ),
                      ),
                    ),
                  ),
                );

              return Stream.concat(
                rpcInitialItems([
                  {
                    version: 1 as const,
                    revision: 1,
                    type: "snapshot" as const,
                    payload: initialSnapshot,
                  },
                ]),
                liveEvents,
              );
            }),
          ),
        [WS_METHODS.subscribeResourceTelemetry]: (_input) =>
          Stream.unwrap(
            Effect.map(resourceTelemetry.subscribe, ({ latest, changes }) =>
              Stream.concat(Stream.make(latest), changes),
            ),
          ),
      });
      // T3-CUSTOM(expbkt3): BEGIN — the server and web-UI bridge receive the native groups,
      // split as upstream splits them, and the fork group. The actor reaches every handler
      // through the context the group layers capture.
      const checkedHandlers = withSessionScopeCheck(handlers);
      const splitHandlers: Pick<typeof handlers, SplitWsRpc["_tag"]> = checkedHandlers;
      const otherHandlers: Pick<typeof handlers, Exclude<ServerWsRpc, SplitWsRpc>["_tag"]> =
        checkedHandlers;
      return Layer.mergeAll(
        SplitWsRpcGroup.toLayer(splitHandlers),
        OtherWsRpcGroup.toLayer(otherHandlers),
        ForkWsRpcGroup.toLayer(forkHandlers),
      ).pipe(Layer.provide(Layer.succeed(CurrentOrchestrationActorUserId, actorUserId)));
      // T3-CUSTOM(expbkt3): END
    }),
  );

// T3-CUSTOM(expbkt3): BEGIN — reuse the authenticated web RPC implementation
// from the compact MCP web-UI bridge instead of maintaining a second set of
// handlers that can drift from the browser.
export const makeAuthenticatedWsRpcHandlerLayer = (
  session: EnvironmentAuth.AuthenticatedSession,
  // Upstream's layerWsRpc no longer takes these; kept so the bridge's call is unchanged.
  _clientOrigin: OrchestrationClientOrigin,
  _previewAutomationBroker: PreviewAutomationBroker.PreviewAutomationBroker["Service"],
  serverSelfUpdate: ServerSelfUpdate.ServerSelfUpdate["Service"],
  clientAnalyticsProps: Readonly<Record<string, unknown>> = {},
) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const serverBrowser = yield* ServerBrowser.ServerBrowser;
      const reportProfiles = yield* serverBrowser.profileReporter;
      // Settings secret references are a client capability the bridge does not advertise.
      return layerWsRpc(session, clientAnalyticsProps, serverBrowser, reportProfiles, {
        secretReferences: false,
      });
    }),
  ).pipe(
    Layer.provide(DefectReporter.layer),
    // The scanner and the maintenance runner are server-wide upstream; ACP sessions are per connection.
    Layer.provide(AcpRegistrySessions.layer),
    Layer.provide(OrchestrationAccessControlLive),
    Layer.provide(ClerkDirectoryLive),
    Layer.provide(Layer.succeed(ServerSelfUpdate.ServerSelfUpdate, serverSelfUpdate)),
    // The /ws route builds its own NpmRelease below; the bridge needs one too.
    Layer.provide(NpmRelease.layer),
    Layer.provide(OtlpEndpointCheck.layer),
    // Same source-control composition as the /ws route below (upstream builtInDrivers).
    Layer.provide(
      SourceControlDiscovery.layer.pipe(
        Layer.provide(
          SourceControlProviderRegistry.layer.pipe(
            Layer.provide(SourceControlBuiltInDrivers.layer),
            Layer.provideMerge(GitVcsDriver.layer),
            Layer.provide(VcsDriverRegistry.layer.pipe(Layer.provide(VcsProjectConfig.layer))),
          ),
        ),
        Layer.provide(VcsProcess.layer),
      ),
    ),
  );
// T3-CUSTOM(expbkt3): END
// RpcServer's default sends a socket-level Defect frame instead, and the client
// ends every pending request on the socket with it.
export const WS_RPC_SERVER_OPTIONS = {
  disableTracing: true,
  disableFatalDefects: true,
} as const;

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const serverBrowser = yield* ServerBrowser.ServerBrowser;
    const serverSelfUpdate = yield* ServerSelfUpdate.ServerSelfUpdate;
    const providerMaintenanceRunner = yield* ProviderMaintenanceRunner.ProviderMaintenanceRunner;
    const npmRelease = yield* NpmRelease.NpmRelease;
    const pullRequests = yield* PullRequestService.PullRequestService;
    const issues = yield* IssueService.IssueService;
    const threadIssues = yield* ThreadIssueService.ThreadIssueService;
    const issueTrackers = yield* IssueTrackerConnections.IssueTrackerConnections;
    const reviewGuides = yield* PullRequestReviewGuideService.PullRequestReviewGuideService;
    const peerLinks = yield* PeerLinks.PeerLinks;
    const peerLinkRequests = yield* PeerLinkRequests.PeerLinkRequests;
    const peerThreadRelay = yield* PeerThreadRelay.PeerThreadRelay;
    const peerClientPairing = yield* PeerClientPairing.PeerClientPairing;
    const sql = yield* SqlClient.SqlClient;
    // T3-CUSTOM(expbkt3): one server-wide Clerk directory, so every connection shares its member cache.
    const clerkDirectory = yield* ClerkDirectory;
    return HttpRouter.add(
      "GET",
      "/ws",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const url = requestUrl(request);
        if (Option.isNone(url) || !hasCompatibleOrchestrationProtocol(url.value)) {
          return HttpServerResponse.jsonUnsafe(
            {
              code: "orchestration_protocol_incompatible",
              message: `Update this client to one that supports orchestration protocol ${ORCHESTRATION_PROTOCOL_VERSION}.`,
              orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
            },
            { status: 426 },
          );
        }
        const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
        const sessions = yield* SessionStore.SessionStore;
        const analytics = yield* AnalyticsService.AnalyticsService;
        const session = yield* serverAuth.authenticateWebSocketUpgrade(request, "rpc").pipe(
          Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
            failEnvironmentAuthInvalid(
              EnvironmentAuth.serverAuthCredentialReason(error),
              EnvironmentAuth.serverAuthDpopFailureReason(error),
            ),
          ),
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
            failEnvironmentInternal("internal_error", error),
          ),
        );
        // Desktop bootstrap sessions connect to their own backend, including same-machine WSL.
        if (session.subject === "desktop-bootstrap") {
          delete NodeHttpServerRequest.toIncomingMessage(request).headers[
            "sec-websocket-extensions"
          ];
        }
        const clientAnalyticsProps = readClientAnalyticsProps(request);
        // T3-CUSTOM(expbkt3): BEGIN — keep the client app version Settings shows, and the
        // connect event upstream dropped, with the signed-in user (TEC-1631).
        yield* sessions.recordClientConnection(
          session.sessionId,
          readClientConnectionOrigin(request),
        );
        yield* analytics.record(
          "client.connected",
          {
            ...clientAnalyticsProps,
            connectionMode: clientConnectionMode({
              ...clientAnalyticsProps,
              host: request.headers.host,
            }),
          },
          session.userId === null ? undefined : { userId: session.userId },
        );
        // T3-CUSTOM(expbkt3): END
        yield* analytics.recordOwners(readClientOwners(request), "client");
        const reportProfiles = yield* serverBrowser.profileReporter;
        const rpcWebSocketHttpEffect = yield* Effect.gen(function* () {
          const { protocol, httpEffect } = yield* RpcServer.makeProtocolWithHttpEffectWebsocket;
          yield* RpcServer.make(ServerWsRpcGroup, WS_RPC_SERVER_OPTIONS).pipe(
            Effect.provideService(RpcServer.Protocol, withOutputWindow(protocol)),
            Effect.provide(
              Layer.merge(
                RpcAuthorization.layer(session.scopes, (method, payload) => {
                  // Anonymous product signal: the feature and its enum variant,
                  // credited to the connecting client's surface only.
                  const usage = featureUsage(method, payload);
                  return usage === undefined
                    ? Effect.void
                    : analytics
                        .record("feature.used", {
                          ...usage,
                          ...(clientAnalyticsProps.surface === undefined
                            ? {}
                            : { surface: clientAnalyticsProps.surface }),
                        })
                        .pipe(Effect.ignore);
                }),
                rpcInstrumentationLayer,
              ),
            ),
            Effect.forkScoped,
          );
          return httpEffect;
        }).pipe(
          Effect.provide(
            layerWsRpc(
              session,
              clientAnalyticsProps,
              serverBrowser,
              reportProfiles,
              readSettingsClient(url.value),
            ).pipe(
              Layer.provideMerge(RpcSerialization.layerJson),
              // Handler-context reporters see only request defects, not server-wide defects.
              Layer.provide(DefectReporter.layer),
              Layer.provide(AcpRegistrySessions.layer),
              Layer.provide(Layer.succeed(SqlClient.SqlClient, sql)),
              // T3-CUSTOM(expbkt3): websocket team access shares the same services as MCP.
              Layer.provide(OrchestrationAccessControlLive),
              // T3-CUSTOM(expbkt3): reuse the server's directory; a per-connection build would start an empty Clerk cache.
              Layer.provide(Layer.succeed(ClerkDirectory, clerkDirectory)),
              // Installs outlive the connection that started them and lock across clients.
              Layer.provide(
                Layer.succeed(
                  ProviderMaintenanceRunner.ProviderMaintenanceRunner,
                  providerMaintenanceRunner,
                ),
              ),
              Layer.provide(Layer.succeed(NpmRelease.NpmRelease, npmRelease)),
              Layer.provide(Layer.succeed(ServerSelfUpdate.ServerSelfUpdate, serverSelfUpdate)),
              // Share server-lifetime PR caches so WS mutations invalidate every client's HTTP diffs.
              Layer.provide(Layer.succeed(PullRequestService.PullRequestService, pullRequests)),
              Layer.provide(Layer.succeed(IssueService.IssueService, issues)),
              Layer.provide(Layer.succeed(ThreadIssueService.ThreadIssueService, threadIssues)),
              Layer.provide(
                Layer.succeed(IssueTrackerConnections.IssueTrackerConnections, issueTrackers),
              ),
              Layer.provide(OtlpEndpointCheck.layer),
              Layer.provide(
                Layer.succeed(
                  PullRequestReviewGuideService.PullRequestReviewGuideService,
                  reviewGuides,
                ),
              ),
              Layer.provide(Layer.succeed(PeerLinks.PeerLinks, peerLinks)),
              Layer.provide(Layer.succeed(PeerLinkRequests.PeerLinkRequests, peerLinkRequests)),
              Layer.provide(Layer.succeed(PeerThreadRelay.PeerThreadRelay, peerThreadRelay)),
              Layer.provide(Layer.succeed(PeerClientPairing.PeerClientPairing, peerClientPairing)),
              Layer.provide(
                SourceControlDiscovery.layer.pipe(
                  Layer.provide(
                    SourceControlProviderRegistry.layer.pipe(
                      Layer.provide(SourceControlBuiltInDrivers.layer),
                      Layer.provideMerge(GitVcsDriver.layer),
                      Layer.provide(
                        VcsDriverRegistry.layer.pipe(Layer.provide(VcsProjectConfig.layer)),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ),
        );
        const splitFrames = url.value.searchParams.has(SOCKET_FRAME_PARTS_QUERY_PARAM);
        const framedRpcWebSocketHttpEffect = rpcWebSocketHttpEffect.pipe(
          Effect.provideService(
            HttpServerRequest.HttpServerRequest,
            // The RPC server upgrades the request itself, so its socket is
            // wrapped through the request it reads.
            Object.create(request, {
              upgrade: {
                value: Effect.map(request.upgrade, (socket) =>
                  withSocketHeartbeat(splitFrames ? splitLargeSocketFrames(socket) : socket),
                ),
              },
            }),
          ),
        );
        return yield* Effect.acquireUseRelease(
          sessions.markConnected(session.sessionId),
          () =>
            Effect.raceFirst(
              framedRpcWebSocketHttpEffect,
              sessions.awaitInvalidation(session.sessionId, session.proofKeyThumbprint).pipe(
                Effect.as(HttpServerResponse.empty()),
                Effect.catchTags({
                  SessionCredentialVerificationError: (error) =>
                    failEnvironmentInternal("internal_error", error),
                }),
              ),
            ),
          () => sessions.markDisconnected(session.sessionId),
        );
      }).pipe(
        Effect.catchTags({
          EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
          EnvironmentInternalError: HttpServerRespondable.toResponse,
        }),
      ),
    );
  }),
).pipe(Layer.provide(NpmRelease.layer));
