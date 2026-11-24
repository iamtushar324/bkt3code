import * as Migrator from "effect/sql/Migrator";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
// T3-CUSTOM(expbkt3): compatibility for fork service test layers.
import * as Layer from "effect/Layer";
import {
  DATABASE_MIGRATION_PROGRESS_MESSAGE,
  DATABASE_MIGRATIONS_FINISHED_MESSAGE,
  DATABASE_MIGRATIONS_STARTED_MESSAGE,
} from "@t3tools/shared/databaseMigrationLog";

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
// T3-CUSTOM(expbkt3): upstream ships these as migrations 68-78. The legacy fork
// block (33-42) and the shipped 1000+ lane already occupy those slots, so they
// register at the next free IDs in the 1000+ lane; the files keep upstream names.
import Migration1060 from "./Migrations/068_ShellStopRequestIndex.ts";
import Migration1061 from "./Migrations/069_ThreadMessageSearch.ts";
import Migration1062 from "./Migrations/070_PeerLinks.ts";
import Migration1063 from "./Migrations/071_PeerLinkFence.ts";
import Migration1064 from "./Migrations/072_WaitingLinkRequestIndex.ts";
import Migration1065 from "./Migrations/073_ActiveTurnItemIndexes.ts";
import Migration1066 from "./Migrations/074_ExcludeAttachmentPlaceholdersFromSearch.ts";
import Migration1067 from "./Migrations/075_SubagentDeliveryState.ts";
import Migration1068 from "./Migrations/076_ProjectionProjectsPinArchive.ts";
import Migration1069 from "./Migrations/077_RepairBooleanSettledOverride.ts";
import Migration1070 from "./Migrations/078_DropOrchestrationEventCorrelationIndex.ts";
// T3-CUSTOM(expbkt3): upstream ships these as migrations 79-111. They register at the
// next free IDs in the 1000+ lane (1071-1103); the files keep upstream names.
import Migration1071 from "./Migrations/079_DelegatedRecoveryIndexes.ts";
import Migration1072 from "./Migrations/080_ScheduledTaskThreadMode.ts";
import Migration1073 from "./Migrations/081_ProjectionMessageSearchText.ts";
import Migration1074 from "./Migrations/082_TurnItemConversationIndex.ts";
import Migration1075 from "./Migrations/083_CommandReadIndexes.ts";
import Migration1076 from "./Migrations/084_LastExecutedRunIndex.ts";
import Migration1077 from "./Migrations/085_TurnItemCounts.ts";
import Migration1078 from "./Migrations/086_QueuedTurnInputIndex.ts";
import Migration1079 from "./Migrations/087_ProjectionProjectsCustomTitle.ts";
import Migration1080 from "./Migrations/088_TurnItemTypeStatusIndex.ts";
import Migration1081 from "./Migrations/089_ShellThreadReadIndexes.ts";
import Migration1082 from "./Migrations/090_AuthConnectDevices.ts";
import Migration1083 from "./Migrations/091_AuthConnectDeniedRequests.ts";
import Migration1084 from "./Migrations/092_QueuedTurnInputIndexJsonValid.ts";
import Migration1085 from "./Migrations/093_ProviderTurnAttemptIndex.ts";
import Migration1086 from "./Migrations/094_TurnItemMessageOrdinalIndex.ts";
import Migration1087 from "./Migrations/095_TurnItemInlineWorkOutput.ts";
import Migration1088 from "./Migrations/096_RepairStaleTitleRegeneration.ts";
import Migration1089 from "./Migrations/097_IssueTrackerBindings.ts";
import Migration1090 from "./Migrations/098_ActiveShellIndexIndexes.ts";
import Migration1091 from "./Migrations/099_BackgroundRecoveryIndexes.ts";
import Migration1092 from "./Migrations/100_TurnStartReadIndexes.ts";
import Migration1093 from "./Migrations/101_DelegatedTaskReadIndexes.ts";
import Migration1094 from "./Migrations/102_ThreadItemCounts.ts";
import Migration1095 from "./Migrations/103_IssueTrackerAdditionalScopes.ts";
import Migration1096 from "./Migrations/104_ProjectionProjectsTrackedFolders.ts";
import Migration1097 from "./Migrations/105_TaskFolders.ts";
import Migration1098 from "./Migrations/106_WorktreePathKeyIndex.ts";
import Migration1099 from "./Migrations/107_DeferredSlashCommandIndex.ts";
import Migration1100 from "./Migrations/108_AgentFeedback.ts";
import Migration1101 from "./Migrations/109_IssueTrackerAccounts.ts";
import Migration1102 from "./Migrations/110_Workflows.ts";
import Migration1103 from "./Migrations/111_SupersededRunAttemptIndex.ts";

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

