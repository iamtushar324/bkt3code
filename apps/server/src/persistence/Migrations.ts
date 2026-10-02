/**
 * Migration runner with an inline loader.
 *
 * Uses Migrator.make with fromRecord to define migrations inline.
 * All migrations are statically imported - no dynamic file system loading.
 *
 * `runMigrations` is called by the SQLite persistence layer at startup, so the
 * schema is always up to date before the application starts.
 */

import * as Migrator from "effect/unstable/sql/Migrator";
import * as Effect from "effect/Effect";
// T3-CUSTOM(expbkt3): compatibility for fork service test layers.
import * as Layer from "effect/Layer";

// Import all migrations statically
import Migration0001 from "./Migrations/001_OrchestrationEvents.ts";
import Migration0002 from "./Migrations/002_OrchestrationCommandReceipts.ts";
import Migration0003 from "./Migrations/003_CheckpointDiffBlobs.ts";
import Migration0004 from "./Migrations/004_ProviderSessionRuntime.ts";
import Migration0005 from "./Migrations/005_Projections.ts";
import Migration0006 from "./Migrations/006_ProjectionThreadSessionRuntimeModeColumns.ts";
import Migration0007 from "./Migrations/007_ProjectionThreadMessageAttachments.ts";
import Migration0008 from "./Migrations/008_ProjectionThreadActivitySequence.ts";
import Migration0009 from "./Migrations/009_ProviderSessionRuntimeMode.ts";
import Migration0010 from "./Migrations/010_ProjectionThreadsRuntimeMode.ts";
import Migration0011 from "./Migrations/011_OrchestrationThreadCreatedRuntimeMode.ts";
import Migration0012 from "./Migrations/012_ProjectionThreadsInteractionMode.ts";
import Migration0013 from "./Migrations/013_ProjectionThreadProposedPlans.ts";
import Migration0014 from "./Migrations/014_ProjectionThreadProposedPlanImplementation.ts";
import Migration0015 from "./Migrations/015_ProjectionTurnsSourceProposedPlan.ts";
import Migration0016 from "./Migrations/016_CanonicalizeModelSelections.ts";
import Migration0017 from "./Migrations/017_ProjectionThreadsArchivedAt.ts";
import Migration0018 from "./Migrations/018_ProjectionThreadsArchivedAtIndex.ts";
import Migration0019 from "./Migrations/019_ProjectionSnapshotLookupIndexes.ts";
import Migration0020 from "./Migrations/020_AuthAccessManagement.ts";
import Migration0021 from "./Migrations/021_AuthSessionClientMetadata.ts";
import Migration0022 from "./Migrations/022_AuthSessionLastConnectedAt.ts";
import Migration0023 from "./Migrations/023_ProjectionThreadShellSummary.ts";
import Migration0024 from "./Migrations/024_BackfillProjectionThreadShellSummary.ts";
import Migration0025 from "./Migrations/025_CleanupInvalidProjectionPendingApprovals.ts";
import Migration0026 from "./Migrations/026_CanonicalizeModelSelectionOptions.ts";
import Migration0027 from "./Migrations/027_ProviderSessionRuntimeInstanceId.ts";
import Migration0028 from "./Migrations/028_ProjectionThreadSessionInstanceId.ts";
import Migration0029 from "./Migrations/029_ProjectionThreadDetailOrderingIndexes.ts";
import Migration0030 from "./Migrations/030_ProjectionThreadShellArchiveIndexes.ts";
import Migration0031 from "./Migrations/031_AuthAuthorizationScopes.ts";
import Migration0032 from "./Migrations/032_AuthPairingProofKeyThumbprint.ts";
// T3-CUSTOM(expbkt3): BEGIN — legacy fork block (frozen indices 33-42, already
// applied in production); these fork-owned migration files replaced what
// upstream originally shipped at 33-41 before the 1000+ lane existed.
import Migration0033 from "./Migrations/033_ProjectionOwnershipMembership.ts";
import Migration0034 from "./Migrations/034_ProjectionThreadMessageSender.ts";
import Migration0035 from "./Migrations/035_BackfillProjectionThreadLatestTurn.ts";
import Migration0036 from "./Migrations/036_BackfillLatestTurnSkipPendingRows.ts";
import Migration0037 from "./Migrations/037_ThreadExecutions.ts";
import Migration0038 from "./Migrations/038_CatchupSummaries.ts";
import Migration0039 from "./Migrations/039_CatchupSummaryStatus.ts";
import Migration0040 from "./Migrations/033_ProjectionThreadsSettled.ts";
import Migration0041 from "./Migrations/034_ProjectionThreadsSnoozed.ts";
// T3-CUSTOM(expbkt3): END
// T3-CUSTOM(expbkt3): Per-user MCP profiles and personal access tokens.
import Migration0042 from "./Migrations/042_UserMcpProfiles.ts";
// T3-CUSTOM(expbkt3): upstream ships this as migration 35. See the allocation
// rule above the registry — legacy fork indices 33-42 make 35 unavailable.
import Migration0043 from "./Migrations/035_ProjectionThreadTitleRegeneration.ts";
import Migration0044 from "./Migrations/044_ProjectionThreadSourceControlProfile.ts";
import Migration0045 from "./Migrations/045_EnvironmentUsers.ts";
// T3-CUSTOM(expbkt3): upstream migration 36 arrived after fork migration 1004
// had shipped, so the monotonic migrator requires the next free applied ID.
import Migration1005 from "./Migrations/036_ProjectionThreadsPinned.ts";
// T3-CUSTOM(expbkt3): fork migrations, numbered 1000+.
import Migration1000 from "./Migrations/1000_ProjectionThreadsPriority.ts";
import Migration1022 from "./Migrations/1022_AgentUiRenders.ts";
import Migration1023 from "./Migrations/1023_ProjectionThreadsMattermostLink.ts";
// T3-CUSTOM(expbkt3): a parent session may live on another environment.
import Migration1024 from "./Migrations/1024_ProjectionThreadsParentEnvironment.ts";
// T3-CUSTOM(expbkt3): one worktree per (parent session, repository).
import Migration1035 from "./Migrations/1035_ThreadWorkspaceGroups.ts";
import Migration1001 from "./Migrations/1001_SessionRecoveryState.ts";
import Migration1002 from "./Migrations/1002_ThreadBootstrapAndCreationDefaults.ts";
// T3-CUSTOM(expbkt3): exact durable work items and guarded recovery audit.
import Migration1003 from "./Migrations/1003_DurableExecutionIntents.ts";
// T3-CUSTOM(expbkt3): durable manual Linear issue tags.
import Migration1004 from "./Migrations/1004_ProjectionThreadsLinearIssue.ts";
// T3-CUSTOM(expbkt3): connected-client build identity for stale-bundle diagnosis.
import Migration1006 from "./Migrations/1006_AuthSessionClientVersion.ts";
// T3-CUSTOM(expbkt3): event-type index plus one-time maintenance markers so the
// ownership backfill stops re-scanning the event log on every boot.
import Migration1007 from "./Migrations/1007_OwnershipBackfillFastPath.ts";
// T3-CUSTOM(expbkt3): upstream ships this as migration 37, which the legacy fork
// block already occupies (ThreadExecutions). It registers at the next free ID in
// the 1000+ lane instead; the file keeps its upstream name.
import Migration1008 from "./Migrations/037_ProjectionTurnsKeysetIndex.ts";
// T3-CUSTOM(expbkt3): native plan review documents, versions and discussions.
import Migration1009 from "./Migrations/1009_PlanReviewDocuments.ts";

