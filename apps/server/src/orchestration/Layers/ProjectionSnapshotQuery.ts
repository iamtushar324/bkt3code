import {
  AgentSessionImportSource,
  ApprovalRequestId,
  ChatAttachment,
  OrchestrationMessageContext,
  CheckpointRef,
  computeTurnDurationMs, // T3-CUSTOM(expbkt3): turn duration shown in the shell.
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  OrchestrationCheckpointFile,
  OrchestrationCheckpointStatus,
  OrchestrationProposedPlanId,
  OrchestrationReadModel,
  OrchestrationThreadSearchSource,
  type OrchestrationShellSnapshot,
  OrchestrationThread,
  OrchestrationThreadDetailSnapshot,
  ProjectScript,
  ProjectIconOverride,
  TurnId,
  type OrchestrationCheckpointSummary,
  type OrchestrationLatestTurn,
  type OrchestrationMessage,
  type OrchestrationProjectShell,
  type OrchestrationProposedPlan,
  type OrchestrationProject,
  type OrchestrationSession,
  type OrchestrationThreadActivity,
  type OrchestrationThreadShell,
  ModelSelection,
  ProjectId,
  ThreadLinkedPullRequest,
  ThreadTitleState,
  ThreadId,
  UserId, // T3-CUSTOM(expbkt3): team mode ownership/membership.
  ThreadPullRequestSnapshot,
  ThreadPullRequestStack,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import { legacyLinkedPullRequestOf } from "@t3tools/shared/threadPullRequests";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import {
  isPersistenceError,
  toPersistenceDecodeError,
  toPersistenceSqlError,
  type ProjectionRepositoryError,
} from "../../persistence/Errors.ts";
import { ThreadBackgroundLivenessService } from "../ThreadBackgroundLiveness.ts";
import { ThreadPlanProgressService } from "../ThreadPlanProgress.ts";
import { ProjectionProject } from "../../persistence/Services/ProjectionProjects.ts";
import { ProjectionState } from "../../persistence/Services/ProjectionState.ts";
import { ProjectionThreadActivity } from "../../persistence/Services/ProjectionThreadActivities.ts";
import { ProjectionThreadMessage } from "../../persistence/Services/ProjectionThreadMessages.ts";
import { ProjectionThreadProposedPlan } from "../../persistence/Services/ProjectionThreadProposedPlans.ts";
import { ProjectionThreadPullRequest } from "../../persistence/ProjectionThreadPullRequests.ts";
import { ProjectionThreadSession } from "../../persistence/Services/ProjectionThreadSessions.ts";
import { ProjectionThread } from "../../persistence/Services/ProjectionThreads.ts";
import {
  decodeThreadDetailPageCursor,
  encodeThreadDetailPageCursor,
} from "../threadDetailCursor.ts";
import { projectActivityPayload } from "../ActivityPayloadProjection.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { ORCHESTRATION_PROJECTOR_NAMES } from "./ProjectionPipeline.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionEventReplayStats,
  type ProjectionFullThreadDiffContext,
  // T3-CUSTOM(expbkt3): bounded startup projection reads.
  type ProjectionLatestProposedPlan,
  type ProjectionSnapshotCounts,
  type ProjectionThreadAccess,
  type ProjectionThreadCheckpointContext,
  type ProjectionThreadDetailQuery,
  type ProjectionThreadPullRequests,
  type ProjectionSnapshotQueryShape,
} from "../Services/ProjectionSnapshotQuery.ts";

const decodeReadModel = Schema.decodeUnknownEffect(OrchestrationReadModel);
const decodeThread = Schema.decodeUnknownEffect(OrchestrationThread);
const decodeImportedTranscriptsPayload = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      importedTranscripts: Schema.Array(Schema.Unknown),
    }),
  ),
);
const decodeAgentSessionImportSource = Schema.decodeUnknownOption(AgentSessionImportSource);
// Keep detail reads consistent with the in-memory projector's retained
// activity window. Applying the limit in SQL avoids decoding an unbounded
// payload_json set before the projector can enforce that invariant.
const THREAD_DETAIL_ACTIVITY_LIMIT = 500;
// Snapshot payloads are decoded and projected in small sequential batches so
// one client read does not retain the raw payloads for the full activity window.
const THREAD_DETAIL_ACTIVITY_PAYLOAD_BATCH_SIZE = 25;
// SQLite trim defaults to spaces. Match the whitespace removed by String.trim.
const MESSAGE_TRIM_WHITESPACE =
  "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff";
const ProjectionProjectDbRowSchema = ProjectionProject.mapFields(
  Struct.assign({
    defaultModelSelection: Schema.NullOr(Schema.fromJsonString(ModelSelection)),
    autoPull: Schema.Number,
    projectIcon: Schema.NullOr(Schema.fromJsonString(ProjectIconOverride)),
    scripts: Schema.fromJsonString(Schema.Array(ProjectScript)),
  }),
);
const ProjectionThreadMessageDbRowSchema = ProjectionThreadMessage.mapFields(
  Struct.assign({
    isStreaming: Schema.Number,
    attachments: Schema.NullOr(Schema.fromJsonString(Schema.Array(ChatAttachment))),
    context: Schema.NullOr(Schema.fromJsonString(OrchestrationMessageContext)),
  }),
);
const ProjectionTurnStartMessageDbRowSchema = ProjectionThreadMessageDbRowSchema.mapFields(
  Struct.assign({ hasOtherUserMessages: Schema.Number }),
);
const ProjectionThreadProposedPlanDbRowSchema = ProjectionThreadProposedPlan;
const ProjectionThreadPullRequestDbRowSchema = ProjectionThreadPullRequest.mapFields(
  Struct.assign({
    snapshot: Schema.NullOr(Schema.fromJsonString(ThreadPullRequestSnapshot)),
    stack: Schema.NullOr(Schema.fromJsonString(ThreadPullRequestStack)),
  }),
);
const ProjectionThreadDbRowSchema = ProjectionThread.mapFields(
  Struct.assign({
    modelSelection: Schema.fromJsonString(ModelSelection),
    titleState: Schema.NullOr(Schema.fromJsonString(ThreadTitleState)),
    linkedPullRequest: Schema.NullOr(Schema.fromJsonString(ThreadLinkedPullRequest)),
    branchPullRequest: Schema.NullOr(Schema.fromJsonString(ThreadLinkedPullRequest)),
  }),
);
const ProjectionThreadActivityDbRowSchema = ProjectionThreadActivity.mapFields(
  Struct.assign({
    payload: Schema.fromJsonString(Schema.Unknown),
    sequence: Schema.NullOr(NonNegativeInt),
  }),
);
const ProjectionThreadActivityIdRowSchema = Schema.Struct({
  activityId: ProjectionThreadActivity.fields.activityId,
});
const ProjectionThreadSessionDbRowSchema = ProjectionThreadSession;
const ProjectionThreadRuntimeContextDbRowSchema = Schema.Struct({
  titleState: Schema.NullOr(Schema.fromJsonString(ThreadTitleState)),
  id: ThreadId,
  projectId: ProjectId,
  title: Schema.String,
  session: Schema.NullOr(ProjectionThreadSessionDbRowSchema),
});
const ProjectionCheckpointDbRowSchema = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  checkpointTurnCount: NonNegativeInt,
  checkpointRef: CheckpointRef,
  status: OrchestrationCheckpointStatus,
  files: Schema.fromJsonString(Schema.Array(OrchestrationCheckpointFile)),
  assistantMessageId: Schema.NullOr(MessageId),
  completedAt: IsoDateTime,
});
const ProjectionLatestTurnDbRowSchema = Schema.Struct({
  threadId: ProjectionThread.fields.threadId,
  turnId: TurnId,
  state: Schema.String,
  requestedAt: IsoDateTime,
  startedAt: Schema.NullOr(IsoDateTime),
  completedAt: Schema.NullOr(IsoDateTime),
  assistantMessageId: Schema.NullOr(MessageId),
  sourceProposedPlanThreadId: Schema.NullOr(ThreadId),
  sourceProposedPlanId: Schema.NullOr(OrchestrationProposedPlanId),
});
// T3-CUSTOM(expbkt3): BEGIN — team mode: row shape used to authorize access by owner/membership.
const ProjectionThreadAccessRowSchema = Schema.Struct({
  threadId: ProjectionThread.fields.threadId,
  projectId: ProjectionThread.fields.projectId,
  ownerUserId: ProjectionThread.fields.ownerUserId,
});
// T3-CUSTOM(expbkt3): END
const ProjectionStateDbRowSchema = ProjectionState;
const ProjectionCountsRowSchema = Schema.Struct({
  projectCount: Schema.Number,
  threadCount: Schema.Number,
});
const EventReplayStatsInput = Schema.Struct({
  fromSequenceExclusive: NonNegativeInt,
  toSequenceInclusive: NonNegativeInt,
});
const EventReplayStatsRowSchema = Schema.Struct({
  eventCount: Schema.Number,
  payloadBytes: Schema.Number,
});
const ActiveThreadRowsRequest = Schema.Struct({ unsettledOnly: Schema.Boolean });
const ProjectionThreadSearchRequest = Schema.Struct({
  pattern: Schema.String,
  limit: Schema.Int,
});
const ProjectionThreadSearchRow = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  source: OrchestrationThreadSearchSource,
  matchText: Schema.String,
  messageCreatedAt: Schema.NullOr(IsoDateTime),
});
const WorkspaceRootLookupInput = Schema.Struct({
  workspaceRoot: Schema.String,
});
const ProjectIdLookupInput = Schema.Struct({
  projectId: ProjectId,
});
const ProjectionImportedAgentSessionSourcesRowSchema = Schema.Struct({
  threadId: ThreadId,
  runtimePayload: Schema.Unknown,
});
const ThreadIdLookupInput = Schema.Struct({
  threadId: ThreadId,
});
const TurnStartMessageLookupInput = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
});
const ThreadActivityKindsLookupInput = Schema.Struct({
  threadId: ThreadId,
  activityKinds: Schema.Array(Schema.String),
});
const ThreadActivityIdsLookupInput = Schema.Struct({
  activityIds: Schema.Array(ProjectionThreadActivity.fields.activityId),
});
// Windowed reads order turns by the stable keyset (anchor, turn key), where
// anchor is requested_at and turn key is
// COALESCE(turn_id, ''). Both are event-derived, so cursors survive the
// revert projector's row-id rewrite and full projection rebuilds.
const ThreadTurnWindowLookupInput = Schema.Struct({
  threadId: ThreadId,
  // Exclusive keyset upper bound. Sentinels "~"/"" mean unbounded ("~" sorts
  // after every ISO timestamp).
  beforeAnchorAt: Schema.String,
  beforeTurnKey: Schema.String,
  userTurnLimit: Schema.Number,
  maxRawTurns: Schema.Number,
});
const ProjectionTurnWindowRowSchema = Schema.Struct({
  // The turn's timeline anchor, used to bound rows that have no turn linkage
  // (user messages and turnless activities) to the same page window.
  anchorAt: Schema.String,
  turnKey: Schema.String,
});
const ThreadTurnRangeLookupInput = Schema.Struct({
  threadId: ThreadId,
  // Turn-linked rows are bounded by the keyset range [min, before) over
  // (anchor, turn key); turnless rows by the matching [minAnchorAt,
  // beforeAnchorAt) time range. Unbounded ends use sentinels: "" for the
  // lower bound, "~" (sorts after ISO dates) for the upper bound.
  minAnchorAt: Schema.String,
  minTurnKey: Schema.String,
  beforeAnchorAt: Schema.String,
  beforeTurnKey: Schema.String,
});
const ProjectionProjectLookupRowSchema = ProjectionProjectDbRowSchema;
const ProjectionThreadIdLookupRowSchema = Schema.Struct({
  threadId: ThreadId,
});
const ProjectionThreadCheckpointContextThreadRowSchema = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  workspaceRoot: Schema.String,
  worktreePath: Schema.NullOr(Schema.String),
});
const FullThreadDiffContextLookupInput = Schema.Struct({
  threadId: ThreadId,
  checkpointTurnCount: NonNegativeInt,
});
const ProjectionFullThreadDiffContextRowSchema = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  workspaceRoot: Schema.String,
  worktreePath: Schema.NullOr(Schema.String),
  latestCheckpointTurnCount: Schema.NullOr(NonNegativeInt),
  toCheckpointRef: Schema.NullOr(CheckpointRef),
});

const REQUIRED_SNAPSHOT_PROJECTORS = [
  ORCHESTRATION_PROJECTOR_NAMES.projects,
  ORCHESTRATION_PROJECTOR_NAMES.threads,
  ORCHESTRATION_PROJECTOR_NAMES.threadMessages,
  ORCHESTRATION_PROJECTOR_NAMES.threadProposedPlans,
  ORCHESTRATION_PROJECTOR_NAMES.threadActivities,
  ORCHESTRATION_PROJECTOR_NAMES.threadSessions,
  ORCHESTRATION_PROJECTOR_NAMES.checkpoints,
] as const;

function maxIso(left: string | null, right: string): string {
  if (left === null) {
    return right;
  }
  return left > right ? left : right;
}

function escapeLikePattern(value: string): string {
  return value.replaceAll("!", "!!").replaceAll("%", "!%").replaceAll("_", "!_");
}

function foldAsciiCase(value: string): string {
  return value.replace(/[A-Z]/g, (character) => character.toLowerCase());
}

function buildSearchSnippet(text: string, query: string): string {
  const normalizedText = text.replace(/\s+/g, " ").trim();
  if (normalizedText.length <= 240) {
    return normalizedText;
  }

  const normalizedQuery = foldAsciiCase(query.replace(/\s+/g, " ").trim());
  const matchIndex = foldAsciiCase(normalizedText).indexOf(normalizedQuery);
  const bodyLength = 236;
  const idealStart = Math.max(0, matchIndex - 72);
  const start = Math.min(idealStart, normalizedText.length - bodyLength);
  const end = Math.min(normalizedText.length, start + bodyLength);
  return `${start > 0 ? "…" : ""}${normalizedText.slice(start, end)}${
    end < normalizedText.length ? "…" : ""
  }`;
}

function computeSnapshotSequence(
  stateRows: ReadonlyArray<Schema.Schema.Type<typeof ProjectionStateDbRowSchema>>,
): number {
  if (stateRows.length === 0) {
    return 0;
  }
  const sequenceByProjector = new Map(
    stateRows.map((row) => [row.projector, row.lastAppliedSequence] as const),
  );

  let minSequence = Number.POSITIVE_INFINITY;
  for (const projector of REQUIRED_SNAPSHOT_PROJECTORS) {
    const sequence = sequenceByProjector.get(projector);
    if (sequence === undefined) {
      return 0;
    }
    if (sequence < minSequence) {
      minSequence = sequence;
    }
  }

  return Number.isFinite(minSequence) ? minSequence : 0;
}

function mapLatestTurn(
  row: Schema.Schema.Type<typeof ProjectionLatestTurnDbRowSchema>,
): OrchestrationLatestTurn {
  return {
    turnId: row.turnId,
    state:
      row.state === "error"
        ? "error"
        : row.state === "interrupted"
          ? "interrupted"
          : row.state === "completed"
            ? "completed"
            : "running",
    requestedAt: row.requestedAt,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    assistantMessageId: row.assistantMessageId,
    durationMs: computeTurnDurationMs(row.startedAt, row.completedAt), // T3-CUSTOM(expbkt3): turn duration shown in the shell.
    ...(row.sourceProposedPlanThreadId !== null && row.sourceProposedPlanId !== null
      ? {
          sourceProposedPlan: {
            threadId: row.sourceProposedPlanThreadId,
            planId: row.sourceProposedPlanId,
          },
        }
      : {}),
  };
}

function mapTitleRegeneration(row: Schema.Schema.Type<typeof ProjectionThreadDbRowSchema>) {
  return row.titleRegenerationRequestId != null && row.titleRegenerationStartedAt != null
    ? {
        requestId: row.titleRegenerationRequestId,
        startedAt: row.titleRegenerationStartedAt,
      }
    : null;
}

function mapSessionRow(
  row: Schema.Schema.Type<typeof ProjectionThreadSessionDbRowSchema>,
): OrchestrationSession {
  return {
    threadId: row.threadId,
    status: row.status,
    providerName: row.providerName,
    ...(row.providerInstanceId !== null ? { providerInstanceId: row.providerInstanceId } : {}),
    providerThreadId: row.providerThreadId, // T3-CUSTOM(expbkt3): surfaced on the session row for the shell.
    runtimeMode: row.runtimeMode,
    activeTurnId: row.activeTurnId,
    lastError: row.lastError,
    updatedAt: row.updatedAt,
  };
}