// T3-CUSTOM(expbkt3): upstream V2 starts above the frozen fork migration ledger.
import Migration1043 from "./Migrations/055_OrchestrationV2.ts";
import Migration1044 from "./Migrations/056_RemoveRedundantProjectionIndexes.ts";
// T3-CUSTOM(expbkt3): upstream ships these as migrations 57-58. The legacy fork
// block (33-42) and the shipped 1000+ lane already occupy those slots, so they
// register at the next free IDs in the 1000+ lane; the files keep upstream names.
import Migration1046 from "./Migrations/057_ScheduledTaskWebhooks.ts";
import Migration1047 from "./Migrations/058_WebhookRelayDeliveries.ts";
// T3-CUSTOM(expbkt3): upstream ships these as migrations 59-60. The legacy fork
// block (33-42) and the shipped 1000+ lane already occupy those slots, so they
// register at the next free IDs in the 1000+ lane; the files keep upstream names.
import Migration1049 from "./Migrations/059_McpAppModelContext.ts";
import Migration1050 from "./Migrations/060_ThreadSnapshotWindowIndexes.ts";

// T3-CUSTOM(expbkt3): migration ids. 1-32 match upstream; 33-45 are frozen (applied in prod and
// keyed on `${id}_${name}`, so renumbering reruns them); 46-999 are reserved. Every new migration,
// fork or upstream, takes the next id above the current maximum (1000+): Migrator.make runs only
// ids above the highest applied one. Upstream files keep their filename.