// T3-CUSTOM(expbkt3): session lineage column for the experimental sidebar tree.
import Migration1010 from "./Migrations/1010_ProjectionThreadsParentThread.ts";
// T3-CUSTOM(expbkt3): plan documents record their renderer (markdown or HTML).
import Migration1011 from "./Migrations/1011_PlanDocumentFormat.ts";
// T3-CUSTOM(expbkt3): BEGIN — durable bulk-session-manager work summaries.
// Allocated at 1012, above the highest applied id: Effect only runs migrations
// newer than the newest row in effect_sql_migrations, so a lower id would never
// execute on a database that already applied 1011.
import Migration1012 from "./Migrations/1012_ProjectionThreadsWorkSummary.ts";
// T3-CUSTOM(expbkt3): END
// T3-CUSTOM(expbkt3): manual-title ownership, so a generated rename never
// replaces a name the user typed.
import Migration1013 from "./Migrations/1013_ProjectionThreadsTitleManual.ts";
// T3-CUSTOM(expbkt3): pairing links that must be redeemed with a DPoP proof.
import Migration1014 from "./Migrations/1014_AuthPairingRequiresProofOfPossession.ts";
// T3-CUSTOM(expbkt3): member self-service pairing links.
import Migration1015 from "./Migrations/1015_AuthPairingSelfIssued.ts";
// T3-CUSTOM(expbkt3): upstream ships these as migrations 38-40, which the
// legacy fork block (33-42) already occupies. They register at the next free
// IDs in the 1000+ lane instead; the files keep their upstream names.
import Migration1016 from "./Migrations/038_ProjectionThreadsPinOrderKey.ts";
import Migration1017 from "./Migrations/039_ProjectionProjectsDefaultThreadEnvMode.ts";
import Migration1018 from "./Migrations/040_ProjectionProjectFaviconPath.ts";
// T3-CUSTOM(expbkt3): upstream ships these as migrations 41-43, which the
// legacy fork block (33-42) and remap 43 already occupy. They register at the
// next free IDs in the 1000+ lane instead; the files keep their upstream names.
import Migration1019 from "./Migrations/041_AuthSessionClientConnection.ts";
import Migration1020 from "./Migrations/042_ProjectionThreadLinkedPullRequest.ts";
import Migration1021 from "./Migrations/043_ProjectionThreadsUnsettledAt.ts";
// T3-CUSTOM(expbkt3): new upstream migrations must follow the highest applied fork ID.
import Migration1025 from "./Migrations/044_ClearAutomaticProjectModelDefaults.ts";
import Migration1026 from "./Migrations/045_ProjectionProjectsAutoPull.ts";
import Migration1027 from "./Migrations/046_RepairAutomaticSettlementTimestamps.ts";
import Migration1028 from "./Migrations/047_ProjectionProjectIcon.ts";
// T3-CUSTOM(expbkt3): non-blocking async question indicator for shell rows.
import Migration1029 from "./Migrations/1029_ProjectionThreadsAsyncQuestions.ts";
// T3-CUSTOM(expbkt3): keep execution-status sync reads bounded to lifecycle activities.
import Migration1030 from "./Migrations/1030_ActivityThreadKindIndex.ts";
// T3-CUSTOM(expbkt3): upstream ships these as migrations 48-51. The legacy fork
// block (33-42) and the shipped 1000+ lane already occupy those slots, so they
// register at the next free IDs in the 1000+ lane; the files keep upstream names.
import Migration1031 from "./Migrations/048_ProjectionThreadBranchPullRequest.ts";
import Migration1032 from "./Migrations/049_ProjectionThreadsActiveOrderKey.ts";
import Migration1033 from "./Migrations/050_ProjectionThreadPullRequests.ts";
import Migration1034 from "./Migrations/051_ProjectionThreadMessageContext.ts";
// T3-CUSTOM(expbkt3): upstream ships these as migrations 52-54. The legacy fork
// block (33-42) and the shipped 1000+ lane already occupy those slots, so they
// register at the next free IDs in the 1000+ lane; the files keep upstream names.
import Migration1036 from "./Migrations/052_ProjectionThreadTitleState.ts";
import Migration1037 from "./Migrations/053_PullRequestFilesViewed.ts";
import Migration1038 from "./Migrations/054_ProjectionThreadsAutoSettleDisabledAt.ts";
// T3-CUSTOM(expbkt3): per-thread custom sidebar group.
import Migration1039 from "./Migrations/1039_ProjectionThreadsCustomGroup.ts";
// T3-CUSTOM(expbkt3): review comments on assistant messages in chat.
import Migration1040 from "./Migrations/1040_ThreadComments.ts";
// T3-CUSTOM(expbkt3): Claude account profiles per thread.
import Migration1041 from "./Migrations/1041_ThreadClaudeAccount.ts";
// T3-CUSTOM(expbkt3): Claude account access per user.
import Migration1042 from "./Migrations/1042_ClaudeAccountProfileAccess.ts";