function mapProjectShellRow(
  row: Schema.Schema.Type<typeof ProjectionProjectDbRowSchema>,
  repositoryIdentity: OrchestrationProject["repositoryIdentity"],
  memberUserIds: ReadonlyArray<UserId> = [], // T3-CUSTOM(expbkt3): team mode project membership.
): OrchestrationProjectShell {
  return {
    id: row.projectId,
    title: row.title,
    workspaceRoot: row.workspaceRoot,
    repositoryIdentity,
    defaultModelSelection: row.defaultModelSelection,
    defaultThreadEnvMode: row.defaultThreadEnvMode,
    autoPull: row.autoPull === 1,
    faviconPath: row.faviconPath ?? null,
    projectIcon: row.projectIcon ?? null,
    scripts: row.scripts,
    // T3-CUSTOM(expbkt3): BEGIN — team mode: project ownership/membership.
    ownerUserId: row.ownerUserId,
    memberUserIds,
    // T3-CUSTOM(expbkt3): END
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapProposedPlanRow(
  row: Schema.Schema.Type<typeof ProjectionThreadProposedPlanDbRowSchema>,
): OrchestrationProposedPlan {
  return {
    id: row.planId,
    turnId: row.turnId,
    planMarkdown: row.planMarkdown,
    implementedAt: row.implementedAt,
    implementationThreadId: row.implementationThreadId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapPullRequestRow(
  row: Schema.Schema.Type<typeof ProjectionThreadPullRequestDbRowSchema>,
): ThreadPullRequestLink {
  return {
    host: row.host,
    repository: row.repository,
    number: row.number,
    url: row.url,
    source: row.source,
    linkedAt: row.linkedAt,
    snapshot: row.snapshot,
    stack: row.stack,
  };
}

function groupPullRequestRowsByThread(
  rows: ReadonlyArray<Schema.Schema.Type<typeof ProjectionThreadPullRequestDbRowSchema>>,
): Map<string, Array<ThreadPullRequestLink>> {
  const byThread = new Map<string, Array<ThreadPullRequestLink>>();
  for (const row of rows) {
    const links = byThread.get(row.threadId) ?? [];
    links.push(mapPullRequestRow(row));
    byThread.set(row.threadId, links);
  }
  return byThread;
}

/**
 * The link array plus the legacy single-link field derived from it, so clients
 * from before `pullRequests` keep seeing the thread's current pull request.
 */
function mapThreadPullRequests(
  pullRequests: ReadonlyArray<ThreadPullRequestLink>,
  projectId: ProjectId,
  identity?: OrchestrationProject["repositoryIdentity"],
): Pick<OrchestrationThread, "pullRequests" | "linkedPullRequest"> {
  const linkedPullRequest = legacyLinkedPullRequestOf(pullRequests, projectId, identity);
  return {
    pullRequests,
    ...(linkedPullRequest === null ? {} : { linkedPullRequest }),
  };
}

function mapThreadActivityRow(
  row: Schema.Schema.Type<typeof ProjectionThreadActivityDbRowSchema>,
): OrchestrationThreadActivity {
  return {
    id: row.activityId,
    tone: row.tone,
    kind: row.kind,
    summary: row.summary,
    payload: row.payload,
    turnId: row.turnId,
    createdAt: row.createdAt,
    ...(row.sequence !== null ? { sequence: row.sequence } : {}),
  };
}

function toPersistenceSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown): ProjectionRepositoryError =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

const makeProjectionSnapshotQuery = Effect.gen(function* () {
  const threadBackgroundLiveness = yield* ThreadBackgroundLivenessService;
  const threadPlanProgress = yield* ThreadPlanProgressService;
  const sql = yield* SqlClient.SqlClient;
  const repositoryIdentityResolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
  const repositoryIdentityResolutionConcurrency = 4;
  const resolveRepositoryIdentitiesForProjects = Effect.fn(
    "ProjectionSnapshotQuery.resolveRepositoryIdentitiesForProjects",
  )(function* (
    projectRows: ReadonlyArray<Schema.Schema.Type<typeof ProjectionProjectDbRowSchema>>,
    options?: {
      readonly includeDeleted?: boolean;
    },
  ) {
    const filteredProjectRows =
      options?.includeDeleted === true
        ? projectRows
        : projectRows.filter((row) => row.deletedAt === null);
    const uniqueWorkspaceRoots = [...new Set(filteredProjectRows.map((row) => row.workspaceRoot))];
    const repositoryIdentityByWorkspaceRoot = new Map(
      yield* Effect.forEach(
        uniqueWorkspaceRoots,
        (workspaceRoot) =>
          repositoryIdentityResolver
            .resolve(workspaceRoot)
            .pipe(Effect.map((identity) => [workspaceRoot, identity] as const)),
        { concurrency: repositoryIdentityResolutionConcurrency },
      ),
    );

    return new Map(
      filteredProjectRows.map((row) => [
        row.projectId,
        repositoryIdentityByWorkspaceRoot.get(row.workspaceRoot) ?? null,
      ]),
    );
  });

  // T3-CUSTOM(expbkt3): BEGIN — team mode: thread/project membership rows, hydrated and
  // grouped the same way as the other per-entity collections (sessions/messages).
  // Membership rows are hydrated in bulk (one query, grouped by id) alongside
  // the other per-entity collections — same shape as sessions/messages.
  const ThreadMemberRow = Schema.Struct({ threadId: ThreadId, userId: UserId });
  const ProjectMemberRow = Schema.Struct({ projectId: ProjectId, userId: UserId });

  const listThreadMemberRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ThreadMemberRow,
    execute: () =>
      sql`
        SELECT thread_id AS "threadId", user_id AS "userId"
        FROM projection_thread_members
        ORDER BY added_at ASC, user_id ASC
      `,
  });

  const listProjectMemberRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectMemberRow,
    execute: () =>
      sql`
        SELECT project_id AS "projectId", user_id AS "userId"
        FROM projection_project_members
        ORDER BY added_at ASC, user_id ASC
      `,
  });

  const listThreadMemberRowsByThreadId = SqlSchema.findAll({
    Request: Schema.Struct({ threadId: ThreadId }),
    Result: ThreadMemberRow,
    execute: ({ threadId }) =>
      sql`
        SELECT thread_id AS "threadId", user_id AS "userId"
        FROM projection_thread_members
        WHERE thread_id = ${threadId}
        ORDER BY added_at ASC, user_id ASC
      `,
  });

  const listProjectMemberRowsByProjectId = SqlSchema.findAll({
    Request: Schema.Struct({ projectId: ProjectId }),
    Result: ProjectMemberRow,
    execute: ({ projectId }) =>
      sql`
        SELECT project_id AS "projectId", user_id AS "userId"
        FROM projection_project_members
        WHERE project_id = ${projectId}
        ORDER BY added_at ASC, user_id ASC
      `,
  });

  const groupThreadMemberIds = (
    rows: ReadonlyArray<{ readonly threadId: ThreadId; readonly userId: UserId }>,
  ): Map<string, UserId[]> => {
    const byThread = new Map<string, UserId[]>();
    for (const row of rows) {
      const existing = byThread.get(row.threadId) ?? [];
      existing.push(row.userId);
      byThread.set(row.threadId, existing);
    }
    return byThread;
  };

  const groupProjectMemberIds = (
    rows: ReadonlyArray<{ readonly projectId: ProjectId; readonly userId: UserId }>,
  ): Map<string, UserId[]> => {
    const byProject = new Map<string, UserId[]>();
    for (const row of rows) {
      const existing = byProject.get(row.projectId) ?? [];
      existing.push(row.userId);
      byProject.set(row.projectId, existing);
    }
    return byProject;
  };
  // T3-CUSTOM(expbkt3): END

  const listProjectRows = SqlSchema.findAll({
    Request: Schema.UndefinedOr(
      Schema.Struct({
        activeOnly: Schema.Boolean,
        projectIds: Schema.optional(Schema.Array(ProjectId)),
      }),
    ),
    Result: ProjectionProjectDbRowSchema,
    execute: (filter) =>
      sql`
        SELECT
          project_id AS "projectId",
          title,
          workspace_root AS "workspaceRoot",
          default_model_selection_json AS "defaultModelSelection",
          default_thread_env_mode AS "defaultThreadEnvMode",
          auto_pull AS "autoPull",
          favicon_path AS "faviconPath",
          project_icon_json AS "projectIcon",
          scripts_json AS "scripts",
          owner_user_id AS "ownerUserId", -- T3-CUSTOM(expbkt3): team mode project ownership.
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          deleted_at AS "deletedAt"
        FROM projection_projects
        WHERE ${filter?.activeOnly === true ? sql`deleted_at IS NULL` : sql`1 = 1`}
          AND ${filter?.projectIds === undefined ? sql`1 = 1` : sql.in("project_id", filter.projectIds)}
        ORDER BY created_at ASC, project_id ASC
      `,
  });

  const listThreadRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadDbRowSchema,
    execute: () =>
      sql`
        SELECT
          thread_id AS "threadId",
          project_id AS "projectId",
          title,
          title_state_json AS "titleState",
          model_selection_json AS "modelSelection",
          runtime_mode AS "runtimeMode",
          interaction_mode AS "interactionMode",
          branch,
          worktree_path AS "worktreePath",
          source_control_profile_id AS "sourceControlProfileId", -- T3-CUSTOM(expbkt3): source-control identity.
          linked_pull_request_json AS "linkedPullRequest",
          branch_pull_request_json AS "branchPullRequest",
          latest_turn_id AS "latestTurnId",
          owner_user_id AS "ownerUserId", -- T3-CUSTOM(expbkt3): team mode thread ownership.
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          archived_at AS "archivedAt",
          settled_override AS "settledOverride",
          settled_at AS "settledAt",
          unsettled_at AS "unsettledAt",
          snoozed_until AS "snoozedUntil",
          snoozed_at AS "snoozedAt",
          -- T3-CUSTOM(expbkt3): BEGIN — priority, custom sidebar group, Linear/Mattermost
          -- links, and thread lineage (parent thread/environment).
          priority,
          custom_group AS "customGroup", -- T3-CUSTOM(expbkt3): custom sidebar group.
          linear_issue_url AS "linearIssueUrl",
          mattermost_thread_url AS "mattermostThreadUrl",
          parent_thread_id AS "parentThreadId",
          parent_environment_id AS "parentEnvironmentId",
          -- T3-CUSTOM(expbkt3): END
          pinned_at AS "pinnedAt",
          pin_order_key AS "pinOrderKey",
          active_order_key AS "activeOrderKey",
          auto_settle_disabled_at AS "autoSettleDisabledAt",
          title_regeneration_request_id AS "titleRegenerationRequestId",
          title_regeneration_started_at AS "titleRegenerationStartedAt",
          latest_user_message_at AS "latestUserMessageAt",
          pending_approval_count AS "pendingApprovalCount",
          pending_user_input_count AS "pendingUserInputCount",
          -- T3-CUSTOM(expbkt3): async input is visible but never blocking.
          pending_async_user_input_count AS "pendingAsyncUserInputCount",
          has_actionable_proposed_plan AS "hasActionableProposedPlan",
          deleted_at AS "deletedAt"
        FROM projection_threads
        ORDER BY created_at ASC, thread_id ASC
      `,
  });

  // Background sweeps skip settled threads, the same check PR discovery makes.
  const unsettledThreadsFilter = (unsettledOnly: boolean) =>
    unsettledOnly
      ? sql`AND threads.settled_at IS NULL AND threads.settled_override IS NOT 'settled'`
      : sql``;

  const listActiveThreadRows = SqlSchema.findAll({
    Request: ActiveThreadRowsRequest,
    Result: ProjectionThreadDbRowSchema,
    execute: (request) =>
      sql`
        SELECT
          thread_id AS "threadId",
          project_id AS "projectId",
          title,
          title_state_json AS "titleState",
          model_selection_json AS "modelSelection",
          runtime_mode AS "runtimeMode",
          interaction_mode AS "interactionMode",
          branch,
          worktree_path AS "worktreePath",
          source_control_profile_id AS "sourceControlProfileId", -- T3-CUSTOM(expbkt3): source-control identity.
          linked_pull_request_json AS "linkedPullRequest",
          branch_pull_request_json AS "branchPullRequest",
          latest_turn_id AS "latestTurnId",
          owner_user_id AS "ownerUserId", -- T3-CUSTOM(expbkt3): team mode thread ownership.
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          archived_at AS "archivedAt",
          settled_override AS "settledOverride",
          settled_at AS "settledAt",
          unsettled_at AS "unsettledAt",
          snoozed_until AS "snoozedUntil",
          snoozed_at AS "snoozedAt",
          -- T3-CUSTOM(expbkt3): BEGIN — priority, custom sidebar group, Linear/Mattermost
          -- links, and thread lineage (parent thread/environment).
          priority,
          custom_group AS "customGroup", -- T3-CUSTOM(expbkt3): custom sidebar group.
          linear_issue_url AS "linearIssueUrl",
          mattermost_thread_url AS "mattermostThreadUrl",
          parent_thread_id AS "parentThreadId",
          parent_environment_id AS "parentEnvironmentId",
          -- T3-CUSTOM(expbkt3): END
          pinned_at AS "pinnedAt",
          pin_order_key AS "pinOrderKey",
          active_order_key AS "activeOrderKey",
          auto_settle_disabled_at AS "autoSettleDisabledAt",
          title_regeneration_request_id AS "titleRegenerationRequestId",
          title_regeneration_started_at AS "titleRegenerationStartedAt",
          latest_user_message_at AS "latestUserMessageAt",
          pending_approval_count AS "pendingApprovalCount",
          pending_user_input_count AS "pendingUserInputCount",
          -- T3-CUSTOM(expbkt3): async input is visible but never blocking.
          pending_async_user_input_count AS "pendingAsyncUserInputCount",
          has_actionable_proposed_plan AS "hasActionableProposedPlan",
          deleted_at AS "deletedAt"
        FROM projection_threads threads
        WHERE deleted_at IS NULL
          AND archived_at IS NULL
          ${unsettledThreadsFilter(request.unsettledOnly)}
        ORDER BY project_id ASC, created_at ASC, thread_id ASC
      `,
  });

  const listDeletedWorktreeRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: Schema.Struct({
      id: ThreadId,
      projectId: ProjectId,
      branch: Schema.String,
      worktreePath: Schema.String,
      workspaceRoot: Schema.String,
      deletedAt: IsoDateTime,
    }),
    execute: () => sql`
      SELECT t.thread_id AS "id", t.project_id AS "projectId", t.branch,
        t.worktree_path AS "worktreePath", p.workspace_root AS "workspaceRoot",
        t.deleted_at AS "deletedAt"
      FROM projection_threads t
      JOIN projection_projects p ON p.project_id = t.project_id
      WHERE t.deleted_at IS NOT NULL AND t.worktree_path IS NOT NULL AND t.branch IS NOT NULL
      ORDER BY t.deleted_at DESC, t.thread_id ASC
    `,
  });
  const getDeletedWorktreeThreads: ProjectionSnapshotQueryShape["getDeletedWorktreeThreads"] = () =>
    listDeletedWorktreeRows(undefined).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionSnapshotQuery.getDeletedWorktreeThreads:query",
          "ProjectionSnapshotQuery.getDeletedWorktreeThreads:decodeRows",
        ),
      ),
    );

  const listArchivedThreadRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadDbRowSchema,
    execute: () =>
      sql`
        SELECT
          thread_id AS "threadId",
          project_id AS "projectId",
          title,
          title_state_json AS "titleState",
          model_selection_json AS "modelSelection",
          runtime_mode AS "runtimeMode",
          interaction_mode AS "interactionMode",
          branch,
          worktree_path AS "worktreePath",
          source_control_profile_id AS "sourceControlProfileId", -- T3-CUSTOM(expbkt3): source-control identity.
          linked_pull_request_json AS "linkedPullRequest",
          branch_pull_request_json AS "branchPullRequest",
          latest_turn_id AS "latestTurnId",
          owner_user_id AS "ownerUserId", -- T3-CUSTOM(expbkt3): team mode thread ownership.
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          archived_at AS "archivedAt",
          settled_override AS "settledOverride",
          settled_at AS "settledAt",
          unsettled_at AS "unsettledAt",
          snoozed_until AS "snoozedUntil",
          snoozed_at AS "snoozedAt",
          -- T3-CUSTOM(expbkt3): BEGIN — priority, custom sidebar group, Linear/Mattermost
          -- links, and thread lineage (parent thread/environment).
          priority,
          custom_group AS "customGroup", -- T3-CUSTOM(expbkt3): custom sidebar group.
          linear_issue_url AS "linearIssueUrl",
          mattermost_thread_url AS "mattermostThreadUrl",
          parent_thread_id AS "parentThreadId",
          parent_environment_id AS "parentEnvironmentId",
          -- T3-CUSTOM(expbkt3): END
          pinned_at AS "pinnedAt",
          pin_order_key AS "pinOrderKey",
          active_order_key AS "activeOrderKey",
          auto_settle_disabled_at AS "autoSettleDisabledAt",
          title_regeneration_request_id AS "titleRegenerationRequestId",
          title_regeneration_started_at AS "titleRegenerationStartedAt",
          latest_user_message_at AS "latestUserMessageAt",
          pending_approval_count AS "pendingApprovalCount",
          pending_user_input_count AS "pendingUserInputCount",
          -- T3-CUSTOM(expbkt3): async input is visible but never blocking.
          pending_async_user_input_count AS "pendingAsyncUserInputCount",
          has_actionable_proposed_plan AS "hasActionableProposedPlan",
          deleted_at AS "deletedAt"
        FROM projection_threads
        WHERE deleted_at IS NULL
          AND archived_at IS NOT NULL
        ORDER BY project_id ASC, archived_at DESC, thread_id DESC
      `,
  });

  const listThreadMessageRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadMessageDbRowSchema,
    execute: () =>
      sql`
        SELECT
          message_id AS "messageId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          role,
          text,
          attachments_json AS "attachments",
          context_json AS "context",
          is_streaming AS "isStreaming",
          sent_by_user_id AS "sentByUserId", -- T3-CUSTOM(expbkt3): team mode message attribution.
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_thread_messages
        ORDER BY thread_id ASC, created_at ASC, message_id ASC
      `,
  });

  const listThreadProposedPlanRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadProposedPlanDbRowSchema,
    execute: () =>
      sql`
        SELECT
          plan_id AS "planId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          plan_markdown AS "planMarkdown",
          implemented_at AS "implementedAt",
          implementation_thread_id AS "implementationThreadId",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_thread_proposed_plans
        ORDER BY thread_id ASC, created_at ASC, plan_id ASC
      `,
  });

  const listThreadPullRequestRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadPullRequestDbRowSchema,
    execute: () =>
      sql`
        SELECT
          thread_id AS "threadId",
          host,
          repository,
          number,
          url,
          source,
          linked_at AS "linkedAt",
          snapshot_json AS "snapshot",
          stack_json AS "stack"
        FROM projection_thread_pull_requests
        ORDER BY thread_id ASC, linked_at ASC, number ASC
      `,
  });

  const listActiveThreadPullRequestRows = SqlSchema.findAll({
    Request: ActiveThreadRowsRequest,
    Result: ProjectionThreadPullRequestDbRowSchema,
    execute: (request) =>
      sql`
        SELECT
          links.thread_id AS "threadId",
          links.host,
          links.repository,
          links.number,
          links.url,
          links.source,
          links.linked_at AS "linkedAt",
          links.snapshot_json AS "snapshot",
          links.stack_json AS "stack"
        FROM projection_thread_pull_requests links
        INNER JOIN projection_threads threads
          ON threads.thread_id = links.thread_id
        WHERE threads.deleted_at IS NULL
          AND threads.archived_at IS NULL
          ${unsettledThreadsFilter(request.unsettledOnly)}
        ORDER BY links.thread_id ASC, links.linked_at ASC, links.number ASC
      `,
  });

  // One row per link, in the shell snapshot's thread order and link order.
  const listActiveThreadPullRequestSyncRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadPullRequestDbRowSchema.mapFields(
      Struct.assign({
        projectId: ProjectionThread.fields.projectId,
        settledOverride: ProjectionThread.fields.settledOverride,
        settledAt: ProjectionThread.fields.settledAt,
      }),
    ),
    execute: () =>
      sql`
        SELECT
          links.thread_id AS "threadId",
          threads.project_id AS "projectId",
          threads.settled_override AS "settledOverride",
          threads.settled_at AS "settledAt",
          links.host,
          links.repository,
          links.number,
          links.url,
          links.source,
          links.linked_at AS "linkedAt",
          links.snapshot_json AS "snapshot",
          links.stack_json AS "stack"
        FROM projection_thread_pull_requests links
        INNER JOIN projection_threads threads
          ON threads.thread_id = links.thread_id
        WHERE threads.deleted_at IS NULL
          AND threads.archived_at IS NULL
        ORDER BY threads.project_id ASC, threads.created_at ASC, threads.thread_id ASC,
          links.linked_at ASC, links.number ASC
      `,
  });

  const listArchivedThreadPullRequestRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadPullRequestDbRowSchema,
    execute: () =>
      sql`
        SELECT
          links.thread_id AS "threadId",
          links.host,
          links.repository,
          links.number,
          links.url,
          links.source,
          links.linked_at AS "linkedAt",
          links.snapshot_json AS "snapshot",
          links.stack_json AS "stack"
        FROM projection_thread_pull_requests links
        INNER JOIN projection_threads threads
          ON threads.thread_id = links.thread_id
        WHERE threads.deleted_at IS NULL
          AND threads.archived_at IS NOT NULL
        ORDER BY links.thread_id ASC, links.linked_at ASC, links.number ASC
      `,
  });

  const listThreadActivityRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadActivityDbRowSchema,
    execute: () =>
      sql`
        SELECT
          activity_id AS "activityId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          tone,
          kind,
          summary,
          payload_json AS "payload",
          sequence,
          created_at AS "createdAt"
        FROM projection_thread_activities
        ORDER BY
          thread_id ASC,
          sequence ASC,
          created_at ASC,
          activity_id ASC
      `,
  });

  const listThreadSessionRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadSessionDbRowSchema,
    execute: () =>
      sql`
        SELECT
          thread_id AS "threadId",
          status,
          provider_name AS "providerName",
          provider_instance_id AS "providerInstanceId",
          provider_session_id AS "providerSessionId",
          provider_thread_id AS "providerThreadId",
          runtime_mode AS "runtimeMode",
          active_turn_id AS "activeTurnId",
          last_error AS "lastError",
          updated_at AS "updatedAt"
        FROM projection_thread_sessions
        ORDER BY thread_id ASC
      `,
  });

  const listActiveThreadSessionRows = SqlSchema.findAll({
    Request: ActiveThreadRowsRequest,
    Result: ProjectionThreadSessionDbRowSchema,
    execute: (request) =>
      sql`
        SELECT
          sessions.thread_id AS "threadId",
          sessions.status,
          sessions.provider_name AS "providerName",
          sessions.provider_instance_id AS "providerInstanceId",
          sessions.provider_session_id AS "providerSessionId",
          sessions.provider_thread_id AS "providerThreadId",
          sessions.runtime_mode AS "runtimeMode",
          sessions.active_turn_id AS "activeTurnId",
          sessions.last_error AS "lastError",
          sessions.updated_at AS "updatedAt"
        FROM projection_thread_sessions sessions
        INNER JOIN projection_threads threads
          ON threads.thread_id = sessions.thread_id
        WHERE threads.deleted_at IS NULL
          AND threads.archived_at IS NULL
          ${unsettledThreadsFilter(request.unsettledOnly)}
        ORDER BY sessions.thread_id ASC
      `,
  });

  const listArchivedThreadSessionRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadSessionDbRowSchema,
    execute: () =>
      sql`
        SELECT
          sessions.thread_id AS "threadId",
          sessions.status,
          sessions.provider_name AS "providerName",
          sessions.provider_instance_id AS "providerInstanceId",
          sessions.provider_session_id AS "providerSessionId",
          sessions.provider_thread_id AS "providerThreadId",
          sessions.runtime_mode AS "runtimeMode",
          sessions.active_turn_id AS "activeTurnId",
          sessions.last_error AS "lastError",
          sessions.updated_at AS "updatedAt"
        FROM projection_thread_sessions sessions
        INNER JOIN projection_threads threads
          ON threads.thread_id = sessions.thread_id
        WHERE threads.deleted_at IS NULL
          AND threads.archived_at IS NOT NULL
        ORDER BY sessions.thread_id ASC
      `,
  });

  const listCheckpointRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionCheckpointDbRowSchema,
    execute: () =>
      sql`
        SELECT
          thread_id AS "threadId",
          turn_id AS "turnId",
          checkpoint_turn_count AS "checkpointTurnCount",
          checkpoint_ref AS "checkpointRef",
          checkpoint_status AS "status",
          checkpoint_files_json AS "files",
          assistant_message_id AS "assistantMessageId",
          completed_at AS "completedAt"
        FROM projection_turns
        WHERE checkpoint_turn_count IS NOT NULL
        ORDER BY thread_id ASC, checkpoint_turn_count ASC
      `,
  });

  const listLatestTurnRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionLatestTurnDbRowSchema,
    execute: () =>
      sql`
        SELECT
          turns.thread_id AS "threadId",
          turns.turn_id AS "turnId",
          turns.state,
          turns.requested_at AS "requestedAt",
          turns.started_at AS "startedAt",
          turns.completed_at AS "completedAt",
          turns.assistant_message_id AS "assistantMessageId",
          turns.source_proposed_plan_thread_id AS "sourceProposedPlanThreadId",
          turns.source_proposed_plan_id AS "sourceProposedPlanId"
        FROM projection_threads threads
        JOIN projection_turns turns
          ON turns.thread_id = threads.thread_id
          AND turns.turn_id = threads.latest_turn_id
        WHERE threads.latest_turn_id IS NOT NULL
        ORDER BY turns.thread_id ASC
      `,
  });

  const listActiveLatestTurnRows = SqlSchema.findAll({
    Request: ActiveThreadRowsRequest,
    Result: ProjectionLatestTurnDbRowSchema,
    execute: (request) =>
      sql`
        SELECT
          turns.thread_id AS "threadId",
          turns.turn_id AS "turnId",
          turns.state,
          turns.requested_at AS "requestedAt",
          turns.started_at AS "startedAt",
          turns.completed_at AS "completedAt",
          turns.assistant_message_id AS "assistantMessageId",
          turns.source_proposed_plan_thread_id AS "sourceProposedPlanThreadId",
          turns.source_proposed_plan_id AS "sourceProposedPlanId"
        FROM projection_threads threads
        JOIN projection_turns turns
          ON turns.thread_id = threads.thread_id
          AND turns.turn_id = threads.latest_turn_id
        WHERE threads.deleted_at IS NULL
          AND threads.archived_at IS NULL
          AND threads.latest_turn_id IS NOT NULL
          ${unsettledThreadsFilter(request.unsettledOnly)}
        ORDER BY turns.thread_id ASC
      `,
  });

  const listArchivedLatestTurnRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionLatestTurnDbRowSchema,
    execute: () =>
      sql`
        SELECT
          turns.thread_id AS "threadId",
          turns.turn_id AS "turnId",
          turns.state,
          turns.requested_at AS "requestedAt",
          turns.started_at AS "startedAt",
          turns.completed_at AS "completedAt",
          turns.assistant_message_id AS "assistantMessageId",
          turns.source_proposed_plan_thread_id AS "sourceProposedPlanThreadId",
          turns.source_proposed_plan_id AS "sourceProposedPlanId"
        FROM projection_threads threads
        JOIN projection_turns turns
          ON turns.thread_id = threads.thread_id
          AND turns.turn_id = threads.latest_turn_id
        WHERE threads.deleted_at IS NULL
          AND threads.archived_at IS NOT NULL
          AND threads.latest_turn_id IS NOT NULL
        ORDER BY turns.thread_id ASC
      `,
  });

  const listProjectionStateRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionStateDbRowSchema,
    execute: () =>
      sql`
        SELECT
          projector,
          last_applied_sequence AS "lastAppliedSequence",
          updated_at AS "updatedAt"
        FROM projection_state
      `,
  });

  const readProjectionCounts = SqlSchema.findOne({
    Request: Schema.Void,
    Result: ProjectionCountsRowSchema,
    execute: () =>
      sql`
        SELECT
          (SELECT COUNT(*) FROM projection_projects) AS "projectCount",
          (SELECT COUNT(*) FROM projection_threads) AS "threadCount"
      `,
  });

  const readEventReplayStats = SqlSchema.findOne({
    Request: EventReplayStatsInput,
    Result: EventReplayStatsRowSchema,
    execute: ({ fromSequenceExclusive, toSequenceInclusive }) =>
      sql`
        SELECT
          COUNT(*) AS "eventCount",
          COALESCE(SUM(octet_length(payload_json)), 0) AS "payloadBytes"
        FROM orchestration_events
        WHERE sequence > ${fromSequenceExclusive}
          AND sequence <= ${toSequenceInclusive}
      `,
  });

  const searchActiveThreadRows = SqlSchema.findAll({
    Request: ProjectionThreadSearchRequest,
    Result: ProjectionThreadSearchRow,
    execute: ({ pattern, limit }) =>
      sql`
        WITH ranked AS (
          SELECT
            threads.thread_id AS thread_id,
            threads.project_id AS project_id,
            CASE messages.role
              WHEN 'user' THEN 'user'
              ELSE 'assistant'
            END AS source,
            messages.text AS match_text,
            messages.created_at AS message_created_at,
            CASE messages.role
              WHEN 'user' THEN 0
              ELSE 1
            END AS match_rank,
            threads.updated_at AS thread_updated_at,
            ROW_NUMBER() OVER (
              PARTITION BY threads.thread_id
              ORDER BY
                CASE messages.role
                  WHEN 'user' THEN 0
                  ELSE 1
                END ASC,
                messages.created_at DESC,
                messages.message_id ASC
            ) AS thread_match_rank
          FROM projection_thread_messages AS messages
          INNER JOIN projection_threads AS threads
            ON threads.thread_id = messages.thread_id
          INNER JOIN projection_projects AS projects
            ON projects.project_id = threads.project_id
          WHERE threads.deleted_at IS NULL
            AND threads.archived_at IS NULL
            AND projects.deleted_at IS NULL
            AND messages.is_streaming = 0
            -- Only these two roles are searchable, and the CASE above depends
            -- on it: reasoning is deliberately excluded so a thinking trace
            -- cannot surface in the command palette, and widening this filter
            -- would label it 'assistant' rather than adding a source.
            AND (
              messages.role = 'user'
              OR (
                messages.role = 'assistant'
                AND messages.message_id IN (
                  SELECT turns.assistant_message_id
                  FROM projection_turns AS turns
                  WHERE turns.assistant_message_id IS NOT NULL
                )
              )
            )
            AND messages.text LIKE ${pattern} ESCAPE '!'
        )
        SELECT
          thread_id AS "threadId",
          project_id AS "projectId",
          source,
          match_text AS "matchText",
          message_created_at AS "messageCreatedAt"
        FROM ranked
        WHERE thread_match_rank = 1
        ORDER BY
          match_rank ASC,
          thread_updated_at DESC,
          thread_id ASC
        LIMIT ${limit}
      `,
  });

  const getActiveProjectRowByWorkspaceRoot = SqlSchema.findOneOption({
    Request: WorkspaceRootLookupInput,
    Result: ProjectionProjectLookupRowSchema,
    execute: ({ workspaceRoot }) =>
      sql`
        SELECT
          project_id AS "projectId",
          title,
          workspace_root AS "workspaceRoot",
          default_model_selection_json AS "defaultModelSelection",
          default_thread_env_mode AS "defaultThreadEnvMode",
          auto_pull AS "autoPull",
          favicon_path AS "faviconPath",
          project_icon_json AS "projectIcon",
          scripts_json AS "scripts",
          owner_user_id AS "ownerUserId", -- T3-CUSTOM(expbkt3): team mode project ownership.
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          deleted_at AS "deletedAt"
        FROM projection_projects
        WHERE workspace_root = ${workspaceRoot}
          AND deleted_at IS NULL
        ORDER BY created_at ASC, project_id ASC
        LIMIT 1
      `,
  });

  const getActiveProjectRowById = SqlSchema.findOneOption({
    Request: ProjectIdLookupInput,
    Result: ProjectionProjectLookupRowSchema,
    execute: ({ projectId }) =>
      sql`
        SELECT
          project_id AS "projectId",
          title,
          workspace_root AS "workspaceRoot",
          default_model_selection_json AS "defaultModelSelection",
          default_thread_env_mode AS "defaultThreadEnvMode",
          auto_pull AS "autoPull",
          favicon_path AS "faviconPath",
          project_icon_json AS "projectIcon",
          scripts_json AS "scripts",
          owner_user_id AS "ownerUserId", -- T3-CUSTOM(expbkt3): team mode project ownership.
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          deleted_at AS "deletedAt"
        FROM projection_projects
        WHERE project_id = ${projectId}
          AND deleted_at IS NULL
        LIMIT 1
      `,
  });

  const getFirstActiveThreadIdByProject = SqlSchema.findOneOption({
    Request: ProjectIdLookupInput,
    Result: ProjectionThreadIdLookupRowSchema,
    execute: ({ projectId }) =>
      sql`
        SELECT
          thread_id AS "threadId"
        FROM projection_threads
        WHERE project_id = ${projectId}
          AND deleted_at IS NULL
          AND archived_at IS NULL
        ORDER BY created_at ASC, thread_id ASC
        LIMIT 1
      `,
  });

  const listImportedAgentSessionSourceRows = SqlSchema.findAll({
    Request: ProjectIdLookupInput,
    Result: ProjectionImportedAgentSessionSourcesRowSchema,
    execute: ({ projectId }) =>
      sql`
        SELECT
          threads.thread_id AS "threadId",
          runtime.runtime_payload_json AS "runtimePayload"
        FROM projection_threads AS threads
        INNER JOIN projection_projects AS projects
          ON projects.project_id = threads.project_id
        INNER JOIN provider_session_runtime AS runtime
          ON runtime.thread_id = threads.thread_id
        WHERE threads.project_id = ${projectId}
          AND threads.deleted_at IS NULL
          AND threads.archived_at IS NULL
          AND projects.deleted_at IS NULL
          AND EXISTS (
            SELECT 1
            FROM projection_thread_messages AS messages
            WHERE messages.thread_id = threads.thread_id
              AND messages.message_id GLOB 'import:*'
          )
        ORDER BY threads.thread_id ASC
      `,
  });

  const getThreadCheckpointContextThreadRow = SqlSchema.findOneOption({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadCheckpointContextThreadRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          threads.thread_id AS "threadId",
          threads.project_id AS "projectId",
          projects.workspace_root AS "workspaceRoot",
          threads.worktree_path AS "worktreePath"
        FROM projection_threads AS threads
        INNER JOIN projection_projects AS projects
          ON projects.project_id = threads.project_id
        WHERE threads.thread_id = ${threadId}
          AND threads.deleted_at IS NULL
        LIMIT 1
      `,
  });

  const getActiveThreadRowById = SqlSchema.findOneOption({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          project_id AS "projectId",
          title,
          title_state_json AS "titleState",
          model_selection_json AS "modelSelection",
          runtime_mode AS "runtimeMode",
          interaction_mode AS "interactionMode",
          branch,
          worktree_path AS "worktreePath",
          source_control_profile_id AS "sourceControlProfileId", -- T3-CUSTOM(expbkt3): source-control identity.
          linked_pull_request_json AS "linkedPullRequest",
          branch_pull_request_json AS "branchPullRequest",
          latest_turn_id AS "latestTurnId",
          owner_user_id AS "ownerUserId", -- T3-CUSTOM(expbkt3): team mode thread ownership.
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          archived_at AS "archivedAt",
          settled_override AS "settledOverride",
          settled_at AS "settledAt",
          unsettled_at AS "unsettledAt",
          snoozed_until AS "snoozedUntil",
          snoozed_at AS "snoozedAt",
          -- T3-CUSTOM(expbkt3): BEGIN — priority, custom sidebar group, Linear/Mattermost
          -- links, and thread lineage (parent thread/environment).
          priority,
          custom_group AS "customGroup", -- T3-CUSTOM(expbkt3): custom sidebar group.
          linear_issue_url AS "linearIssueUrl",
          mattermost_thread_url AS "mattermostThreadUrl",
          parent_thread_id AS "parentThreadId",
          parent_environment_id AS "parentEnvironmentId",
          -- T3-CUSTOM(expbkt3): END
          pinned_at AS "pinnedAt",
          pin_order_key AS "pinOrderKey",
          active_order_key AS "activeOrderKey",
          auto_settle_disabled_at AS "autoSettleDisabledAt",
          title_regeneration_request_id AS "titleRegenerationRequestId",
          title_regeneration_started_at AS "titleRegenerationStartedAt",
          latest_user_message_at AS "latestUserMessageAt",
          pending_approval_count AS "pendingApprovalCount",
          pending_user_input_count AS "pendingUserInputCount",
          -- T3-CUSTOM(expbkt3): async input is visible but never blocking.
          pending_async_user_input_count AS "pendingAsyncUserInputCount",
          has_actionable_proposed_plan AS "hasActionableProposedPlan",
          deleted_at AS "deletedAt"
        FROM projection_threads
        WHERE thread_id = ${threadId}
          AND deleted_at IS NULL
          AND archived_at IS NULL
        LIMIT 1
      `,
  });

  // T3-CUSTOM(expbkt3): BEGIN — team mode: minimal row for authorizing a thread by
  // owner/project membership.
  // Deliberately not filtered on `archived_at`: authorization must still resolve
  // for an archived thread so its owner can unarchive/delete/retag it.
  const getThreadAccessRowById = SqlSchema.findOneOption({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadAccessRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          project_id AS "projectId",
          owner_user_id AS "ownerUserId"
        FROM projection_threads
        WHERE thread_id = ${threadId}
          AND deleted_at IS NULL
        LIMIT 1
      `,
  });
  // T3-CUSTOM(expbkt3): END

  // T3-CUSTOM(expbkt3): Keep the bounded project-thread query aligned with
  // upstream's shell schema additions.
  const listActiveThreadRowsByProjectId = SqlSchema.findAll({
    Request: Schema.Struct({ projectId: ProjectId }),
    Result: ProjectionThreadDbRowSchema,
    execute: ({ projectId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          project_id AS "projectId",
          title,
          model_selection_json AS "modelSelection",
          title_state_json AS "titleState",
          runtime_mode AS "runtimeMode",
          interaction_mode AS "interactionMode",
          branch,
          worktree_path AS "worktreePath",
          source_control_profile_id AS "sourceControlProfileId", -- T3-CUSTOM(expbkt3): source-control identity.
          linked_pull_request_json AS "linkedPullRequest",
          branch_pull_request_json AS "branchPullRequest",
          latest_turn_id AS "latestTurnId",
          owner_user_id AS "ownerUserId", -- T3-CUSTOM(expbkt3): team mode thread ownership.
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          archived_at AS "archivedAt",
          settled_override AS "settledOverride",
          settled_at AS "settledAt",
          unsettled_at AS "unsettledAt",
          snoozed_until AS "snoozedUntil",
          snoozed_at AS "snoozedAt",
          -- T3-CUSTOM(expbkt3): BEGIN — priority, custom sidebar group, Linear/Mattermost
          -- links, and thread lineage (parent thread/environment).
          priority,
          custom_group AS "customGroup", -- T3-CUSTOM(expbkt3): custom sidebar group.
          linear_issue_url AS "linearIssueUrl",
          mattermost_thread_url AS "mattermostThreadUrl",
          parent_thread_id AS "parentThreadId",
          parent_environment_id AS "parentEnvironmentId",
          -- T3-CUSTOM(expbkt3): END
          pinned_at AS "pinnedAt",
          pin_order_key AS "pinOrderKey",
          active_order_key AS "activeOrderKey",
          auto_settle_disabled_at AS "autoSettleDisabledAt",
          title_regeneration_request_id AS "titleRegenerationRequestId",
          title_regeneration_started_at AS "titleRegenerationStartedAt",
          latest_user_message_at AS "latestUserMessageAt",
          pending_approval_count AS "pendingApprovalCount",
          pending_user_input_count AS "pendingUserInputCount",
          -- T3-CUSTOM(expbkt3): async input is visible but never blocking.
          pending_async_user_input_count AS "pendingAsyncUserInputCount",
          has_actionable_proposed_plan AS "hasActionableProposedPlan",
          deleted_at AS "deletedAt"
        FROM projection_threads
        WHERE project_id = ${projectId}
          AND deleted_at IS NULL
          AND archived_at IS NULL
        ORDER BY created_at ASC, thread_id ASC
      `,
  });

  const getThreadRuntimeContextRow = SqlSchema.findOneOption({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadRuntimeContextDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          threads.thread_id AS id,
          threads.project_id AS "projectId",
          threads.title,
          threads.title_state_json AS "titleState",
          sessions.thread_id AS "threadId",
          sessions.status,
          sessions.provider_name AS "providerName",
          sessions.provider_instance_id AS "providerInstanceId",
          -- T3-CUSTOM(expbkt3): runtime contexts retain durable provider conversation identity.
          sessions.provider_thread_id AS "providerThreadId",
          sessions.runtime_mode AS "runtimeMode",
          sessions.active_turn_id AS "activeTurnId",
          sessions.last_error AS "lastError",
          sessions.updated_at AS "updatedAt"
        FROM projection_threads AS threads
        LEFT JOIN projection_thread_sessions AS sessions
          ON sessions.thread_id = threads.thread_id
        WHERE threads.thread_id = ${threadId}
          AND threads.deleted_at IS NULL
          AND threads.archived_at IS NULL
        LIMIT 1
      `.pipe(
        Effect.map((rows) =>
          rows.map((row) => ({
            id: row.id,
            projectId: row.projectId,
            title: row.title,
            titleState: row.titleState,
            session: row.threadId === null ? null : row,
          })),
        ),
      ),
  });

  const getTurnStartMessageRow = SqlSchema.findOneOption({
    Request: TurnStartMessageLookupInput,
    Result: ProjectionTurnStartMessageDbRowSchema,
    execute: ({ threadId, messageId }) => sql`
      SELECT
        message_id AS "messageId",
        thread_id AS "threadId",
        turn_id AS "turnId",
        role,
        text,
        attachments_json AS "attachments",
        context_json AS "context",
        is_streaming AS "isStreaming",
        -- T3-CUSTOM(expbkt3): this fork's ProjectionThreadMessage requires
        -- sentByUserId, so every query decoding ProjectionThreadMessageDbRowSchema
        -- must select it. Keep in sync with listThreadMessageRowsByThread.
        sent_by_user_id AS "sentByUserId",
        created_at AS "createdAt",
        updated_at AS "updatedAt",
        EXISTS (
          SELECT 1
          FROM projection_thread_messages AS other
          WHERE other.thread_id = ${threadId}
            AND other.message_id != ${messageId}
            AND other.role = 'user'
            AND (
              LOWER(TRIM(other.text, ${MESSAGE_TRIM_WHITESPACE})) != '/compact'
              OR COALESCE(json_array_length(other.attachments_json), 0) > 0
            )
        ) AS "hasOtherUserMessages"
      FROM projection_thread_messages
      WHERE thread_id = ${threadId} AND message_id = ${messageId}
      LIMIT 1
    `,
  });

  // T3-CUSTOM(expbkt3): BEGIN — prompt count for the title refresh cadence.
  // Keep the compaction predicate in sync with getTurnStartMessageRow.
  const countThreadUserMessagesRow = SqlSchema.findOne({
    Request: ThreadIdLookupInput,
    Result: Schema.Struct({ count: Schema.Number }),
    execute: ({ threadId }) => sql`
      SELECT COUNT(*) AS "count"
      FROM projection_thread_messages
      WHERE thread_id = ${threadId}
        AND role = 'user'
        AND (
          LOWER(TRIM(text, ${MESSAGE_TRIM_WHITESPACE})) != '/compact'
          OR COALESCE(json_array_length(attachments_json), 0) > 0
        )
    `,
  });
  // T3-CUSTOM(expbkt3): END

  const listThreadMessageRowsByThread = SqlSchema.findAll({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadMessageDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          message_id AS "messageId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          role,
          text,
          attachments_json AS "attachments",
          context_json AS "context",
          is_streaming AS "isStreaming",
          sent_by_user_id AS "sentByUserId", -- T3-CUSTOM(expbkt3): team mode message attribution.
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_thread_messages
        WHERE thread_id = ${threadId}
        ORDER BY created_at ASC, message_id ASC
      `,
  });

  const listThreadProposedPlanRowsByThread = SqlSchema.findAll({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadProposedPlanDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          plan_id AS "planId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          plan_markdown AS "planMarkdown",
          implemented_at AS "implementedAt",
          implementation_thread_id AS "implementationThreadId",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_thread_proposed_plans
        WHERE thread_id = ${threadId}
        ORDER BY created_at ASC, plan_id ASC
      `,
  });

  const listThreadPullRequestRowsByThread = SqlSchema.findAll({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadPullRequestDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          host,
          repository,
          number,
          url,
          source,
          linked_at AS "linkedAt",
          snapshot_json AS "snapshot",
          stack_json AS "stack"
        FROM projection_thread_pull_requests
        WHERE thread_id = ${threadId}
        ORDER BY linked_at ASC, number ASC
      `,
  });

  const listThreadActivityRowsByThread = SqlSchema.findAll({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadActivityDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          activity_id AS "activityId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          tone,
          kind,
          summary,
          payload_json AS "payload",
          sequence,
          created_at AS "createdAt"
        FROM (
          SELECT
            activity_id,
            thread_id,
            turn_id,
            tone,
            kind,
            summary,
            payload_json,
            sequence,
            created_at
          FROM projection_thread_activities
          WHERE thread_id = ${threadId}
          ORDER BY
            sequence DESC,
            created_at DESC,
            activity_id DESC
          LIMIT ${THREAD_DETAIL_ACTIVITY_LIMIT}
        ) AS recent_activities
        ORDER BY
          sequence ASC,
          created_at ASC,
          activity_id ASC
      `,
  });

  const getUserInputActivityRow = SqlSchema.findOneOption({
    Request: Schema.Struct({ threadId: ThreadId, requestId: ApprovalRequestId }),
    Result: ProjectionThreadActivityDbRowSchema,
    execute: ({ threadId, requestId }) => sql`
      SELECT
        activity_id AS "activityId",
        thread_id AS "threadId",
        turn_id AS "turnId",
        tone,
        kind,
        summary,
        payload_json AS "payload",
        sequence,
        created_at AS "createdAt"
      FROM projection_thread_activities
      WHERE thread_id = ${threadId}
        AND kind IN ('user-input.requested', 'user-input.resolved')
        AND json_extract(payload_json, '$.requestId') = ${requestId}
      ORDER BY sequence DESC, created_at DESC, activity_id DESC
      LIMIT 1
    `,
  });

  const getUserInputActivity: ProjectionSnapshotQueryShape["getUserInputActivity"] = (input) =>
    getUserInputActivityRow(input).pipe(
      Effect.map(Option.map(mapThreadActivityRow)),
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionSnapshotQuery.getUserInputActivity:query",
          "ProjectionSnapshotQuery.getUserInputActivity:decodeRow",
        ),
      ),
    );

  const listActivityRowsByKind = SqlSchema.findAll({
    Request: Schema.Struct({ kind: Schema.String }),
    Result: ProjectionThreadActivityDbRowSchema,
    execute: ({ kind }) => sql`
      SELECT
        a.activity_id AS "activityId",
        a.thread_id AS "threadId",
        a.turn_id AS "turnId",
        a.tone,
        a.kind,
        a.summary,
        a.payload_json AS "payload",
        a.sequence,
        a.created_at AS "createdAt"
      FROM projection_thread_activities a
      JOIN projection_threads t ON t.thread_id = a.thread_id
      WHERE a.kind = ${kind}
        AND t.deleted_at IS NULL
        AND t.archived_at IS NULL
      ORDER BY a.created_at ASC, a.activity_id ASC
    `,
  });

  const listActivitiesByKind: ProjectionSnapshotQueryShape["listActivitiesByKind"] = (kind) =>
    listActivityRowsByKind({ kind }).pipe(
      Effect.map((rows) => rows.map(mapThreadActivityRow)),
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionSnapshotQuery.listActivitiesByKind:query",
          "ProjectionSnapshotQuery.listActivitiesByKind:decodeRow",
        ),
      ),
    );

  const listThreadActivityIdsByThread = SqlSchema.findAll({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadActivityIdRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT activity_id AS "activityId"
        FROM projection_thread_activities
        WHERE thread_id = ${threadId}
        ORDER BY
          sequence DESC,
          created_at DESC,
          activity_id DESC
        LIMIT ${THREAD_DETAIL_ACTIVITY_LIMIT}
      `,
  });

  const listThreadActivityRowsByIds = SqlSchema.findAll({
    Request: ThreadActivityIdsLookupInput,
    Result: ProjectionThreadActivityDbRowSchema,
    execute: ({ activityIds }) =>
      sql`
        SELECT
          activity_id AS "activityId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          tone,
          kind,
          summary,
          payload_json AS "payload",
          sequence,
          created_at AS "createdAt"
        FROM projection_thread_activities
        -- The selectors already scoped these globally unique ids to the
        -- thread inside this transaction. Keep this as a primary-key lookup.
        WHERE ${sql.in("activity_id", activityIds)}
      `,
  });

  const listThreadActivityRowsByThreadAndKinds = SqlSchema.findAll({
    Request: ThreadActivityKindsLookupInput,
    Result: ProjectionThreadActivityDbRowSchema,
    execute: ({ threadId, activityKinds }) =>
      sql`
        SELECT
          activity_id AS "activityId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          tone,
          kind,
          summary,
          payload_json AS "payload",
          sequence,
          created_at AS "createdAt"
        FROM (
          SELECT
            activity_id,
            thread_id,
            turn_id,
            tone,
            kind,
            summary,
            payload_json,
            sequence,
            created_at
          FROM projection_thread_activities
          WHERE thread_id = ${threadId}
            AND ${sql.in("kind", activityKinds)}
          ORDER BY
            sequence DESC,
            created_at DESC,
            activity_id DESC
          LIMIT ${THREAD_DETAIL_ACTIVITY_LIMIT}
        ) AS recent_activities
        ORDER BY
          sequence ASC,
          created_at ASC,
          activity_id ASC
      `,
  });

  const getThreadSessionRowByThread = SqlSchema.findOneOption({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadSessionDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          status,
          provider_name AS "providerName",
          provider_instance_id AS "providerInstanceId",
          provider_thread_id AS "providerThreadId", -- T3-CUSTOM(expbkt3): surfaced on the session row for the shell.
          runtime_mode AS "runtimeMode",
          active_turn_id AS "activeTurnId",
          last_error AS "lastError",
          updated_at AS "updatedAt"
        FROM projection_thread_sessions
        WHERE thread_id = ${threadId}
        LIMIT 1
      `,
  });

  const getLatestTurnRowByThread = SqlSchema.findOneOption({
    Request: ThreadIdLookupInput,
    Result: ProjectionLatestTurnDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          turns.thread_id AS "threadId",
          turns.turn_id AS "turnId",
          turns.state,
          turns.requested_at AS "requestedAt",
          turns.started_at AS "startedAt",
          turns.completed_at AS "completedAt",
          turns.assistant_message_id AS "assistantMessageId",
          turns.source_proposed_plan_thread_id AS "sourceProposedPlanThreadId",
          turns.source_proposed_plan_id AS "sourceProposedPlanId"
        FROM projection_threads threads
        JOIN projection_turns turns
          ON turns.thread_id = threads.thread_id
          AND turns.turn_id = threads.latest_turn_id
        WHERE threads.thread_id = ${threadId}
          AND threads.deleted_at IS NULL
          AND threads.archived_at IS NULL
        LIMIT 1
      `,
  });

  // T3-CUSTOM(expbkt3): Bound plan-review startup ingest to one newest active plan per thread.
  const listLatestProposedPlanRowsForActiveThreads = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadProposedPlanDbRowSchema,
    execute: () =>
      sql`
        SELECT
          plans.plan_id AS "planId",
          plans.thread_id AS "threadId",
          plans.turn_id AS "turnId",
          plans.plan_markdown AS "planMarkdown",
          plans.implemented_at AS "implementedAt",
          plans.implementation_thread_id AS "implementationThreadId",
          plans.created_at AS "createdAt",
          plans.updated_at AS "updatedAt"
        FROM projection_thread_proposed_plans AS plans
        INNER JOIN projection_threads AS threads
          ON threads.thread_id = plans.thread_id
        WHERE threads.deleted_at IS NULL
          AND threads.archived_at IS NULL
          AND plans.plan_id = (
            SELECT latest.plan_id
            FROM projection_thread_proposed_plans AS latest
            WHERE latest.thread_id = plans.thread_id
            ORDER BY latest.updated_at DESC, latest.plan_id DESC
            LIMIT 1
          )
          AND plans.implemented_at IS NULL
        ORDER BY plans.thread_id ASC
      `,
  });

  const listCheckpointRowsByThread = SqlSchema.findAll({
    Request: ThreadIdLookupInput,
    Result: ProjectionCheckpointDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          turn_id AS "turnId",
          checkpoint_turn_count AS "checkpointTurnCount",
          checkpoint_ref AS "checkpointRef",
          checkpoint_status AS "status",
          checkpoint_files_json AS "files",
          assistant_message_id AS "assistantMessageId",
          completed_at AS "completedAt"
        FROM projection_turns
        WHERE thread_id = ${threadId}
          AND checkpoint_turn_count IS NOT NULL
        ORDER BY checkpoint_turn_count ASC
      `,
  });

  // Resolves a page of recent turns for a windowed thread detail read. Walks
  // back from the exclusive (beforeAnchorAt, beforeTurnKey) keyset boundary
  // (sentinels "~"/"" mean unbounded, i.e. the first page) until it has seen
  // `userTurnLimit` user-anchored turns — turns whose pending message is a
  // user message; subagent/fan-out turns between them ride along — or hits the
  // `maxRawTurns` ceiling that bounds pathological fan-out. The `candidates`
  // CTE applies the keyset bound and LIMIT before the window functions run;
  // its ORDER BY uses raw columns so the migration-037
  // (thread_id, requested_at, turn_id) index serves both range and order with
  // no temp B-tree — the scan is genuinely bounded by the LIMIT. (Raw
  // turn_id DESC places NULLs exactly where COALESCE-to-'' would, below every
  // real id.) The caller derives the continuation cursor from the oldest
  // returned row.
  // Highest thread-DETAIL event sequence for this thread that the projection
  // has applied (bounded by the global snapshot sequence read in the same
  // transaction). This is the thread-scoped watermark a windowed page carries
  // so clients can defer merging until their live subscription has caught up;
  // the global sequence is not waitable per-thread. The event_type filter
  // must match ws.ts's isThreadDetailEvent exactly: the subscription only
  // delivers these types, so a watermark counting any other event could
  // never be reached by the client and would park the page forever. Served
  // by the event store's (aggregate_kind, stream_id, sequence) index.
  const getThreadEventWatermarkRow = SqlSchema.findOneOption({
    Request: Schema.Struct({ threadId: ThreadId, maxSequence: Schema.Number }),
    Result: Schema.Struct({ threadSequence: Schema.NullOr(Schema.Number) }),
    execute: ({ threadId, maxSequence }) =>
      sql`
        SELECT MAX(sequence) AS "threadSequence"
        FROM orchestration_events
        WHERE aggregate_kind = 'thread'
          AND stream_id = ${threadId}
          AND sequence <= ${maxSequence}
          AND event_type IN (
            'thread.message-sent',
            'thread.proposed-plan-upserted',
            'thread.activity-appended',
            'thread.turn-diff-completed',
            'thread.reverted',
            'thread.session-set'
          )
      `,
  });

  const listTurnWindowRows = SqlSchema.findAll({
    Request: ThreadTurnWindowLookupInput,
    Result: ProjectionTurnWindowRowSchema,
    execute: ({ threadId, beforeAnchorAt, beforeTurnKey, userTurnLimit, maxRawTurns }) =>
      sql`
        WITH candidates AS (
          SELECT
            turns.requested_at AS anchor_at,
            COALESCE(turns.turn_id, '') AS turn_key,
            turns.pending_message_id
          FROM projection_turns AS turns
          WHERE turns.thread_id = ${threadId}
            AND (
              turns.requested_at < ${beforeAnchorAt}
              OR (
                turns.requested_at = ${beforeAnchorAt}
                AND COALESCE(turns.turn_id, '') < ${beforeTurnKey}
              )
            )
          ORDER BY turns.requested_at DESC, turns.turn_id DESC
          LIMIT ${maxRawTurns}
        ),
        walked AS (
          SELECT
            candidates.anchor_at,
            candidates.turn_key,
            CASE WHEN messages.role = 'user' THEN 1 ELSE 0 END AS is_user_turn,
            SUM(CASE WHEN messages.role = 'user' THEN 1 ELSE 0 END) OVER (
              ORDER BY candidates.anchor_at DESC, candidates.turn_key DESC
            ) AS user_turns_seen
          FROM candidates
          LEFT JOIN projection_thread_messages AS messages
            ON messages.message_id = candidates.pending_message_id
        )
        SELECT
          anchor_at AS "anchorAt",
          turn_key AS "turnKey"
        FROM walked
        WHERE user_turns_seen < ${userTurnLimit}
          OR (user_turns_seen = ${userTurnLimit} AND is_user_turn = 1)
        ORDER BY anchor_at ASC, turn_key ASC
      `,
  });

  // Windowed variants of the two heavy collections. Turn-linked rows are
  // bounded by the page's (anchor, turn key) keyset range over
  // projection_turns; rows with no turn linkage (user messages always, and
  // turnless activities like pre-turn context-window updates) are bounded by
  // the matching turn-anchor time range so they land on the same page as the
  // turns around them. Proposed plans and checkpoints stay unwindowed: they
  // are metadata-scale.
  const listThreadMessageRowsByThreadWindow = SqlSchema.findAll({
    Request: ThreadTurnRangeLookupInput,
    Result: ProjectionThreadMessageDbRowSchema,
    execute: ({ threadId, minAnchorAt, minTurnKey, beforeAnchorAt, beforeTurnKey }) =>
      sql`
        SELECT
          message_id AS "messageId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          role,
          text,
          attachments_json AS "attachments",
          context_json AS "context",
          is_streaming AS "isStreaming",
          -- T3-CUSTOM(expbkt3): BEGIN
          -- This fork's ProjectionThreadMessage requires sentByUserId, so every
          -- query decoding ProjectionThreadMessageDbRowSchema must select it —
          -- including upstream's windowed variants. Keep in sync with
          -- listThreadMessageRowsByThread.
          sent_by_user_id AS "sentByUserId",
          -- T3-CUSTOM(expbkt3): END
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_thread_messages
        WHERE thread_id = ${threadId}
          AND (
            turn_id IN (
              SELECT turn_id FROM projection_turns
              WHERE thread_id = ${threadId}
                AND turn_id IS NOT NULL
                AND (
                  requested_at > ${minAnchorAt}
                  OR (
                    requested_at = ${minAnchorAt}
                    AND turn_id >= ${minTurnKey}
                  )
                )
                AND (
                  requested_at < ${beforeAnchorAt}
                  OR (
                    requested_at = ${beforeAnchorAt}
                    AND turn_id < ${beforeTurnKey}
                  )
                )
            )
            OR (
              turn_id IS NULL
              AND created_at >= ${minAnchorAt}
              AND created_at < ${beforeAnchorAt}
            )
          )
        ORDER BY created_at ASC, message_id ASC
      `,
  });

  const pinnedThreadActivityIdsCte = (threadId: string) => sql`
pending_approval_requests AS (
          SELECT request_id, thread_id
          FROM projection_pending_approvals
          WHERE thread_id = ${threadId}
            AND status = 'pending'
        ),
        pending_approval_activities AS (
          SELECT
            activity.activity_id,
            ROW_NUMBER() OVER (
              PARTITION BY pending.request_id
              ORDER BY activity.created_at DESC, activity.activity_id DESC
            ) AS request_order
          FROM pending_approval_requests AS pending
          CROSS JOIN projection_thread_activities AS activity
          WHERE activity.thread_id = pending.thread_id
            AND activity.kind = 'approval.requested'
            AND json_extract(activity.payload_json, '$.requestId') = pending.request_id
        ),
        pending_user_input_thread AS (
          SELECT thread_id
          FROM projection_threads
          WHERE thread_id = ${threadId}
            AND pending_user_input_count > 0
        ),
        user_input_lifecycle AS (
          SELECT
            activity.activity_id,
            activity.kind,
            ROW_NUMBER() OVER (
              PARTITION BY json_extract(activity.payload_json, '$.requestId')
              ORDER BY activity.created_at DESC, activity.activity_id DESC
            ) AS request_order
          FROM pending_user_input_thread AS pending
          CROSS JOIN projection_thread_activities AS activity
          WHERE activity.thread_id = pending.thread_id
            AND (
              activity.kind IN ('user-input.requested', 'user-input.resolved')
              OR (
                activity.kind = 'provider.user-input.respond.failed'
                AND (
                  lower(COALESCE(json_extract(activity.payload_json, '$.detail'), ''))
                    LIKE '%stale pending user-input request%'
                  OR lower(COALESCE(json_extract(activity.payload_json, '$.detail'), ''))
                    LIKE '%unknown pending user-input request%'
                  OR lower(COALESCE(json_extract(activity.payload_json, '$.detail'), ''))
                    LIKE '%unknown pending user input request%'
                  OR lower(COALESCE(json_extract(activity.payload_json, '$.detail'), ''))
                    LIKE '%unknown pending codex user input request%'
                )
              )
            )
            AND json_extract(activity.payload_json, '$.requestId') IS NOT NULL
        ),
        pinned_activity_ids AS (
          SELECT activity_id
          FROM pending_approval_activities
          WHERE request_order = 1
          UNION ALL
          SELECT activity_id
          FROM user_input_lifecycle
          WHERE request_order = 1
            AND kind = 'user-input.requested'
        )
  `;

  // Blocking request payloads must remain available even if they predate the
  // recent activity window. Each CTE returns at most one unresolved row per
  // request, so the merge below stays bounded by actionable work.
  const listPinnedThreadActivityRowsByThread = SqlSchema.findAll({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadActivityDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        WITH ${pinnedThreadActivityIdsCte(threadId)}
        SELECT
          activity.activity_id AS "activityId",
          activity.thread_id AS "threadId",
          activity.turn_id AS "turnId",
          activity.tone,
          activity.kind,
          activity.summary,
          activity.payload_json AS "payload",
          activity.sequence,
          activity.created_at AS "createdAt"
        FROM pinned_activity_ids AS pinned
        INNER JOIN projection_thread_activities AS activity
          ON activity.activity_id = pinned.activity_id
        ORDER BY activity.created_at ASC, activity.activity_id ASC
      `,
  });

  const listPinnedThreadActivityIdsByThread = SqlSchema.findAll({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadActivityIdRowSchema,
    execute: ({ threadId }) =>
      sql`
        WITH ${pinnedThreadActivityIdsCte(threadId)}
        SELECT activity_id AS "activityId"
        FROM pinned_activity_ids
      `,
  });

  const listThreadActivityRowsByThreadWindow = SqlSchema.findAll({
    Request: ThreadTurnRangeLookupInput,
    Result: ProjectionThreadActivityDbRowSchema,
    execute: ({ threadId, minAnchorAt, minTurnKey, beforeAnchorAt, beforeTurnKey }) =>
      sql`
        SELECT
          activity_id AS "activityId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          tone,
          kind,
          summary,
          payload_json AS "payload",
          sequence,
          created_at AS "createdAt"
        FROM (
          SELECT
            activity_id,
            thread_id,
            turn_id,
            tone,
            kind,
            summary,
            payload_json,
            sequence,
            created_at
          FROM projection_thread_activities
          WHERE thread_id = ${threadId}
            AND (
              turn_id IN (
                SELECT turn_id FROM projection_turns
                WHERE thread_id = ${threadId}
                  AND turn_id IS NOT NULL
                  AND (
                    requested_at > ${minAnchorAt}
                    OR (
                      requested_at = ${minAnchorAt}
                      AND turn_id >= ${minTurnKey}
                    )
                  )
                  AND (
                    requested_at < ${beforeAnchorAt}
                    OR (
                      requested_at = ${beforeAnchorAt}
                      AND turn_id < ${beforeTurnKey}
                    )
                  )
              )
              OR (
                turn_id IS NULL
                AND created_at >= ${minAnchorAt}
                AND created_at < ${beforeAnchorAt}
              )
            )
          ORDER BY
            sequence DESC,
            created_at DESC,
            activity_id DESC
          LIMIT ${THREAD_DETAIL_ACTIVITY_LIMIT}
        ) AS recent_activities
        ORDER BY
          sequence ASC,
          created_at ASC,
          activity_id ASC
      `,
  });

  const listThreadActivityIdsByThreadWindow = SqlSchema.findAll({
    Request: ThreadTurnRangeLookupInput,
    Result: ProjectionThreadActivityIdRowSchema,
    execute: ({ threadId, minAnchorAt, minTurnKey, beforeAnchorAt, beforeTurnKey }) =>
      sql`
        SELECT activity_id AS "activityId"
        FROM projection_thread_activities
        WHERE thread_id = ${threadId}
          AND (
            turn_id IN (
              SELECT turn_id FROM projection_turns
              WHERE thread_id = ${threadId}
                AND turn_id IS NOT NULL
                AND (
                  requested_at > ${minAnchorAt}
                  OR (
                    requested_at = ${minAnchorAt}
                    AND turn_id >= ${minTurnKey}
                  )
                )
                AND (
                  requested_at < ${beforeAnchorAt}
                  OR (
                    requested_at = ${beforeAnchorAt}
                    AND turn_id < ${beforeTurnKey}
                  )
                )
            )
            OR (
              turn_id IS NULL
              AND created_at >= ${minAnchorAt}
              AND created_at < ${beforeAnchorAt}
            )
          )
        ORDER BY
          sequence DESC,
          created_at DESC,
          activity_id DESC
        LIMIT ${THREAD_DETAIL_ACTIVITY_LIMIT}
      `,
  });

  const getFullThreadDiffContextRow = SqlSchema.findOneOption({
    Request: FullThreadDiffContextLookupInput,
    Result: ProjectionFullThreadDiffContextRowSchema,
    execute: ({ threadId, checkpointTurnCount }) =>
      sql`
        SELECT
          threads.thread_id AS "threadId",
          threads.project_id AS "projectId",
          projects.workspace_root AS "workspaceRoot",
          threads.worktree_path AS "worktreePath",
          (
            SELECT MAX(turns.checkpoint_turn_count)
            FROM projection_turns AS turns
            WHERE turns.thread_id = threads.thread_id
              AND turns.checkpoint_turn_count IS NOT NULL
          ) AS "latestCheckpointTurnCount",
          (
            SELECT turns.checkpoint_ref
            FROM projection_turns AS turns
            WHERE turns.thread_id = threads.thread_id
              AND turns.checkpoint_turn_count = ${checkpointTurnCount}
            LIMIT 1
          ) AS "toCheckpointRef"
        FROM projection_threads AS threads
        INNER JOIN projection_projects AS projects
          ON projects.project_id = threads.project_id
        WHERE threads.thread_id = ${threadId}
          AND threads.deleted_at IS NULL
        LIMIT 1
      `,
  });

  const getSnapshot: ProjectionSnapshotQueryShape["getSnapshot"] = () =>
    sql
      .withTransaction(
        Effect.all([
          listProjectRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getSnapshot:listProjects:query",
                "ProjectionSnapshotQuery.getSnapshot:listProjects:decodeRows",
              ),
            ),
          ),
          listThreadRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getSnapshot:listThreads:query",
                "ProjectionSnapshotQuery.getSnapshot:listThreads:decodeRows",
              ),
            ),
          ),
          listThreadMessageRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getSnapshot:listThreadMessages:query",
                "ProjectionSnapshotQuery.getSnapshot:listThreadMessages:decodeRows",
              ),
            ),
          ),
          listThreadProposedPlanRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getSnapshot:listThreadProposedPlans:query",
                "ProjectionSnapshotQuery.getSnapshot:listThreadProposedPlans:decodeRows",
              ),
            ),
          ),
          listThreadPullRequestRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getSnapshot:listThreadPullRequests:query",
                "ProjectionSnapshotQuery.getSnapshot:listThreadPullRequests:decodeRows",
              ),
            ),
          ),
          listThreadActivityRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getSnapshot:listThreadActivities:query",
                "ProjectionSnapshotQuery.getSnapshot:listThreadActivities:decodeRows",
              ),
            ),
          ),
          listThreadSessionRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getSnapshot:listThreadSessions:query",
                "ProjectionSnapshotQuery.getSnapshot:listThreadSessions:decodeRows",
              ),
            ),
          ),
          listCheckpointRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getSnapshot:listCheckpoints:query",
                "ProjectionSnapshotQuery.getSnapshot:listCheckpoints:decodeRows",
              ),
            ),
          ),
          listLatestTurnRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getSnapshot:listLatestTurns:query",
                "ProjectionSnapshotQuery.getSnapshot:listLatestTurns:decodeRows",
              ),
            ),
          ),
          // T3-CUSTOM(expbkt3): BEGIN — team mode: hydrate thread/project membership
          // alongside everything else the startup snapshot loads.
          listThreadMemberRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getSnapshot:listThreadMembers:query",
                "ProjectionSnapshotQuery.getSnapshot:listThreadMembers:decodeRows",
              ),
            ),
          ),
          listProjectMemberRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getSnapshot:listProjectMembers:query",
                "ProjectionSnapshotQuery.getSnapshot:listProjectMembers:decodeRows",
              ),
            ),
          ),
          // T3-CUSTOM(expbkt3): END
          listProjectionStateRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getSnapshot:listProjectionState:query",
                "ProjectionSnapshotQuery.getSnapshot:listProjectionState:decodeRows",
              ),
            ),
          ),
        ]),
      )
      .pipe(
        Effect.flatMap(
          ([
            projectRows,
            threadRows,
            messageRows,
            proposedPlanRows,
            pullRequestRows,
            activityRows,
            sessionRows,
            checkpointRows,
            latestTurnRows,
            // T3-CUSTOM(expbkt3): team mode membership rows.
            threadMemberRows,
            projectMemberRows,
            stateRows,
          ]) =>
            Effect.gen(function* () {
              const messagesByThread = new Map<string, Array<OrchestrationMessage>>();
              const proposedPlansByThread = new Map<string, Array<OrchestrationProposedPlan>>();
              const pullRequestsByThread = groupPullRequestRowsByThread(pullRequestRows);
              const activitiesByThread = new Map<string, Array<OrchestrationThreadActivity>>();
              const checkpointsByThread = new Map<string, Array<OrchestrationCheckpointSummary>>();
              const sessionsByThread = new Map<string, OrchestrationSession>();
              const latestTurnByThread = new Map<string, OrchestrationLatestTurn>();
              // T3-CUSTOM(expbkt3): team mode membership grouping.
              const memberUserIdsByThread = groupThreadMemberIds(threadMemberRows);
              const memberUserIdsByProject = groupProjectMemberIds(projectMemberRows);

              let updatedAt: string | null = null;

              for (const row of projectRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }
              for (const row of threadRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }
              for (const row of stateRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }

              for (const row of messageRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
                const threadMessages = messagesByThread.get(row.threadId) ?? [];
                threadMessages.push({
                  id: row.messageId,
                  role: row.role,
                  text: row.text,
                  ...(row.attachments !== null ? { attachments: row.attachments } : {}),
                  ...(row.context !== null ? { context: row.context } : {}),
                  turnId: row.turnId,
                  streaming: row.isStreaming === 1,
                  sentByUserId: row.sentByUserId, // T3-CUSTOM(expbkt3): message sender attribution.
                  createdAt: row.createdAt,
                  updatedAt: row.updatedAt,
                });
                messagesByThread.set(row.threadId, threadMessages);
              }

              for (const row of proposedPlanRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
                const threadProposedPlans = proposedPlansByThread.get(row.threadId) ?? [];
                threadProposedPlans.push({
                  id: row.planId,
                  turnId: row.turnId,
                  planMarkdown: row.planMarkdown,
                  implementedAt: row.implementedAt,
                  implementationThreadId: row.implementationThreadId,
                  createdAt: row.createdAt,
                  updatedAt: row.updatedAt,
                });
                proposedPlansByThread.set(row.threadId, threadProposedPlans);
              }

              for (const row of activityRows) {
                updatedAt = maxIso(updatedAt, row.createdAt);
                const threadActivities = activitiesByThread.get(row.threadId) ?? [];
                threadActivities.push({
                  id: row.activityId,
                  tone: row.tone,
                  kind: row.kind,
                  summary: row.summary,
                  payload: row.payload,
                  turnId: row.turnId,
                  ...(row.sequence !== null ? { sequence: row.sequence } : {}),
                  createdAt: row.createdAt,
                });
                activitiesByThread.set(row.threadId, threadActivities);
              }

              for (const row of checkpointRows) {
                updatedAt = maxIso(updatedAt, row.completedAt);
                const threadCheckpoints = checkpointsByThread.get(row.threadId) ?? [];
                threadCheckpoints.push({
                  turnId: row.turnId,
                  checkpointTurnCount: row.checkpointTurnCount,
                  checkpointRef: row.checkpointRef,
                  status: row.status,
                  files: row.files,
                  assistantMessageId: row.assistantMessageId,
                  completedAt: row.completedAt,
                });
                checkpointsByThread.set(row.threadId, threadCheckpoints);
              }

              for (const row of latestTurnRows) {
                updatedAt = maxIso(updatedAt, row.requestedAt);
                if (row.startedAt !== null) {
                  updatedAt = maxIso(updatedAt, row.startedAt);
                }
                if (row.completedAt !== null) {
                  updatedAt = maxIso(updatedAt, row.completedAt);
                }
                if (latestTurnByThread.has(row.threadId)) {
                  continue;
                }
                latestTurnByThread.set(row.threadId, {
                  turnId: row.turnId,
                  state:
                    row.state === "error"
                      ? "error"
                      : row.state === "interrupted"
                        ? "interrupted"
                        : row.state === "completed"
                          ? "completed"
                          : "running",
                  requestedAt: row.requestedAt,
                  startedAt: row.startedAt,
                  completedAt: row.completedAt,
                  assistantMessageId: row.assistantMessageId,
                  durationMs: computeTurnDurationMs(row.startedAt, row.completedAt), // T3-CUSTOM(expbkt3): turn duration shown in the shell.
                  ...(row.sourceProposedPlanThreadId !== null && row.sourceProposedPlanId !== null
                    ? {
                        sourceProposedPlan: {
                          threadId: row.sourceProposedPlanThreadId,
                          planId: row.sourceProposedPlanId,
                        },
                      }
                    : {}),
                });
              }

              for (const row of sessionRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
                sessionsByThread.set(row.threadId, {
                  threadId: row.threadId,
                  status: row.status,
                  providerName: row.providerName,
                  ...(row.providerInstanceId !== null
                    ? { providerInstanceId: row.providerInstanceId }
                    : {}),
                  providerThreadId: row.providerThreadId, // T3-CUSTOM(expbkt3): surfaced on the session row for the shell.
                  runtimeMode: row.runtimeMode,
                  activeTurnId: row.activeTurnId,
                  lastError: row.lastError,
                  updatedAt: row.updatedAt,
                });
              }

              const repositoryIdentities = yield* resolveRepositoryIdentitiesForProjects(
                projectRows,
                { includeDeleted: true },
              );

              const projects: ReadonlyArray<OrchestrationProject> = projectRows.map((row) => ({
                id: row.projectId,
                title: row.title,
                workspaceRoot: row.workspaceRoot,
                repositoryIdentity: repositoryIdentities.get(row.projectId) ?? null,
                defaultModelSelection: row.defaultModelSelection,
                defaultThreadEnvMode: row.defaultThreadEnvMode,
                autoPull: row.autoPull === 1,
                faviconPath: row.faviconPath ?? null,
                projectIcon: row.projectIcon ?? null,
                scripts: row.scripts,
                // T3-CUSTOM(expbkt3): team mode project ownership/membership.
                ownerUserId: row.ownerUserId,
                memberUserIds: memberUserIdsByProject.get(row.projectId) ?? [],
                createdAt: row.createdAt,
                updatedAt: row.updatedAt,
                deletedAt: row.deletedAt,
              }));

              const threads: ReadonlyArray<OrchestrationThread> = threadRows.map((row) => ({
                id: row.threadId,
                projectId: row.projectId,
                title: row.title,
                modelSelection: row.modelSelection,
                runtimeMode: row.runtimeMode,
                interactionMode: row.interactionMode,
                branch: row.branch,
                worktreePath: row.worktreePath,
                sourceControlProfileId: row.sourceControlProfileId, // T3-CUSTOM(expbkt3): source-control identity.
                ...mapThreadPullRequests(
                  pullRequestsByThread.get(row.threadId) ?? [],
                  row.projectId,
                  repositoryIdentities.get(row.projectId),
                ),
                branchPullRequest: row.branchPullRequest,
                latestTurn: latestTurnByThread.get(row.threadId) ?? null,
                // T3-CUSTOM(expbkt3): team mode thread ownership/membership.
                ownerUserId: row.ownerUserId,
                memberUserIds: memberUserIdsByThread.get(row.threadId) ?? [],
                createdAt: row.createdAt,
                updatedAt: row.updatedAt,
                archivedAt: row.archivedAt,
                settledOverride: row.settledOverride,
                settledAt: row.settledAt,
                unsettledAt: row.unsettledAt,
                snoozedUntil: row.snoozedUntil,
                snoozedAt: row.snoozedAt,
                // T3-CUSTOM(expbkt3): BEGIN — priority, custom sidebar group, Linear/Mattermost
                // links, and thread lineage (parent thread/environment).
                priority: row.priority,
                customGroup: row.customGroup ?? null, // T3-CUSTOM(expbkt3): custom sidebar group.
                linearIssueUrl: row.linearIssueUrl ?? null,
                mattermostThreadUrl: row.mattermostThreadUrl ?? null,
                parentThreadId: row.parentThreadId ?? null,
                parentEnvironmentId: row.parentEnvironmentId ?? null,
                // T3-CUSTOM(expbkt3): END
                pinnedAt: row.pinnedAt,
                pinOrderKey: row.pinOrderKey ?? null,
                activeOrderKey: row.activeOrderKey ?? null,
                autoSettleDisabledAt: row.autoSettleDisabledAt ?? null,
                titleRegeneration: mapTitleRegeneration(row),
                titleState: row.titleState,
                deletedAt: row.deletedAt,
                messages: messagesByThread.get(row.threadId) ?? [],
                proposedPlans: proposedPlansByThread.get(row.threadId) ?? [],
                activities: activitiesByThread.get(row.threadId) ?? [],
                checkpoints: checkpointsByThread.get(row.threadId) ?? [],
                session: sessionsByThread.get(row.threadId) ?? null,
              }));

              const snapshot = {
                snapshotSequence: computeSnapshotSequence(stateRows),
                projects,
                threads,
                updatedAt: updatedAt ?? "1970-01-01T00:00:00.000Z",
              };

              return yield* decodeReadModel(snapshot).pipe(
                Effect.mapError(
                  toPersistenceDecodeError("ProjectionSnapshotQuery.getSnapshot:decodeReadModel"),
                ),
              );
            }),
        ),
        Effect.mapError((error) => {
          if (isPersistenceError(error)) {
            return error;
          }
          return toPersistenceSqlError("ProjectionSnapshotQuery.getSnapshot:query")(error);
        }),
      );

  // T3-CUSTOM(expbkt3): Never hydrate activities for plan-review startup ingest.
  const listLatestProposedPlansForActiveThreads: ProjectionSnapshotQueryShape["listLatestProposedPlansForActiveThreads"] =
    () =>
      listLatestProposedPlanRowsForActiveThreads(undefined).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.listLatestProposedPlansForActiveThreads:query",
            "ProjectionSnapshotQuery.listLatestProposedPlansForActiveThreads:decodeRows",
          ),
        ),
        Effect.map((rows) =>
          rows.map((row): ProjectionLatestProposedPlan => ({
            threadId: row.threadId,
            proposedPlan: mapProposedPlanRow(row),
          })),
        ),
      );

  const getCommandReadModel: ProjectionSnapshotQueryShape["getCommandReadModel"] = () =>
    sql
      .withTransaction(
        Effect.all([
          listProjectRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getCommandReadModel:listProjects:query",
                "ProjectionSnapshotQuery.getCommandReadModel:listProjects:decodeRows",
              ),
            ),
          ),
          listThreadRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getCommandReadModel:listThreads:query",
                "ProjectionSnapshotQuery.getCommandReadModel:listThreads:decodeRows",
              ),
            ),
          ),
          listThreadProposedPlanRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getCommandReadModel:listThreadProposedPlans:query",
                "ProjectionSnapshotQuery.getCommandReadModel:listThreadProposedPlans:decodeRows",
              ),
            ),
          ),
          listThreadPullRequestRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getCommandReadModel:listThreadPullRequests:query",
                "ProjectionSnapshotQuery.getCommandReadModel:listThreadPullRequests:decodeRows",
              ),
            ),
          ),
          listThreadSessionRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getCommandReadModel:listThreadSessions:query",
                "ProjectionSnapshotQuery.getCommandReadModel:listThreadSessions:decodeRows",
              ),
            ),
          ),
          listLatestTurnRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getCommandReadModel:listLatestTurns:query",
                "ProjectionSnapshotQuery.getCommandReadModel:listLatestTurns:decodeRows",
              ),
            ),
          ),
          // T3-CUSTOM(expbkt3): BEGIN — team mode: hydrate thread/project membership.
          listThreadMemberRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getCommandReadModel:listThreadMembers:query",
                "ProjectionSnapshotQuery.getCommandReadModel:listThreadMembers:decodeRows",
              ),
            ),
          ),
          listProjectMemberRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getCommandReadModel:listProjectMembers:query",
                "ProjectionSnapshotQuery.getCommandReadModel:listProjectMembers:decodeRows",
              ),
            ),
          ),
          // T3-CUSTOM(expbkt3): END
          listProjectionStateRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getCommandReadModel:listProjectionState:query",
                "ProjectionSnapshotQuery.getCommandReadModel:listProjectionState:decodeRows",
              ),
            ),
          ),
        ]),
      )
      .pipe(
        Effect.flatMap(
          ([
            projectRows,
            threadRows,
            proposedPlanRows,
            pullRequestRows,
            sessionRows,
            latestTurnRows,
            // T3-CUSTOM(expbkt3): team mode membership rows.
            threadMemberRows,
            projectMemberRows,
            stateRows,
          ]) =>
            Effect.gen(function* () {
              const linkedThreadIds = new Set(pullRequestRows.map((row) => row.threadId));
              const linkedProjectIds = new Set(
                threadRows
                  .filter((row) => linkedThreadIds.has(row.threadId))
                  .map((row) => row.projectId),
              );
              const repositoryIdentities = yield* resolveRepositoryIdentitiesForProjects(
                projectRows.filter((row) => linkedProjectIds.has(row.projectId)),
              );
              let updatedAt: string | null = null;
              const projects: OrchestrationProject[] = [];
              const threads: OrchestrationThread[] = [];
              // T3-CUSTOM(expbkt3): team mode membership grouping.
              const memberUserIdsByThread = groupThreadMemberIds(threadMemberRows);
              const memberUserIdsByProject = groupProjectMemberIds(projectMemberRows);

              for (let index = 0; index < projectRows.length; index += 1) {
                const row = projectRows[index];
                if (!row) {
                  continue;
                }
                updatedAt = maxIso(updatedAt, row.updatedAt);
                projects.push({
                  id: row.projectId,
                  title: row.title,
                  workspaceRoot: row.workspaceRoot,
                  repositoryIdentity: repositoryIdentities.get(row.projectId) ?? null,
                  defaultModelSelection: row.defaultModelSelection,
                  defaultThreadEnvMode: row.defaultThreadEnvMode,
                  autoPull: row.autoPull === 1,
                  faviconPath: row.faviconPath ?? null,
                  projectIcon: row.projectIcon ?? null,
                  scripts: row.scripts,
                  // T3-CUSTOM(expbkt3): team mode project ownership/membership.
                  ownerUserId: row.ownerUserId,
                  memberUserIds: memberUserIdsByProject.get(row.projectId) ?? [],
                  createdAt: row.createdAt,
                  updatedAt: row.updatedAt,
                  deletedAt: row.deletedAt,
                });
              }
              for (let index = 0; index < threadRows.length; index += 1) {
                const row = threadRows[index];
                if (!row) {
                  continue;
                }
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }
              for (let index = 0; index < proposedPlanRows.length; index += 1) {
                const row = proposedPlanRows[index];
                if (!row) {
                  continue;
                }
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }
              for (let index = 0; index < sessionRows.length; index += 1) {
                const row = sessionRows[index];
                if (!row) {
                  continue;
                }
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }
              for (let index = 0; index < latestTurnRows.length; index += 1) {
                const row = latestTurnRows[index];
                if (!row) {
                  continue;
                }
                updatedAt = maxIso(updatedAt, row.requestedAt);
                if (row.startedAt !== null) {
                  updatedAt = maxIso(updatedAt, row.startedAt);
                }
                if (row.completedAt !== null) {
                  updatedAt = maxIso(updatedAt, row.completedAt);
                }
              }
              for (let index = 0; index < stateRows.length; index += 1) {
                const row = stateRows[index];
                if (!row) {
                  continue;
                }
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }

              const latestTurnByThread = new Map<string, OrchestrationLatestTurn>();
              for (let index = 0; index < latestTurnRows.length; index += 1) {
                const row = latestTurnRows[index];
                if (!row) {
                  continue;
                }
                latestTurnByThread.set(row.threadId, mapLatestTurn(row));
              }
              const proposedPlansByThread = new Map<string, Array<OrchestrationProposedPlan>>();
              const pullRequestsByThread = groupPullRequestRowsByThread(pullRequestRows);
              const sessionByThread = new Map<string, OrchestrationSession>();

              for (let index = 0; index < sessionRows.length; index += 1) {
                const row = sessionRows[index];
                if (!row) {
                  continue;
                }
                sessionByThread.set(row.threadId, mapSessionRow(row));
              }

              for (let index = 0; index < proposedPlanRows.length; index += 1) {
                const row = proposedPlanRows[index];
                if (!row) {
                  continue;
                }
                const threadProposedPlans = proposedPlansByThread.get(row.threadId) ?? [];
                threadProposedPlans.push(mapProposedPlanRow(row));
                proposedPlansByThread.set(row.threadId, threadProposedPlans);
              }

              for (let index = 0; index < threadRows.length; index += 1) {
                const row = threadRows[index];
                if (!row) {
                  continue;
                }
                threads.push({
                  id: row.threadId,
                  projectId: row.projectId,
                  title: row.title,
                  modelSelection: row.modelSelection,
                  runtimeMode: row.runtimeMode,
                  interactionMode: row.interactionMode,
                  branch: row.branch,
                  worktreePath: row.worktreePath,
                  sourceControlProfileId: row.sourceControlProfileId, // T3-CUSTOM(expbkt3): source-control identity.
                  ...mapThreadPullRequests(
                    pullRequestsByThread.get(row.threadId) ?? [],
                    row.projectId,
                    repositoryIdentities.get(row.projectId),
                  ),
                  branchPullRequest: row.branchPullRequest,
                  latestTurn: latestTurnByThread.get(row.threadId) ?? null,
                  // T3-CUSTOM(expbkt3): team mode thread ownership/membership.
                  ownerUserId: row.ownerUserId,
                  memberUserIds: memberUserIdsByThread.get(row.threadId) ?? [],
                  createdAt: row.createdAt,
                  updatedAt: row.updatedAt,
                  archivedAt: row.archivedAt,
                  settledOverride: row.settledOverride,
                  settledAt: row.settledAt,
                  unsettledAt: row.unsettledAt,
                  snoozedUntil: row.snoozedUntil,
                  snoozedAt: row.snoozedAt,
                  // T3-CUSTOM(expbkt3): BEGIN — priority, custom sidebar group, Linear/Mattermost
                  // links, and thread lineage (parent thread/environment).
                  priority: row.priority,
                  customGroup: row.customGroup ?? null, // T3-CUSTOM(expbkt3): custom sidebar group.
                  linearIssueUrl: row.linearIssueUrl ?? null,
                  mattermostThreadUrl: row.mattermostThreadUrl ?? null,
                  parentThreadId: row.parentThreadId ?? null,
                  parentEnvironmentId: row.parentEnvironmentId ?? null,
                  // T3-CUSTOM(expbkt3): END
                  pinnedAt: row.pinnedAt,
                  pinOrderKey: row.pinOrderKey ?? null,
                  activeOrderKey: row.activeOrderKey ?? null,
                  autoSettleDisabledAt: row.autoSettleDisabledAt ?? null,
                  titleRegeneration: mapTitleRegeneration(row),
                  titleState: row.titleState,
                  deletedAt: row.deletedAt,
                  messages: [],
                  proposedPlans: proposedPlansByThread.get(row.threadId) ?? [],
                  activities: [],
                  checkpoints: [],
                  session: sessionByThread.get(row.threadId) ?? null,
                });
              }

              return {
                snapshotSequence: computeSnapshotSequence(stateRows),
                projects,
                threads,
                updatedAt: updatedAt ?? "1970-01-01T00:00:00.000Z",
              } satisfies OrchestrationReadModel;
            }),
        ),
        Effect.mapError((error) => {
          if (isPersistenceError(error)) {
            return error;
          }
          return toPersistenceSqlError("ProjectionSnapshotQuery.getCommandReadModel:query")(error);
        }),
      );

  const getShellSnapshot: ProjectionSnapshotQueryShape["getShellSnapshot"] = (options) => {
    const unsettledOnly = options?.unsettledOnly === true;
    return sql
      .withTransaction(
        Effect.all([
          listProjectRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getShellSnapshot:listProjects:query",
                "ProjectionSnapshotQuery.getShellSnapshot:listProjects:decodeRows",
              ),
            ),
          ),
          listActiveThreadRows({ unsettledOnly }).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getShellSnapshot:listThreads:query",
                "ProjectionSnapshotQuery.getShellSnapshot:listThreads:decodeRows",
              ),
            ),
          ),
          listActiveThreadSessionRows({ unsettledOnly }).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getShellSnapshot:listThreadSessions:query",
                "ProjectionSnapshotQuery.getShellSnapshot:listThreadSessions:decodeRows",
              ),
            ),
          ),
          listActiveThreadPullRequestRows({ unsettledOnly }).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getShellSnapshot:listThreadPullRequests:query",
                "ProjectionSnapshotQuery.getShellSnapshot:listThreadPullRequests:decodeRows",
              ),
            ),
          ),
          listActiveLatestTurnRows({ unsettledOnly }).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getShellSnapshot:listLatestTurns:query",
                "ProjectionSnapshotQuery.getShellSnapshot:listLatestTurns:decodeRows",
              ),
            ),
          ),
          // T3-CUSTOM(expbkt3): BEGIN — team mode: hydrate thread/project membership.
          listThreadMemberRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getShellSnapshot:listThreadMembers:query",
                "ProjectionSnapshotQuery.getShellSnapshot:listThreadMembers:decodeRows",
              ),
            ),
          ),
          listProjectMemberRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getShellSnapshot:listProjectMembers:query",
                "ProjectionSnapshotQuery.getShellSnapshot:listProjectMembers:decodeRows",
              ),
            ),
          ),
          // T3-CUSTOM(expbkt3): END
          listProjectionStateRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getShellSnapshot:listProjectionState:query",
                "ProjectionSnapshotQuery.getShellSnapshot:listProjectionState:decodeRows",
              ),
            ),
          ),
        ]),
      )
      .pipe(
        Effect.flatMap(
          // T3-CUSTOM(expbkt3): team mode membership rows join the other decoded collections.
          ([
            projectRows,
            threadRows,
            sessionRows,
            pullRequestRows,
            latestTurnRows,
            threadMemberRows,
            projectMemberRows,
            stateRows,
          ]) =>
            Effect.gen(function* () {
              const memberUserIdsByThread = groupThreadMemberIds(threadMemberRows);
              const memberUserIdsByProject = groupProjectMemberIds(projectMemberRows);
              let updatedAt: string | null = null;
              for (const row of projectRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }
              for (const row of threadRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }
              for (const row of sessionRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }
              for (const row of latestTurnRows) {
                updatedAt = maxIso(updatedAt, row.requestedAt);
                if (row.startedAt !== null) {
                  updatedAt = maxIso(updatedAt, row.startedAt);
                }
                if (row.completedAt !== null) {
                  updatedAt = maxIso(updatedAt, row.completedAt);
                }
              }
              for (const row of stateRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }

              const repositoryIdentities =
                yield* resolveRepositoryIdentitiesForProjects(projectRows);
              const latestTurnByThread = new Map(
                latestTurnRows.map((row) => [row.threadId, mapLatestTurn(row)] as const),
              );
              const sessionByThread = new Map(
                sessionRows.map((row) => [row.threadId, mapSessionRow(row)] as const),
              );
              const pullRequestsByThread = groupPullRequestRowsByThread(pullRequestRows);

              // Built from schema-decoded rows, so no second decode here. The HTTP
              // and RPC layers encode it against OrchestrationShellSnapshot on the
              // way out, like the per-item shells from getThreadShellById.
              return {
                snapshotSequence: computeSnapshotSequence(stateRows),
                projects: Arr.filterMap(projectRows, (row) =>
                  row.deletedAt === null
                    ? Result.succeed(
                        // T3-CUSTOM(expbkt3): team mode project membership.
                        mapProjectShellRow(
                          row,
                          repositoryIdentities.get(row.projectId) ?? null,
                          memberUserIdsByProject.get(row.projectId) ?? [],
                        ),
                      )
                    : Result.failVoid,
                ),
                threads: Arr.filterMap(threadRows, (row) =>
                  row.deletedAt === null
                    ? Result.succeed({
                        id: row.threadId,
                        projectId: row.projectId,
                        title: row.title,
                        modelSelection: row.modelSelection,
                        runtimeMode: row.runtimeMode,
                        interactionMode: row.interactionMode,
                        branch: row.branch,
                        worktreePath: row.worktreePath,
                        sourceControlProfileId: row.sourceControlProfileId, // T3-CUSTOM(expbkt3): source-control identity.
                        branchPullRequest: row.branchPullRequest,
                        ...mapThreadPullRequests(
                          pullRequestsByThread.get(row.threadId) ?? [],
                          row.projectId,
                          repositoryIdentities.get(row.projectId),
                        ),
                        latestTurn: latestTurnByThread.get(row.threadId) ?? null,
                        // T3-CUSTOM(expbkt3): team mode thread ownership/membership.
                        ownerUserId: row.ownerUserId,
                        memberUserIds: memberUserIdsByThread.get(row.threadId) ?? [],
                        createdAt: row.createdAt,
                        updatedAt: row.updatedAt,
                        archivedAt: row.archivedAt,
                        settledOverride: row.settledOverride,
                        settledAt: row.settledAt,
                        unsettledAt: row.unsettledAt,
                        snoozedUntil: row.snoozedUntil,
                        snoozedAt: row.snoozedAt,
                        // T3-CUSTOM(expbkt3): BEGIN — priority, custom sidebar group, Linear/Mattermost
                        // links, and thread lineage (parent thread/environment).
                        priority: row.priority,
                        customGroup: row.customGroup ?? null, // T3-CUSTOM(expbkt3): custom sidebar group.
                        linearIssueUrl: row.linearIssueUrl ?? null,
                        mattermostThreadUrl: row.mattermostThreadUrl ?? null,
                        parentThreadId: row.parentThreadId ?? null,
                        parentEnvironmentId: row.parentEnvironmentId ?? null,
                        // T3-CUSTOM(expbkt3): END
                        pinnedAt: row.pinnedAt,
                        pinOrderKey: row.pinOrderKey ?? null,
                        activeOrderKey: row.activeOrderKey ?? null,
                        autoSettleDisabledAt: row.autoSettleDisabledAt ?? null,
                        titleRegeneration: mapTitleRegeneration(row),
                        titleState: row.titleState,
                        session: sessionByThread.get(row.threadId) ?? null,
                        latestUserMessageAt: row.latestUserMessageAt,
                        hasPendingApprovals: row.pendingApprovalCount > 0,
                        hasPendingUserInput: row.pendingUserInputCount > 0,
                        // T3-CUSTOM(expbkt3): neutral async-question sidebar signal.
                        hasPendingAsyncUserInput: (row.pendingAsyncUserInputCount ?? 0) > 0,
                        hasActionableProposedPlan: row.hasActionableProposedPlan > 0,
                        backgroundLiveness: threadBackgroundLiveness.getThreadBackgroundLiveness(
                          row.threadId,
                        ),
                        planProgress: threadPlanProgress.getThreadPlanProgress(row.threadId),
                      } satisfies OrchestrationThreadShell)
                    : Result.failVoid,
                ),
                updatedAt: updatedAt ?? "1970-01-01T00:00:00.000Z",
              } satisfies OrchestrationShellSnapshot;
            }),
        ),
        Effect.mapError((error) => {
          if (isPersistenceError(error)) {
            return error;
          }
          return toPersistenceSqlError("ProjectionSnapshotQuery.getShellSnapshot:query")(error);
        }),
      );
  };

  const listThreadsWithPullRequests: ProjectionSnapshotQueryShape["listThreadsWithPullRequests"] =
    () =>
      listActiveThreadPullRequestSyncRows(undefined).pipe(
        Effect.map((rows) => {
          const threads = new Map<
            ThreadId,
            ProjectionThreadPullRequests & { readonly pullRequests: Array<ThreadPullRequestLink> }
          >();
          for (const row of rows) {
            const thread = threads.get(row.threadId) ?? {
              id: row.threadId,
              projectId: row.projectId,
              settledOverride: row.settledOverride,
              settledAt: row.settledAt,
              pullRequests: [],
            };
            thread.pullRequests.push(mapPullRequestRow(row));
            threads.set(row.threadId, thread);
          }
          return [...threads.values()];
        }),
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.listThreadsWithPullRequests:query",
            "ProjectionSnapshotQuery.listThreadsWithPullRequests:decodeRows",
          ),
        ),
      );

  const getArchivedShellSnapshot: ProjectionSnapshotQueryShape["getArchivedShellSnapshot"] = () =>
    sql
      .withTransaction(
        Effect.all([
          listProjectRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getArchivedShellSnapshot:listProjects:query",
                "ProjectionSnapshotQuery.getArchivedShellSnapshot:listProjects:decodeRows",
              ),
            ),
          ),
          listArchivedThreadRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getArchivedShellSnapshot:listThreads:query",
                "ProjectionSnapshotQuery.getArchivedShellSnapshot:listThreads:decodeRows",
              ),
            ),
          ),
          listArchivedThreadSessionRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getArchivedShellSnapshot:listThreadSessions:query",
                "ProjectionSnapshotQuery.getArchivedShellSnapshot:listThreadSessions:decodeRows",
              ),
            ),
          ),
          listArchivedThreadPullRequestRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getArchivedShellSnapshot:listThreadPullRequests:query",
                "ProjectionSnapshotQuery.getArchivedShellSnapshot:listThreadPullRequests:decodeRows",
              ),
            ),
          ),
          listArchivedLatestTurnRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getArchivedShellSnapshot:listLatestTurns:query",
                "ProjectionSnapshotQuery.getArchivedShellSnapshot:listLatestTurns:decodeRows",
              ),
            ),
          ),
          // T3-CUSTOM(expbkt3): BEGIN — team mode: hydrate thread/project membership.
          listThreadMemberRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getArchivedShellSnapshot:listThreadMembers:query",
                "ProjectionSnapshotQuery.getArchivedShellSnapshot:listThreadMembers:decodeRows",
              ),
            ),
          ),
          listProjectMemberRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getArchivedShellSnapshot:listProjectMembers:query",
                "ProjectionSnapshotQuery.getArchivedShellSnapshot:listProjectMembers:decodeRows",
              ),
            ),
          ),
          // T3-CUSTOM(expbkt3): END
          listProjectionStateRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getArchivedShellSnapshot:listProjectionState:query",
                "ProjectionSnapshotQuery.getArchivedShellSnapshot:listProjectionState:decodeRows",
              ),
            ),
          ),
        ]),
      )
      .pipe(
        Effect.flatMap(
          // T3-CUSTOM(expbkt3): team mode membership rows join the other decoded collections.
          ([
            projectRows,
            threadRows,
            sessionRows,
            pullRequestRows,
            latestTurnRows,
            threadMemberRows,
            projectMemberRows,
            stateRows,
          ]) =>
            Effect.gen(function* () {
              const memberUserIdsByThread = groupThreadMemberIds(threadMemberRows);
              const memberUserIdsByProject = groupProjectMemberIds(projectMemberRows);
              let updatedAt: string | null = null;
              for (const row of projectRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }
              for (const row of threadRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }
              for (const row of sessionRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }
              for (const row of latestTurnRows) {
                updatedAt = maxIso(updatedAt, row.requestedAt);
                if (row.startedAt !== null) {
                  updatedAt = maxIso(updatedAt, row.startedAt);
                }
                if (row.completedAt !== null) {
                  updatedAt = maxIso(updatedAt, row.completedAt);
                }
              }
              for (const row of stateRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }

              const pullRequestsByThread = groupPullRequestRowsByThread(pullRequestRows);
              const activeProjectIds = new Set(threadRows.map((row) => row.projectId));
              const repositoryIdentities = yield* resolveRepositoryIdentitiesForProjects(
                projectRows.filter((row) => activeProjectIds.has(row.projectId)),
              );
              const latestTurnByThread = new Map(
                latestTurnRows.map((row) => [row.threadId, mapLatestTurn(row)] as const),
              );
              const sessionByThread = new Map(
                sessionRows.map((row) => [row.threadId, mapSessionRow(row)] as const),
              );

              return {
                snapshotSequence: computeSnapshotSequence(stateRows),
                projects: Arr.filterMap(projectRows, (row) =>
                  row.deletedAt === null && activeProjectIds.has(row.projectId)
                    ? Result.succeed(
                        // T3-CUSTOM(expbkt3): team mode project membership.
                        mapProjectShellRow(
                          row,
                          repositoryIdentities.get(row.projectId) ?? null,
                          memberUserIdsByProject.get(row.projectId) ?? [],
                        ),
                      )
                    : Result.failVoid,
                ),
                threads: threadRows.map((row): OrchestrationThreadShell => ({
                  id: row.threadId,
                  projectId: row.projectId,
                  title: row.title,
                  modelSelection: row.modelSelection,
                  runtimeMode: row.runtimeMode,
                  interactionMode: row.interactionMode,
                  branch: row.branch,
                  worktreePath: row.worktreePath,
                  sourceControlProfileId: row.sourceControlProfileId, // T3-CUSTOM(expbkt3): source-control identity.
                  branchPullRequest: row.branchPullRequest,
                  ...mapThreadPullRequests(
                    pullRequestsByThread.get(row.threadId) ?? [],
                    row.projectId,
                    repositoryIdentities.get(row.projectId),
                  ),
                  latestTurn: latestTurnByThread.get(row.threadId) ?? null,
                  // T3-CUSTOM(expbkt3): team mode thread ownership/membership.
                  ownerUserId: row.ownerUserId,
                  memberUserIds: memberUserIdsByThread.get(row.threadId) ?? [],
                  createdAt: row.createdAt,
                  updatedAt: row.updatedAt,
                  archivedAt: row.archivedAt,
                  settledOverride: row.settledOverride,
                  settledAt: row.settledAt,
                  unsettledAt: row.unsettledAt,
                  snoozedUntil: row.snoozedUntil,
                  snoozedAt: row.snoozedAt,
                  // T3-CUSTOM(expbkt3): BEGIN — priority, custom sidebar group, Linear/Mattermost
                  // links, and thread lineage (parent thread/environment).
                  priority: row.priority,
                  customGroup: row.customGroup ?? null, // T3-CUSTOM(expbkt3): custom sidebar group.
                  linearIssueUrl: row.linearIssueUrl ?? null,
                  mattermostThreadUrl: row.mattermostThreadUrl ?? null,
                  parentThreadId: row.parentThreadId ?? null,
                  parentEnvironmentId: row.parentEnvironmentId ?? null,
                  // T3-CUSTOM(expbkt3): END
                  pinnedAt: row.pinnedAt,
                  pinOrderKey: row.pinOrderKey ?? null,
                  activeOrderKey: row.activeOrderKey ?? null,
                  autoSettleDisabledAt: row.autoSettleDisabledAt ?? null,
                  titleRegeneration: mapTitleRegeneration(row),
                  titleState: row.titleState,
                  session: sessionByThread.get(row.threadId) ?? null,
                  latestUserMessageAt: row.latestUserMessageAt,
                  hasPendingApprovals: row.pendingApprovalCount > 0,
                  hasPendingUserInput: row.pendingUserInputCount > 0,
                  // T3-CUSTOM(expbkt3): neutral async-question sidebar signal.
                  hasPendingAsyncUserInput: (row.pendingAsyncUserInputCount ?? 0) > 0,
                  hasActionableProposedPlan: row.hasActionableProposedPlan > 0,
                  backgroundLiveness: threadBackgroundLiveness.getThreadBackgroundLiveness(
                    row.threadId,
                  ),
                  planProgress: threadPlanProgress.getThreadPlanProgress(row.threadId),
                })),
                updatedAt: updatedAt ?? "1970-01-01T00:00:00.000Z",
              } satisfies OrchestrationShellSnapshot;
            }),
        ),
        Effect.mapError((error) => {
          if (isPersistenceError(error)) {
            return error;
          }
          return toPersistenceSqlError("ProjectionSnapshotQuery.getArchivedShellSnapshot:query")(
            error,
          );
        }),
      );

  const getSnapshotSequence: ProjectionSnapshotQueryShape["getSnapshotSequence"] = () =>
    listProjectionStateRows(undefined).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionSnapshotQuery.getSnapshotSequence:query",
          "ProjectionSnapshotQuery.getSnapshotSequence:decodeRows",
        ),
      ),
      Effect.map((stateRows) => ({
        snapshotSequence: computeSnapshotSequence(stateRows),
      })),
    );

  const getCounts: ProjectionSnapshotQueryShape["getCounts"] = () =>
    readProjectionCounts(undefined).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionSnapshotQuery.getCounts:query",
          "ProjectionSnapshotQuery.getCounts:decodeRow",
        ),
      ),
      Effect.map((row): ProjectionSnapshotCounts => ({
        projectCount: row.projectCount,
        threadCount: row.threadCount,
      })),
    );

  const getEventReplayStats: ProjectionSnapshotQueryShape["getEventReplayStats"] = (input) =>
    readEventReplayStats(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionSnapshotQuery.getEventReplayStats:query",
          "ProjectionSnapshotQuery.getEventReplayStats:decodeRow",
        ),
      ),
      Effect.map((row): ProjectionEventReplayStats => ({
        eventCount: row.eventCount,
        payloadBytes: row.payloadBytes,
      })),
    );

  const searchThreads: ProjectionSnapshotQueryShape["searchThreads"] = Effect.fn(
    "ProjectionSnapshotQuery.searchThreads",
  )(function* (input) {
    const escapedQuery = escapeLikePattern(input.query);
    const rows = yield* searchActiveThreadRows({
      pattern: `%${escapedQuery}%`,
      limit: input.limit ?? 50,
    }).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionSnapshotQuery.searchThreads:query",
          "ProjectionSnapshotQuery.searchThreads:decodeRows",
        ),
      ),
    );
    return {
      matches: rows.map((row) => ({
        threadId: row.threadId,
        projectId: row.projectId,
        source: row.source,
        snippet: buildSearchSnippet(row.matchText, input.query),
        messageCreatedAt: row.messageCreatedAt,
      })),
    };
  });

  const getActiveProjectByWorkspaceRoot: ProjectionSnapshotQueryShape["getActiveProjectByWorkspaceRoot"] =
    (workspaceRoot) =>
      getActiveProjectRowByWorkspaceRoot({ workspaceRoot }).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getActiveProjectByWorkspaceRoot:query",
            "ProjectionSnapshotQuery.getActiveProjectByWorkspaceRoot:decodeRow",
          ),
        ),
        Effect.flatMap((option) =>
          Option.isNone(option)
            ? Effect.succeed(Option.none<OrchestrationProject>())
            : // T3-CUSTOM(expbkt3): BEGIN — team mode: hydrate this project's membership too.
              Effect.all({
                repositoryIdentity: repositoryIdentityResolver.resolve(option.value.workspaceRoot),
                memberRows: listProjectMemberRowsByProjectId({
                  projectId: option.value.projectId,
                }).pipe(
                  Effect.mapError(
                    toPersistenceSqlOrDecodeError(
                      "ProjectionSnapshotQuery.getActiveProjectByWorkspaceRoot:listMembers:query",
                      "ProjectionSnapshotQuery.getActiveProjectByWorkspaceRoot:listMembers:decodeRows",
                    ),
                  ),
                ),
              }).pipe(
                // T3-CUSTOM(expbkt3): END
                Effect.map(({ repositoryIdentity, memberRows }) =>
                  Option.some({
                    id: option.value.projectId,
                    title: option.value.title,
                    workspaceRoot: option.value.workspaceRoot,
                    repositoryIdentity,
                    defaultModelSelection: option.value.defaultModelSelection,
                    defaultThreadEnvMode: option.value.defaultThreadEnvMode,
                    autoPull: option.value.autoPull === 1,
                    faviconPath: option.value.faviconPath ?? null,
                    projectIcon: option.value.projectIcon ?? null,
                    scripts: option.value.scripts,
                    // T3-CUSTOM(expbkt3): team mode project ownership/membership.
                    ownerUserId: option.value.ownerUserId,
                    memberUserIds: memberRows.map((row) => row.userId),
                    createdAt: option.value.createdAt,
                    updatedAt: option.value.updatedAt,
                    deletedAt: option.value.deletedAt,
                  } satisfies OrchestrationProject),
                ),
              ),
        ),
      );

  const getProjectShells: ProjectionSnapshotQueryShape["getProjectShells"] = (projectIds) => {
    if (projectIds?.length === 0) return Effect.succeed([]);
    return listProjectRows({ activeOnly: true, projectIds }).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionSnapshotQuery.getProjectShells:query",
          "ProjectionSnapshotQuery.getProjectShells:decodeRows",
        ),
      ),
      Effect.flatMap((projects) =>
        resolveRepositoryIdentitiesForProjects(projects).pipe(
          Effect.map((identities) =>
            projects.map((row) => mapProjectShellRow(row, identities.get(row.projectId) ?? null)),
          ),
        ),
      ),
    );
  };

  const getProjectShellById: ProjectionSnapshotQueryShape["getProjectShellById"] = (projectId) =>
    getActiveProjectRowById({ projectId }).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionSnapshotQuery.getProjectShellById:query",
          "ProjectionSnapshotQuery.getProjectShellById:decodeRow",
        ),
      ),
      Effect.flatMap((option) =>
        Option.isNone(option)
          ? Effect.succeed(Option.none<OrchestrationProjectShell>())
          : // T3-CUSTOM(expbkt3): BEGIN — team mode: hydrate this project's membership too.
            Effect.all({
              repositoryIdentity: repositoryIdentityResolver.resolve(option.value.workspaceRoot),
              memberRows: listProjectMemberRowsByProjectId({
                projectId: option.value.projectId,
              }).pipe(
                Effect.mapError(
                  toPersistenceSqlOrDecodeError(
                    "ProjectionSnapshotQuery.getProjectShellById:listMembers:query",
                    "ProjectionSnapshotQuery.getProjectShellById:listMembers:decodeRows",
                  ),
                ),
              ),
            }).pipe(
              Effect.map(({ repositoryIdentity, memberRows }) =>
                Option.some(
                  mapProjectShellRow(
                    option.value,
                    repositoryIdentity,
                    memberRows.map((row) => row.userId),
                  ),
                ),
              ),
              // T3-CUSTOM(expbkt3): END
            ),
      ),
    );

  const getFirstActiveThreadIdByProjectId: ProjectionSnapshotQueryShape["getFirstActiveThreadIdByProjectId"] =
    (projectId) =>
      getFirstActiveThreadIdByProject({ projectId }).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getFirstActiveThreadIdByProjectId:query",
            "ProjectionSnapshotQuery.getFirstActiveThreadIdByProjectId:decodeRow",
          ),
        ),
        Effect.map(Option.map((row) => row.threadId)),
      );

  const getImportedAgentSessionSources: ProjectionSnapshotQueryShape["getImportedAgentSessionSources"] =
    Effect.fn("ProjectionSnapshotQuery.getImportedAgentSessionSources")(function* (projectId) {
      const rows = yield* listImportedAgentSessionSourceRows({ projectId }).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getImportedAgentSessionSources:query",
            "ProjectionSnapshotQuery.getImportedAgentSessionSources:decodeRows",
          ),
        ),
      );
      return rows.flatMap((row) => {
        const payload = decodeImportedTranscriptsPayload(row.runtimePayload);
        if (Option.isNone(payload)) return [];
        return payload.value.importedTranscripts.flatMap((entry) => {
          const source = decodeAgentSessionImportSource(entry);
          if (
            Option.isNone(source) ||
            row.threadId !==
              `import:${source.value.providerInstanceId}:${source.value.providerSessionId}`
          ) {
            return [];
          }
          return [{ threadId: row.threadId, source: source.value }];
        });
      });
    });

  const getThreadCheckpointContext: ProjectionSnapshotQueryShape["getThreadCheckpointContext"] = (
    threadId,
  ) =>
    Effect.gen(function* () {
      const threadRow = yield* getThreadCheckpointContextThreadRow({ threadId }).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getThreadCheckpointContext:getThread:query",
            "ProjectionSnapshotQuery.getThreadCheckpointContext:getThread:decodeRow",
          ),
        ),
      );
      if (Option.isNone(threadRow)) {
        return Option.none<ProjectionThreadCheckpointContext>();
      }

      const checkpointRows = yield* listCheckpointRowsByThread({ threadId }).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getThreadCheckpointContext:listCheckpoints:query",
            "ProjectionSnapshotQuery.getThreadCheckpointContext:listCheckpoints:decodeRows",
          ),
        ),
      );

      return Option.some({
        threadId: threadRow.value.threadId,
        projectId: threadRow.value.projectId,
        workspaceRoot: threadRow.value.workspaceRoot,
        worktreePath: threadRow.value.worktreePath,
        checkpoints: checkpointRows.map((row): OrchestrationCheckpointSummary => ({
          turnId: row.turnId,
          checkpointTurnCount: row.checkpointTurnCount,
          checkpointRef: row.checkpointRef,
          status: row.status,
          files: row.files,
          assistantMessageId: row.assistantMessageId,
          completedAt: row.completedAt,
        })),
      });
    });

  const getFullThreadDiffContext: NonNullable<
    ProjectionSnapshotQueryShape["getFullThreadDiffContext"]
  > = (threadId, toTurnCount) =>
    Effect.gen(function* () {
      const row = yield* getFullThreadDiffContextRow({
        threadId,
        checkpointTurnCount: toTurnCount,
      }).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getFullThreadDiffContext:query",
            "ProjectionSnapshotQuery.getFullThreadDiffContext:decodeRow",
          ),
        ),
      );
      if (Option.isNone(row)) {
        return Option.none<ProjectionFullThreadDiffContext>();
      }

      return Option.some({
        threadId: row.value.threadId,
        projectId: row.value.projectId,
        workspaceRoot: row.value.workspaceRoot,
        worktreePath: row.value.worktreePath,
        latestCheckpointTurnCount: row.value.latestCheckpointTurnCount ?? 0,
        toCheckpointRef: row.value.toCheckpointRef,
      });
    });

  const getThreadShellById: ProjectionSnapshotQueryShape["getThreadShellById"] = (threadId) =>
    Effect.gen(function* () {
      // T3-CUSTOM(expbkt3): BEGIN — team mode: hydrate this thread's membership alongside
      // everything else a single-thread shell needs.
      const [threadRow, latestTurnRow, sessionRow, memberRows, pullRequestRows] = yield* Effect.all(
        [
          getActiveThreadRowById({ threadId }).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getThreadShellById:getThread:query",
                "ProjectionSnapshotQuery.getThreadShellById:getThread:decodeRow",
              ),
            ),
          ),
          getLatestTurnRowByThread({ threadId }).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getThreadShellById:getLatestTurn:query",
                "ProjectionSnapshotQuery.getThreadShellById:getLatestTurn:decodeRow",
              ),
            ),
          ),
          getThreadSessionRowByThread({ threadId }).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getThreadShellById:getSession:query",
                "ProjectionSnapshotQuery.getThreadShellById:getSession:decodeRow",
              ),
            ),
          ),
          listThreadMemberRowsByThreadId({ threadId }).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getThreadShellById:listMembers:query",
                "ProjectionSnapshotQuery.getThreadShellById:listMembers:decodeRows",
              ),
            ),
          ),
          listThreadPullRequestRowsByThread({ threadId }).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getThreadShellById:listPullRequests:query",
                "ProjectionSnapshotQuery.getThreadShellById:listPullRequests:decodeRows",
              ),
            ),
          ),
        ],
      );
      // T3-CUSTOM(expbkt3): END

      if (Option.isNone(threadRow)) {
        return Option.none<OrchestrationThreadShell>();
      }

      return Option.some({
        id: threadRow.value.threadId,
        projectId: threadRow.value.projectId,
        title: threadRow.value.title,
        modelSelection: threadRow.value.modelSelection,
        runtimeMode: threadRow.value.runtimeMode,
        interactionMode: threadRow.value.interactionMode,
        branch: threadRow.value.branch,
        worktreePath: threadRow.value.worktreePath,
        sourceControlProfileId: threadRow.value.sourceControlProfileId, // T3-CUSTOM(expbkt3): source-control identity.
        ...mapThreadPullRequests(
          pullRequestRows.map(mapPullRequestRow),
          threadRow.value.projectId,
          pullRequestRows.length === 0
            ? null
            : Option.getOrNull(yield* getProjectShellById(threadRow.value.projectId))
                ?.repositoryIdentity,
        ),
        branchPullRequest: threadRow.value.branchPullRequest,
        latestTurn: Option.isSome(latestTurnRow) ? mapLatestTurn(latestTurnRow.value) : null,
        // T3-CUSTOM(expbkt3): team mode thread ownership/membership.
        ownerUserId: threadRow.value.ownerUserId,
        memberUserIds: memberRows.map((row) => row.userId),
        createdAt: threadRow.value.createdAt,
        updatedAt: threadRow.value.updatedAt,
        archivedAt: threadRow.value.archivedAt,
        settledOverride: threadRow.value.settledOverride,
        settledAt: threadRow.value.settledAt,
        unsettledAt: threadRow.value.unsettledAt,
        snoozedUntil: threadRow.value.snoozedUntil,
        snoozedAt: threadRow.value.snoozedAt,
        // T3-CUSTOM(expbkt3): BEGIN — priority, custom sidebar group, Linear/Mattermost
        // links, and thread lineage (parent thread/environment).
        priority: threadRow.value.priority,
        customGroup: threadRow.value.customGroup ?? null, // T3-CUSTOM(expbkt3): custom sidebar group.
        linearIssueUrl: threadRow.value.linearIssueUrl ?? null,
        mattermostThreadUrl: threadRow.value.mattermostThreadUrl ?? null,
        parentThreadId: threadRow.value.parentThreadId ?? null,
        parentEnvironmentId: threadRow.value.parentEnvironmentId ?? null,
        // T3-CUSTOM(expbkt3): END
        pinnedAt: threadRow.value.pinnedAt,
        pinOrderKey: threadRow.value.pinOrderKey ?? null,
        activeOrderKey: threadRow.value.activeOrderKey ?? null,
        autoSettleDisabledAt: threadRow.value.autoSettleDisabledAt ?? null,
        titleRegeneration: mapTitleRegeneration(threadRow.value),
        titleState: threadRow.value.titleState,
        session: Option.isSome(sessionRow) ? mapSessionRow(sessionRow.value) : null,
        latestUserMessageAt: threadRow.value.latestUserMessageAt,
        hasPendingApprovals: threadRow.value.pendingApprovalCount > 0,
        hasPendingUserInput: threadRow.value.pendingUserInputCount > 0,
        // T3-CUSTOM(expbkt3): neutral async-question sidebar signal.
        hasPendingAsyncUserInput: (threadRow.value.pendingAsyncUserInputCount ?? 0) > 0,
        hasActionableProposedPlan: threadRow.value.hasActionableProposedPlan > 0,
        backgroundLiveness: threadBackgroundLiveness.getThreadBackgroundLiveness(
          threadRow.value.threadId,
        ),
        planProgress: threadPlanProgress.getThreadPlanProgress(threadRow.value.threadId),
      } satisfies OrchestrationThreadShell);
    });

  const getThreadAccessById: ProjectionSnapshotQueryShape["getThreadAccessById"] = (threadId) =>
    Effect.gen(function* () {
      const [threadRow, memberRows] = yield* Effect.all([
        getThreadAccessRowById({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadAccessById:getThread:query",
              "ProjectionSnapshotQuery.getThreadAccessById:getThread:decodeRow",
            ),
          ),
        ),
        listThreadMemberRowsByThreadId({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadAccessById:listMembers:query",
              "ProjectionSnapshotQuery.getThreadAccessById:listMembers:decodeRows",
            ),
          ),
        ),
      ]);

      if (Option.isNone(threadRow)) {
        return Option.none<ProjectionThreadAccess>();
      }

      return Option.some({
        threadId: threadRow.value.threadId,
        projectId: threadRow.value.projectId,
        ownerUserId: threadRow.value.ownerUserId,
        memberUserIds: memberRows.map((row) => row.userId),
      } satisfies ProjectionThreadAccess);
    });

  const listThreadShellsByProjectId: ProjectionSnapshotQueryShape["listThreadShellsByProjectId"] = (
    projectId,
  ) =>
    Effect.gen(function* () {
      const rows = yield* listActiveThreadRowsByProjectId({ projectId }).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.listThreadShellsByProjectId:listThreads:query",
            "ProjectionSnapshotQuery.listThreadShellsByProjectId:listThreads:decodeRows",
          ),
        ),
      );
      const shells = yield* Effect.forEach(rows, (row) => getThreadShellById(row.threadId), {
        concurrency: 4,
      });
      return shells.filter(Option.isSome).map((option) => option.value);
    });

  const getThreadRuntimeContext: ProjectionSnapshotQueryShape["getThreadRuntimeContext"] =
    Effect.fn("ProjectionSnapshotQuery.getThreadRuntimeContext")(function* (threadId) {
      const context = yield* getThreadRuntimeContextRow({ threadId }).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getThreadRuntimeContext:query",
            "ProjectionSnapshotQuery.getThreadRuntimeContext:decodeRow",
          ),
        ),
      );
      return Option.map(context, (row) => ({
        id: row.id,
        projectId: row.projectId,
        title: row.title,
        titleState: row.titleState,
        session: row.session === null ? null : mapSessionRow(row.session),
      }));
    });

  const getTurnStartMessage: ProjectionSnapshotQueryShape["getTurnStartMessage"] = Effect.fn(
    "ProjectionSnapshotQuery.getTurnStartMessage",
  )(function* (input) {
    const message = yield* getTurnStartMessageRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionSnapshotQuery.getTurnStartMessage:query",
          "ProjectionSnapshotQuery.getTurnStartMessage:decodeRow",
        ),
      ),
    );
    return Option.map(message, (row) => ({
      message: {
        id: row.messageId,
        role: row.role,
        text: row.text,
        turnId: row.turnId,
        streaming: row.isStreaming === 1,
        // T3-CUSTOM(expbkt3): message sender attribution.
        sentByUserId: row.sentByUserId,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        ...(row.attachments !== null ? { attachments: row.attachments } : {}),
        ...(row.context !== null ? { context: row.context } : {}),
      },
      hasOtherUserMessages: row.hasOtherUserMessages === 1,
    }));
  });

  // T3-CUSTOM(expbkt3): BEGIN
  const countThreadUserMessages: ProjectionSnapshotQueryShape["countThreadUserMessages"] =
    Effect.fn("ProjectionSnapshotQuery.countThreadUserMessages")(function* (threadId) {
      const row = yield* countThreadUserMessagesRow({ threadId }).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.countThreadUserMessages:query",
            "ProjectionSnapshotQuery.countThreadUserMessages:decodeRow",
          ),
        ),
      );
      return row.count;
    });
  // T3-CUSTOM(expbkt3): END

  // Contiguous turn range bounding a windowed detail read; undefined loads the
  // full thread. Resolved from a window request inside the snapshot
  // transaction (see getThreadDetailSnapshot).
  interface ThreadDetailBounds {
    readonly minAnchorAt: string;
    readonly minTurnKey: string;
    readonly beforeAnchorAt: string;
    readonly beforeTurnKey: string;
  }

  type ThreadDetailActivityRead =
    | {
        readonly mode: "raw";
        readonly query?: ProjectionThreadDetailQuery;
      }
    | {
        readonly mode: "client";
      };

  const listProjectedThreadActivities = Effect.fn(
    "ProjectionSnapshotQuery.listProjectedThreadActivities",
  )(function* (threadId: ThreadId, bounds: ThreadDetailBounds | undefined) {
    const [activityIdRows, pinnedActivityIdRows] = yield* Effect.all([
      (bounds === undefined
        ? listThreadActivityIdsByThread({ threadId })
        : listThreadActivityIdsByThreadWindow({ threadId, ...bounds })
      ).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getThreadDetailById:listActivityIds:query",
            "ProjectionSnapshotQuery.getThreadDetailById:listActivityIds:decodeRows",
          ),
        ),
      ),
      listPinnedThreadActivityIdsByThread({ threadId }).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getThreadDetailById:listPinnedActivityIds:query",
            "ProjectionSnapshotQuery.getThreadDetailById:listPinnedActivityIds:decodeRows",
          ),
        ),
      ),
    ]);
    const activityIds = [
      ...new Set([...activityIdRows, ...pinnedActivityIdRows].map(({ activityId }) => activityId)),
    ];
    const activities: OrchestrationThreadActivity[] = [];

    for (
      let offset = 0;
      offset < activityIds.length;
      offset += THREAD_DETAIL_ACTIVITY_PAYLOAD_BATCH_SIZE
    ) {
      const batchIds = activityIds.slice(
        offset,
        offset + THREAD_DETAIL_ACTIVITY_PAYLOAD_BATCH_SIZE,
      );
      const batchRows = yield* listThreadActivityRowsByIds({ activityIds: batchIds }).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getThreadDetailById:listActivityPayloadBatch:query",
            "ProjectionSnapshotQuery.getThreadDetailById:listActivityPayloadBatch:decodeRows",
          ),
        ),
      );
      for (const row of batchRows) {
        activities.push(projectActivityPayload(mapThreadActivityRow(row)));
      }
    }

    return activities.toSorted(
      (left, right) =>
        (left.sequence ?? -1) - (right.sequence ?? -1) ||
        left.createdAt.localeCompare(right.createdAt) ||
        left.id.localeCompare(right.id),
    );
  });

  const getThreadDetailByIdBounded = (
    threadId: ThreadId,
    bounds: ThreadDetailBounds | undefined,
    activityRead: ThreadDetailActivityRead = { mode: "raw" },
  ) =>
    Effect.gen(function* () {
      const activitiesEffect =
        activityRead.mode === "client"
          ? listProjectedThreadActivities(threadId, bounds)
          : Effect.all([
              (activityRead.query?.activityKinds === undefined
                ? bounds === undefined
                  ? listThreadActivityRowsByThread({ threadId })
                  : listThreadActivityRowsByThreadWindow({ threadId, ...bounds })
                : activityRead.query.activityKinds.length === 0
                  ? Effect.succeed([])
                  : listThreadActivityRowsByThreadAndKinds({
                      threadId,
                      activityKinds: activityRead.query.activityKinds,
                    })
              ).pipe(
                Effect.mapError(
                  toPersistenceSqlOrDecodeError(
                    "ProjectionSnapshotQuery.getThreadDetailById:listActivities:query",
                    "ProjectionSnapshotQuery.getThreadDetailById:listActivities:decodeRows",
                  ),
                ),
              ),
              activityRead.query?.activityKinds === undefined
                ? listPinnedThreadActivityRowsByThread({ threadId }).pipe(
                    Effect.mapError(
                      toPersistenceSqlOrDecodeError(
                        "ProjectionSnapshotQuery.getThreadDetailById:listPinnedActivities:query",
                        "ProjectionSnapshotQuery.getThreadDetailById:listPinnedActivities:decodeRows",
                      ),
                    ),
                  )
                : Effect.succeed([]),
            ]).pipe(
              Effect.map(([activityRows, pinnedActivityRows]) =>
                [
                  ...new Map(
                    [...activityRows, ...pinnedActivityRows].map(
                      (row) => [row.activityId, row] as const,
                    ),
                  ).values(),
                ]
                  .toSorted(
                    (left, right) =>
                      (left.sequence ?? -1) - (right.sequence ?? -1) ||
                      left.createdAt.localeCompare(right.createdAt) ||
                      left.activityId.localeCompare(right.activityId),
                  )
                  .map(mapThreadActivityRow),
              ),
            );

      const [
        threadRow,
        messageRows,
        proposedPlanRows,
        pullRequestRows,
        activities,
        checkpointRows,
        latestTurnRow,
        sessionRow,
        // T3-CUSTOM(expbkt3): BEGIN — team mode: hydrate this thread's membership too.
        memberRows,
      ] = yield* Effect.all([
        getActiveThreadRowById({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadDetailById:getThread:query",
              "ProjectionSnapshotQuery.getThreadDetailById:getThread:decodeRow",
            ),
          ),
        ),
        (bounds === undefined
          ? listThreadMessageRowsByThread({ threadId })
          : listThreadMessageRowsByThreadWindow({ threadId, ...bounds })
        ).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadDetailById:listMessages:query",
              "ProjectionSnapshotQuery.getThreadDetailById:listMessages:decodeRows",
            ),
          ),
        ),
        listThreadProposedPlanRowsByThread({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadDetailById:listPlans:query",
              "ProjectionSnapshotQuery.getThreadDetailById:listPlans:decodeRows",
            ),
          ),
        ),
        listThreadPullRequestRowsByThread({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadDetailById:listPullRequests:query",
              "ProjectionSnapshotQuery.getThreadDetailById:listPullRequests:decodeRows",
            ),
          ),
        ),
        activitiesEffect,
        listCheckpointRowsByThread({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadDetailById:listCheckpoints:query",
              "ProjectionSnapshotQuery.getThreadDetailById:listCheckpoints:decodeRows",
            ),
          ),
        ),
        getLatestTurnRowByThread({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadDetailById:getLatestTurn:query",
              "ProjectionSnapshotQuery.getThreadDetailById:getLatestTurn:decodeRow",
            ),
          ),
        ),
        getThreadSessionRowByThread({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadDetailById:getSession:query",
              "ProjectionSnapshotQuery.getThreadDetailById:getSession:decodeRow",
            ),
          ),
        ),
        listThreadMemberRowsByThreadId({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadDetailById:listMembers:query",
              "ProjectionSnapshotQuery.getThreadDetailById:listMembers:decodeRows",
            ),
          ),
        ),
        // T3-CUSTOM(expbkt3): END
      ]);

      if (Option.isNone(threadRow)) {
        return Option.none<OrchestrationThread>();
      }

      const thread = {
        id: threadRow.value.threadId,
        projectId: threadRow.value.projectId,
        title: threadRow.value.title,
        modelSelection: threadRow.value.modelSelection,
        runtimeMode: threadRow.value.runtimeMode,
        interactionMode: threadRow.value.interactionMode,
        branch: threadRow.value.branch,
        worktreePath: threadRow.value.worktreePath,
        sourceControlProfileId: threadRow.value.sourceControlProfileId, // T3-CUSTOM(expbkt3): source-control identity.
        ...mapThreadPullRequests(
          pullRequestRows.map(mapPullRequestRow),
          threadRow.value.projectId,
          pullRequestRows.length === 0
            ? null
            : Option.getOrNull(yield* getProjectShellById(threadRow.value.projectId))
                ?.repositoryIdentity,
        ),
        branchPullRequest: threadRow.value.branchPullRequest,
        latestTurn: Option.isSome(latestTurnRow) ? mapLatestTurn(latestTurnRow.value) : null,
        // T3-CUSTOM(expbkt3): team mode thread ownership/membership.
        ownerUserId: threadRow.value.ownerUserId,
        memberUserIds: memberRows.map((row) => row.userId),
        createdAt: threadRow.value.createdAt,
        updatedAt: threadRow.value.updatedAt,
        archivedAt: threadRow.value.archivedAt,
        settledOverride: threadRow.value.settledOverride,
        settledAt: threadRow.value.settledAt,
        unsettledAt: threadRow.value.unsettledAt,
        snoozedUntil: threadRow.value.snoozedUntil,
        snoozedAt: threadRow.value.snoozedAt,
        // T3-CUSTOM(expbkt3): BEGIN — priority, custom sidebar group, Linear/Mattermost
        // links, and thread lineage (parent thread/environment).
        priority: threadRow.value.priority,
        customGroup: threadRow.value.customGroup ?? null, // T3-CUSTOM(expbkt3): custom sidebar group.
        linearIssueUrl: threadRow.value.linearIssueUrl ?? null,
        mattermostThreadUrl: threadRow.value.mattermostThreadUrl ?? null,
        parentThreadId: threadRow.value.parentThreadId ?? null,
        parentEnvironmentId: threadRow.value.parentEnvironmentId ?? null,
        // T3-CUSTOM(expbkt3): END
        pinnedAt: threadRow.value.pinnedAt,
        pinOrderKey: threadRow.value.pinOrderKey ?? null,
        activeOrderKey: threadRow.value.activeOrderKey ?? null,
        autoSettleDisabledAt: threadRow.value.autoSettleDisabledAt ?? null,
        titleRegeneration: mapTitleRegeneration(threadRow.value),
        titleState: threadRow.value.titleState,
        deletedAt: null,
        messages: messageRows.map((row) => {
          const message = {
            id: row.messageId,
            role: row.role,
            text: row.text,
            turnId: row.turnId,
            streaming: row.isStreaming === 1,
            sentByUserId: row.sentByUserId, // T3-CUSTOM(expbkt3): message sender attribution.
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
          };
          if (row.attachments !== null) {
            Object.assign(message, { attachments: row.attachments });
          }
          if (row.context !== null) {
            Object.assign(message, { context: row.context });
          }
          return message;
        }),
        proposedPlans: proposedPlanRows.map(mapProposedPlanRow),
        activities,
        checkpoints: checkpointRows.map((row) => ({
          turnId: row.turnId,
          checkpointTurnCount: row.checkpointTurnCount,
          checkpointRef: row.checkpointRef,
          status: row.status,
          files: row.files,
          assistantMessageId: row.assistantMessageId,
          completedAt: row.completedAt,
        })),
        session: Option.isSome(sessionRow) ? mapSessionRow(sessionRow.value) : null,
      };

      return Option.some(
        yield* decodeThread(thread).pipe(
          Effect.mapError(
            toPersistenceDecodeError("ProjectionSnapshotQuery.getThreadDetailById:decodeThread"),
          ),
        ),
      );
    });

  const getThreadDetailById: ProjectionSnapshotQueryShape["getThreadDetailById"] = (
    threadId,
    query,
  ) =>
    getThreadDetailByIdBounded(threadId, undefined, {
      mode: "raw",
      ...(query === undefined ? {} : { query }),
    });

  // Bounds pathological fan-out: one user turn that spawned hundreds of
  // subagent turns still pages in bounded chunks, at the cost of splitting the
  // fan-out group across pages (the cursor continues the same group). Also
  // structurally bounds the window scan via the candidates CTE's LIMIT.
  const THREAD_DETAIL_MAX_RAW_TURNS_PER_PAGE = 150;
  // Sentinels for unbounded keyset ends; "~" sorts after any ISO timestamp.
  const ANCHOR_UNBOUNDED = "~";

  const getThreadDetailSnapshot: ProjectionSnapshotQueryShape["getThreadDetailSnapshot"] = (
    threadId,
    window,
  ) =>
    // Read the thread detail and the snapshot sequence within a single
    // transaction so the sequence is consistent with the returned state; a
    // projector update landing between two separate reads could otherwise return
    // a sequence ahead of the thread detail, causing the client to resume from
    // too far and drop events. Window resolution runs inside the same
    // transaction so the page boundary is consistent with the returned rows.
    sql
      .withTransaction(
        Effect.gen(function* () {
          if (window?.turnLimit === undefined) {
            const thread = yield* getThreadDetailByIdBounded(threadId, undefined, {
              mode: "client",
            });
            if (Option.isNone(thread)) {
              return Option.none<OrchestrationThreadDetailSnapshot>();
            }
            const { snapshotSequence } = yield* getSnapshotSequence();
            return Option.some({ snapshotSequence, thread: thread.value });
          }

          // A malformed or foreign-thread cursor falls back to the first page
          // rather than failing: the client's stale cursor after a revert or
          // reconnect should degrade to "reload recent history", not error.
          const decodedCursor =
            window.beforeCursor === undefined
              ? null
              : decodeThreadDetailPageCursor(window.beforeCursor);
          const cursor = decodedCursor?.threadId === threadId ? decodedCursor : null;

          const windowRows = yield* listTurnWindowRows({
            threadId,
            beforeAnchorAt: cursor?.beforeAnchorAt ?? ANCHOR_UNBOUNDED,
            beforeTurnKey: cursor?.beforeTurnId ?? "",
            userTurnLimit: window.turnLimit,
            maxRawTurns: THREAD_DETAIL_MAX_RAW_TURNS_PER_PAGE,
          }).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getThreadDetailSnapshot:listTurnWindow:query",
                "ProjectionSnapshotQuery.getThreadDetailSnapshot:listTurnWindow:decodeRows",
              ),
            ),
          );

          const oldest = windowRows[0];
          const hasMore =
            oldest !== undefined &&
            (yield* listTurnWindowRows({
              threadId,
              beforeAnchorAt: oldest.anchorAt,
              beforeTurnKey: oldest.turnKey,
              userTurnLimit: 1,
              maxRawTurns: 1,
            }).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getThreadDetailSnapshot:probeOlder:query",
                  "ProjectionSnapshotQuery.getThreadDetailSnapshot:probeOlder:decodeRows",
                ),
              ),
            )).length > 0;
          // An empty window (no turns before the cursor, or a thread with no
          // turns at all) still returns thread metadata with empty collections
          // for turn-linked rows; turnless rows are bounded to the same empty
          // range. The first page of a turnless thread stays unwindowed so
          // pre-turn content (e.g. a just-created thread) is not hidden. Once
          // paging reaches the oldest turn, include turnless messages before
          // the first turn, such as history imported from a provider session.
          const bounds: ThreadDetailBounds | undefined =
            oldest === undefined && cursor === null
              ? undefined
              : {
                  minAnchorAt: hasMore ? (oldest?.anchorAt ?? "") : "",
                  minTurnKey: hasMore ? (oldest?.turnKey ?? "") : "",
                  beforeAnchorAt: cursor?.beforeAnchorAt ?? ANCHOR_UNBOUNDED,
                  beforeTurnKey: cursor?.beforeTurnId ?? "",
                };
          // Empty window behind a cursor: nothing older remains.
          const emptyBounds =
            oldest === undefined && cursor !== null
              ? { minAnchorAt: "", minTurnKey: "", beforeAnchorAt: "", beforeTurnKey: "" }
              : undefined;

          const thread = yield* getThreadDetailByIdBounded(threadId, emptyBounds ?? bounds, {
            mode: "client",
          });
          if (Option.isNone(thread)) {
            return Option.none<OrchestrationThreadDetailSnapshot>();
          }

          const { snapshotSequence } = yield* getSnapshotSequence();
          const watermarkRow = yield* getThreadEventWatermarkRow({
            threadId,
            maxSequence: snapshotSequence,
          }).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getThreadDetailSnapshot:threadWatermark:query",
                "ProjectionSnapshotQuery.getThreadDetailSnapshot:threadWatermark:decodeRow",
              ),
            ),
          );
          const threadSequence = Option.match(watermarkRow, {
            onNone: () => 0,
            onSome: (row) => row.threadSequence ?? 0,
          });
          return Option.some({
            snapshotSequence,
            thread: thread.value,
            page: {
              beforeCursor:
                hasMore && oldest !== undefined
                  ? encodeThreadDetailPageCursor({
                      threadId,
                      beforeAnchorAt: oldest.anchorAt,
                      beforeTurnId: oldest.turnKey,
                    })
                  : null,
              hasMore,
              snapshotSequence,
              threadSequence,
            },
          });
        }),
      )
      .pipe(
        Effect.mapError((error) =>
          isPersistenceError(error)
            ? error
            : toPersistenceSqlError("ProjectionSnapshotQuery.getThreadDetailSnapshot:transaction")(
                error,
              ),
        ),
      );

  return {
    getCommandReadModel,
    getUserInputActivity,
    listActivitiesByKind,
    getSnapshot,
    listLatestProposedPlansForActiveThreads, // T3-CUSTOM(expbkt3): bounded startup projection reads.
    // T3-CUSTOM(expbkt3): bounded list/startup projection reads.
    getShellSnapshot,
    listThreadsWithPullRequests,
    getArchivedShellSnapshot,
    getDeletedWorktreeThreads,
    searchThreads,
    getSnapshotSequence,
    getCounts,
    getEventReplayStats,
    getActiveProjectByWorkspaceRoot,
    getProjectShellById,
    getProjectShells,
    getFirstActiveThreadIdByProjectId,
    getImportedAgentSessionSources,
    getThreadCheckpointContext,
    getFullThreadDiffContext,
    getThreadShellById,
    getThreadAccessById,
    listThreadShellsByProjectId,
    getThreadRuntimeContext,
    getTurnStartMessage,
    // T3-CUSTOM(expbkt3): fork-only title-cadence query.
    countThreadUserMessages,
    getThreadDetailById,
    getThreadDetailSnapshot,
  } satisfies ProjectionSnapshotQueryShape;
});

export const OrchestrationProjectionSnapshotQueryLive = Layer.effect(
  ProjectionSnapshotQuery,
  makeProjectionSnapshotQuery,
);