// T3-CUSTOM(expbkt3): owner-bound session callback storage.
import Migration1045 from "./Migrations/1045_SessionWebhooks.ts";
// T3-CUSTOM(expbkt3): review comments are sent once; this records when.
import Migration1048 from "./Migrations/1048_ThreadCommentLastSent.ts";
// T3-CUSTOM(expbkt3): BK sidebar custom group for scheduled task threads.
import Migration1051 from "./Migrations/1051_ScheduledTaskCustomGroups.ts";
// T3-CUSTOM(expbkt3): owner, tags, loudness and run-once of scheduled tasks.
import Migration1052 from "./Migrations/1052_ScheduledTaskForkOptions.ts";
// T3-CUSTOM(expbkt3): durable revive queue for Claude account placement.
import Migration1053 from "./Migrations/1053_ThreadClaudeAccountWait.ts";
// T3-CUSTOM(expbkt3): upstream ships these as migrations 61, 62 and 64. The legacy
// fork block (33-42) and the shipped 1000+ lane already occupy those slots, so they
// register at the next free IDs in the 1000+ lane; the files keep upstream names.
import Migration1054 from "./Migrations/061_PullRequestReviewGuides.ts";
import Migration1055 from "./Migrations/062_ThreadFailureLookupIndex.ts";
import Migration1056 from "./Migrations/064_CanonicalizeThreadPullRequestLinks.ts";
// T3-CUSTOM(expbkt3): upstream ships these as migrations 65-66. They register at the
// next free IDs in the 1000+ lane; the files keep upstream names.
import Migration1057 from "./Migrations/065_CodexUsageNativeTurnIndex.ts";
import Migration1058 from "./Migrations/066_RepairClientSettlementTimestamps.ts";
// T3-CUSTOM(expbkt3): upstream ships this as migration 67; it registers at the next free 1000+ id.
import Migration1059 from "./Migrations/067_WebhookDedupe.ts";
// T3-CUSTOM(expbkt3): upstream migration 63 (`063_DropUnusedV1Projections.ts`) is NOT registered:
// it irreversibly drops V1 projections and checkpoint diff blobs that fork history still reads
// (ForkLegacyHistory.expbkt3.ts, legacyProjection.expbkt3.ts). Register it at the next free
// 1000+ id only once no fork code reads those tables.
export const migrationEntries = [
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
  // T3-CUSTOM(expbkt3): preserve every applied ID and allocate V2 monotonically.
  [1043, "OrchestrationV2", Migration1043],
  [1044, "RemoveRedundantProjectionIndexes", Migration1044],
  // T3-CUSTOM(expbkt3): durable session callback delivery.
  [1045, "SessionWebhooks", Migration1045],
  // T3-CUSTOM(expbkt3): upstream 57-58 remapped above the shipped 1045 migration.
  [1046, "ScheduledTaskWebhooks", Migration1046],
  [1047, "WebhookRelayDeliveries", Migration1047],
  // T3-CUSTOM(expbkt3): review comment send-once mark.
  [1048, "ThreadCommentLastSent", Migration1048],
  // T3-CUSTOM(expbkt3): upstream 59-60 remapped above the shipped 1048 migration.
  [1049, "McpAppModelContext", Migration1049],
  [1050, "ThreadSnapshotWindowIndexes", Migration1050],
  // T3-CUSTOM(expbkt3): BK sidebar custom group for scheduled task threads.
  [1051, "ScheduledTaskCustomGroups", Migration1051],
  // T3-CUSTOM(expbkt3): owner, tags, loudness and run-once of scheduled tasks.
  [1052, "ScheduledTaskForkOptions", Migration1052],
  // T3-CUSTOM(expbkt3): durable revive queue for Claude account placement.
  [1053, "ThreadClaudeAccountWait", Migration1053],
  // T3-CUSTOM(expbkt3): upstream 61, 62 and 64 remapped above the shipped 1053
  // migration. Upstream 63 (DropUnusedV1Projections) stays unregistered; see the
  // import block above.
  [1054, "PullRequestReviewGuides", Migration1054],
  [1055, "ThreadFailureLookupIndex", Migration1055],
  [1056, "CanonicalizeThreadPullRequestLinks", Migration1056],
  // T3-CUSTOM(expbkt3): upstream 65-66 remapped above the shipped 1056 migration.
  [1057, "CodexUsageNativeTurnIndex", Migration1057],
  [1058, "RepairClientSettlementTimestamps", Migration1058],
  // T3-CUSTOM(expbkt3): upstream 67 remapped above the shipped 1058 migration.
  [1059, "WebhookDedupe", Migration1059],
  // T3-CUSTOM(expbkt3): upstream 68-78 remapped above the shipped 1059 migration.
  [1060, "ShellStopRequestIndex", Migration1060],
  [1061, "ThreadMessageSearch", Migration1061],
  [1062, "PeerLinks", Migration1062],
  [1063, "PeerLinkFence", Migration1063],
  [1064, "WaitingLinkRequestIndex", Migration1064],
  [1065, "ActiveTurnItemIndexes", Migration1065],
  [1066, "ExcludeAttachmentPlaceholdersFromSearch", Migration1066],
  [1067, "SubagentDeliveryState", Migration1067],
  [1068, "ProjectionProjectsPinArchive", Migration1068],
  [1069, "RepairBooleanSettledOverride", Migration1069],
  [1070, "DropOrchestrationEventCorrelationIndex", Migration1070],
  // T3-CUSTOM(expbkt3): upstream 79-111 remapped above the shipped 1070 migration.
  [1071, "DelegatedRecoveryIndexes", Migration1071],
  [1072, "ScheduledTaskThreadMode", Migration1072],
  [1073, "ProjectionMessageSearchText", Migration1073],
  [1074, "TurnItemConversationIndex", Migration1074],
  [1075, "CommandReadIndexes", Migration1075],
  [1076, "LastExecutedRunIndex", Migration1076],
  [1077, "TurnItemCounts", Migration1077],
  [1078, "QueuedTurnInputIndex", Migration1078],
  [1079, "ProjectionProjectsCustomTitle", Migration1079],
  [1080, "TurnItemTypeStatusIndex", Migration1080],
  [1081, "ShellThreadReadIndexes", Migration1081],
  [1082, "AuthConnectDevices", Migration1082],
  [1083, "AuthConnectDeniedRequests", Migration1083],
  [1084, "QueuedTurnInputIndexJsonValid", Migration1084],
  [1085, "ProviderTurnAttemptIndex", Migration1085],
  [1086, "TurnItemMessageOrdinalIndex", Migration1086],
  [1087, "TurnItemInlineWorkOutput", Migration1087],
  [1088, "RepairStaleTitleRegeneration", Migration1088],
  [1089, "IssueTrackerBindings", Migration1089],
  [1090, "ActiveShellIndexIndexes", Migration1090],
  [1091, "BackgroundRecoveryIndexes", Migration1091],
  [1092, "TurnStartReadIndexes", Migration1092],
  [1093, "DelegatedTaskReadIndexes", Migration1093],
  [1094, "ThreadItemCounts", Migration1094],
  [1095, "IssueTrackerAdditionalScopes", Migration1095],
  [1096, "ProjectionProjectsTrackedFolders", Migration1096],
  [1097, "TaskFolders", Migration1097],
  [1098, "WorktreePathKeyIndex", Migration1098],
  [1099, "DeferredSlashCommandIndex", Migration1099],
  [1100, "AgentFeedback", Migration1100],
  [1101, "IssueTrackerAccounts", Migration1101],
  [1102, "Workflows", Migration1102],
  [1103, "SupersededRunAttemptIndex", Migration1103],
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

// T3-CUSTOM(expbkt3): V2 is fork id 1043 (upstream 55). Fork 1000-1042 are pre-V2
// and stay unguarded, like upstream's ids below 55.
const FIRST_V2_MIGRATION_ID = 1043;

export function skippedV2Migrations(
  recorded: ReadonlyArray<{ readonly id: number; readonly name: string }>,
  throughId?: number,
): string[] {
  const latestRecordedId = Math.max(0, ...recorded.map((row) => row.id));
  const recordedNames = new Map(recorded.map((row) => [row.id, row.name]));
  return migrationManifest.flatMap(([id, name]) => {
    if (
      id < FIRST_V2_MIGRATION_ID ||
      id > latestRecordedId ||
      (throughId !== undefined && id > throughId)
    )
      return [];
    const recordedName = recordedNames.get(id);
    return recordedName === name ? [] : [`${id}_${name} (recorded: ${recordedName ?? "nothing"})`];
  });
}

// Migrators skip ids up to the highest recorded; reject collisions that would skip V2 schema.
const assertV2MigrationsCanRun = Effect.fn("assertV2MigrationsCanRun")(function* (
  throughId?: number,
) {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
  `;
  if (tables.length === 0) return;
  const recorded = yield* sql<{
    readonly migration_id: number;
    readonly name: string;
  }>`SELECT migration_id, name FROM effect_sql_migrations`;
  const skipped = skippedV2Migrations(
    recorded.map((row) => ({ id: row.migration_id, name: row.name })),
    throughId,
  );
  const latestRecordedId = Math.max(0, ...recorded.map((row) => row.migration_id));
  if (skipped.length === 0) return;
  return yield* new Migrator.MigrationError({
    kind: "BadState",
    message: `This database's migration history would skip required schema migrations: ${skipped.join(", ")}. The migrator skips every id up to the highest recorded id (${latestRecordedId}), regardless of name. It was probably written by a different build. Start the build that wrote it, or report this migration history so an upgrade path can be added.`,
  });
});