/**
 * Migration loader with all migrations defined inline.
 *
 * Key format: "{id}_{name}" where:
 * - id: numeric migration ID (determines execution order)
 * - name: descriptive name for the migration
 *
 * Uses Migrator.fromRecord which parses the key format and
 * returns migrations sorted by ID.
 */
// T3-CUSTOM(expbkt3): migration index allocation rule. Do not re-decide this
// on every upstream merge — apply it mechanically.
//
//   * 1-32      shared history, identical to upstream.
//   * 33-42     LEGACY fork block. Frozen. These indices are already applied in
//               production databases (effect_sql_migrations keys on
//               `${id}_${name}`), so renumbering one makes it run a second time
//               on live data. Never touch them.
//   * 43-45     LEGACY upstream remaps applied before the first 1000+ migration.
//               Frozen for the same durable-identity reason as 33-42.
//   * 46-999    reserved. Do not append migrations here: Effect only executes
//               IDs greater than the highest applied ID, and live databases
//               have already applied 1000+ migrations.
//   * 1000+     monotonic shared allocation lane for every new migration. Fork
//               files use the allocated ID; upstream files keep their upstream
//               filename but register at the next free ID in this lane.
//
// Always allocate an ID greater than the current maximum registry ID. This is
// required by Migrator.make, which only runs migrations newer than the highest
// row already present in effect_sql_migrations.
const migrationEntries = [
  [1, "OrchestrationEvents", Migration0001],
  [2, "OrchestrationCommandReceipts", Migration0002],
  [3, "CheckpointDiffBlobs", Migration0003],
  [4, "ProviderSessionRuntime", Migration0004],
  [5, "Projections", Migration0005],
  [6, "ProjectionThreadSessionRuntimeModeColumns", Migration0006],
  [7, "ProjectionThreadMessageAttachments", Migration0007],
  [8, "ProjectionThreadActivitySequence", Migration0008],
  [9, "ProviderSessionRuntimeMode", Migration0009],
  [10, "ProjectionThreadsRuntimeMode", Migration0010],
  [11, "OrchestrationThreadCreatedRuntimeMode", Migration0011],
  [12, "ProjectionThreadsInteractionMode", Migration0012],
  [13, "ProjectionThreadProposedPlans", Migration0013],
  [14, "ProjectionThreadProposedPlanImplementation", Migration0014],
  [15, "ProjectionTurnsSourceProposedPlan", Migration0015],
  [16, "CanonicalizeModelSelections", Migration0016],
  [17, "ProjectionThreadsArchivedAt", Migration0017],
  [18, "ProjectionThreadsArchivedAtIndex", Migration0018],
  [19, "ProjectionSnapshotLookupIndexes", Migration0019],
  [20, "AuthAccessManagement", Migration0020],
  [21, "AuthSessionClientMetadata", Migration0021],
  [22, "AuthSessionLastConnectedAt", Migration0022],
  [23, "ProjectionThreadShellSummary", Migration0023],
  [24, "BackfillProjectionThreadShellSummary", Migration0024],
  [25, "CleanupInvalidProjectionPendingApprovals", Migration0025],
  [26, "CanonicalizeModelSelectionOptions", Migration0026],
  [27, "ProviderSessionRuntimeInstanceId", Migration0027],
  [28, "ProjectionThreadSessionInstanceId", Migration0028],
  [29, "ProjectionThreadDetailOrderingIndexes", Migration0029],
  [30, "ProjectionThreadShellArchiveIndexes", Migration0030],
  [31, "AuthAuthorizationScopes", Migration0031],
  [32, "AuthPairingProofKeyThumbprint", Migration0032],
  [33, "ProjectionOwnershipMembership", Migration0033],
  [34, "ProjectionThreadMessageSender", Migration0034],
  [35, "BackfillProjectionThreadLatestTurn", Migration0035],
  [36, "BackfillLatestTurnSkipPendingRows", Migration0036],
  [37, "ThreadExecutions", Migration0037],
  [38, "CatchupSummaries", Migration0038],
  [39, "CatchupSummaryStatus", Migration0039],
  [40, "ProjectionThreadsSettled", Migration0040],
  [41, "ProjectionThreadsSnoozed", Migration0041],
  [42, "UserMcpProfiles", Migration0042],
  [43, "ProjectionThreadTitleRegeneration", Migration0043],
  [44, "ProjectionThreadSourceControlProfile", Migration0044],
  [45, "EnvironmentUsers", Migration0045],
  // T3-CUSTOM(expbkt3): 46-999 stay empty once the 1000+ lane has started.
  [1000, "ProjectionThreadsPriority", Migration1000],
  [1001, "SessionRecoveryState", Migration1001],
  [1002, "ThreadBootstrapAndCreationDefaults", Migration1002],
  [1003, "DurableExecutionIntents", Migration1003],
  [1004, "ProjectionThreadsLinearIssue", Migration1004],
  [1005, "ProjectionThreadsPinned", Migration1005],
  [1006, "AuthSessionClientVersion", Migration1006],
  [1007, "OwnershipBackfillFastPath", Migration1007],
  [1008, "ProjectionTurnsKeysetIndex", Migration1008],
  [1009, "PlanReviewDocuments", Migration1009],
  // T3-CUSTOM(expbkt3): session lineage.
  [1010, "ProjectionThreadsParentThread", Migration1010],
  [1011, "PlanDocumentFormat", Migration1011],
  // T3-CUSTOM(expbkt3): BEGIN — bulk session manager work summaries.
  [1012, "ProjectionThreadsWorkSummary", Migration1012],
  // T3-CUSTOM(expbkt3): END
  // T3-CUSTOM(expbkt3): manual-title ownership.
  [1013, "ProjectionThreadsTitleManual", Migration1013],
  // T3-CUSTOM(expbkt3): proof-of-possession requirement on pairing links.
  [1014, "AuthPairingRequiresProofOfPossession", Migration1014],
  // T3-CUSTOM(expbkt3): member self-service pairing links.
  [1015, "AuthPairingSelfIssued", Migration1015],
  // T3-CUSTOM(expbkt3): upstream migrations 38-40, remapped into the 1000+ lane
  // because the legacy fork block occupies 33-42.
  [1016, "ProjectionThreadsPinOrderKey", Migration1016],
  [1017, "ProjectionProjectsDefaultThreadEnvMode", Migration1017],
  [1018, "ProjectionProjectFaviconPath", Migration1018],
  // T3-CUSTOM(expbkt3): upstream migrations 41-43, remapped into the 1000+ lane
  // because the legacy fork block occupies 33-42 (and 43 is a legacy remap).
  [1019, "AuthSessionClientConnection", Migration1019],
  [1020, "ProjectionThreadLinkedPullRequest", Migration1020],
  [1021, "ProjectionThreadsUnsettledAt", Migration1021],
  // T3-CUSTOM(expbkt3): agent-rendered UI surfaces in chat.
  [1022, "AgentUiRenders", Migration1022],
  // T3-CUSTOM(expbkt3): durable Mattermost conversation link on a thread.
  [1023, "ProjectionThreadsMattermostLink", Migration1023],
  // T3-CUSTOM(expbkt3): cross-environment session lineage.
  [1024, "ProjectionThreadsParentEnvironment", Migration1024],
  // T3-CUSTOM(expbkt3): upstream 44–47 remapped above the shipped 1024 migration.
  [1025, "ClearAutomaticProjectModelDefaults", Migration1025],
  [1026, "ProjectionProjectsAutoPull", Migration1026],
  [1027, "RepairAutomaticSettlementTimestamps", Migration1027],
  [1028, "ProjectionProjectIcon", Migration1028],
  [1029, "ProjectionThreadsAsyncQuestions", Migration1029],
  // T3-CUSTOM(expbkt3): activity-kind lookup index for execution snapshots.
  [1030, "ActivityThreadKindIndex", Migration1030],
  // T3-CUSTOM(expbkt3): upstream 48-51 remapped above the shipped 1030 migration.
  [1031, "ProjectionThreadBranchPullRequest", Migration1031],
  [1032, "ProjectionThreadsActiveOrderKey", Migration1032],
  [1033, "ProjectionThreadPullRequests", Migration1033],
  [1034, "ProjectionThreadMessageContext", Migration1034],
  // T3-CUSTOM(expbkt3): shared child worktrees, one per (parent, repository).
  [1035, "ThreadWorkspaceGroups", Migration1035],
  // T3-CUSTOM(expbkt3): upstream 52-54 remapped above the shipped 1035 migration.
  [1036, "ProjectionThreadTitleState", Migration1036],
  [1037, "PullRequestFilesViewed", Migration1037],
  [1038, "ProjectionThreadsAutoSettleDisabledAt", Migration1038],
  // T3-CUSTOM(expbkt3): per-thread custom sidebar group.
  [1039, "ProjectionThreadsCustomGroup", Migration1039],
  // T3-CUSTOM(expbkt3): review comments on assistant messages in chat.
  [1040, "ThreadComments", Migration1040],
  // T3-CUSTOM(expbkt3): Claude account profiles per thread.
  [1041, "ThreadClaudeAccount", Migration1041],
  // T3-CUSTOM(expbkt3): Claude account access per user.
  [1042, "ClaudeAccountProfileAccess", Migration1042],
] as const;

export const migrationManifest = migrationEntries.map(([id, name]) => [id, name] as const);

const makeMigrationLoader = (throughId?: number) =>
  Migrator.fromRecord(
    Object.fromEntries(
      migrationEntries
        .filter(([id]) => throughId === undefined || id <= throughId)
        .map(([id, name, migration]) => [`${id}_${name}`, migration]),
    ),
  );

/**
 * Migrator run function - no schema dumping needed
 * Uses the base Migrator.make without platform dependencies
 */
const run = Migrator.make({});

export interface RunMigrationsOptions {
  readonly toMigrationInclusive?: number | undefined;
}

/**
 * Run all pending migrations.
 *
 * Creates the migrations tracking table (effect_sql_migrations) if it doesn't exist,
 * then runs any migrations with ID greater than the latest recorded migration.
 *
 * Returns array of [id, name] tuples for migrations that were run.
 *
 * @returns Effect containing array of executed migrations
 */
export const runMigrations = Effect.fn("runMigrations")(function* ({
  toMigrationInclusive,
}: RunMigrationsOptions = {}) {
  const executedMigrations = yield* run({ loader: makeMigrationLoader(toMigrationInclusive) });
  const migrations = executedMigrations.map(([id, name]) => `${id}_${name}`);
  yield* migrations.length === 0
    ? Effect.logDebug("Database schema is current")
    : Effect.log("Migrations ran successfully").pipe(Effect.annotateLogs({ migrations }));
  return executedMigrations;
});

// T3-CUSTOM(expbkt3): fork layers still compose migration startup explicitly.
export const MigrationsLive = Layer.effectDiscard(runMigrations());