const latestMigrationId = Math.max(...migrationEntries.map(([id]) => id));

// Mirrors the Migrator, which runs only ids above the highest recorded, plus the V2-preview reconciliation.
export const hasPendingMigrations = Effect.fn("hasPendingMigrations")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
  `;
  if (tables.length === 0) return true;
  const rows = yield* sql<{ readonly latestId: number | null; readonly previewRows: number }>`
    SELECT
      MAX(migration_id) AS latestId,
      SUM(name = 'OrchestrationV2' AND migration_id IN (53, 54)) AS previewRows
    FROM effect_sql_migrations
  `;
  const row = rows[0];
  return (row?.latestId ?? 0) < latestMigrationId || (row?.previewRows ?? 0) > 0;
});

const run = Migrator.make({});

export interface RunMigrationsOptions {
  readonly toMigrationInclusive?: number | undefined;
}

export const runMigrations = Effect.fn("runMigrations")(function* ({
  toMigrationInclusive,
}: RunMigrationsOptions = {}) {
  // The desktop waits past its readiness budget until the finished line follows this one.
  const hasPending = yield* hasPendingMigrations();
  if (hasPending) yield* Effect.log(DATABASE_MIGRATIONS_STARTED_MESSAGE);
  const includesV2 =
    toMigrationInclusive === undefined || toMigrationInclusive >= FIRST_V2_MIGRATION_ID;
  if (includesV2) {
    yield* assertV2MigrationsCanRun(toMigrationInclusive);
  }
  const sql = yield* SqlClient.SqlClient;
  const ledger = yield* sql`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
  `;
  const [latest] =
    ledger.length === 0
      ? []
      : yield* sql<{
          readonly id: number | null;
        }>`SELECT MAX(migration_id) AS id FROM effect_sql_migrations`;
  const latestRecordedId = latest?.id ?? 0;
  const pending = migrationEntries.filter(
    ([id]) =>
      id > latestRecordedId && (toMigrationInclusive === undefined || id <= toMigrationInclusive),
  );
  // One transaction per migration: an index build on a large database can take minutes, and a
  // restart then resumes after the last finished migration instead of rolling all of them back.
  // T3-CUSTOM(expbkt3): fork V1 ids are frozen; upstream preview ledger rewrites do not apply.
  const executedMigrations: Array<readonly [id: number, name: string]> = [];
  for (const [index, [id, name]] of pending.entries()) {
    if (latestRecordedId > 0) {
      yield* Effect.log(DATABASE_MIGRATION_PROGRESS_MESSAGE).pipe(
        Effect.annotateLogs({
          migration: `${id}_${name}`,
          progress: `${index + 1} of ${pending.length}`,
        }),
      );
    }
    executedMigrations.push(...(yield* run({ loader: makeMigrationLoader(id) })));
  }
  const migrations = executedMigrations.map(([id, name]) => `${id}_${name}`);
  yield* migrations.length === 0
    ? Effect.logDebug("Database schema is current")
    : Effect.log(DATABASE_MIGRATIONS_FINISHED_MESSAGE).pipe(Effect.annotateLogs({ migrations }));

  const recorded = yield* sql<{
    readonly migration_id: number;
    readonly name: string;
  }>`SELECT migration_id, name FROM effect_sql_migrations`;
  const manifestNames = new Map<number, string>(migrationEntries.map(([id, name]) => [id, name]));
  const divergent = recorded.flatMap((row) => {
    const expected = manifestNames.get(row.migration_id);
    if (expected === undefined) {
      return [`${row.migration_id}:${row.name} (unknown to this build)`];
    }
    return expected === row.name
      ? []
      : [`${row.migration_id}:${row.name} (this build: ${expected})`];
  });
  if (divergent.length > 0) {
    yield* Effect.logWarning(
      "Database migration history diverges from this build; recorded migration ids are skipped, not reconciled by name.",
    ).pipe(Effect.annotateLogs({ divergent }));
  }
  return executedMigrations;
});

// T3-CUSTOM(expbkt3): fork layers still compose migration startup explicitly.
export const MigrationsLive = Layer.effectDiscard(runMigrations());
