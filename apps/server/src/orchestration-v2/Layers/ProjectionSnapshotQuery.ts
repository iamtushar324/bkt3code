/** T3-CUSTOM(expbkt3): compatibility reads use V2, with immutable V1 history sidecars. */
import {
  OrchestrationThread,
  OrchestrationProjectShell,
  OrchestrationProject,
  OrchestrationThreadActivity,
  OrchestrationProposedPlan,
} from "@t3tools/contracts/orchestration";
import {
  ThreadId,
  AgentSessionImportSource,
  OrchestrationV2PlanArtifact,
  OrchestrationV2TurnItemJson,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { toPersistenceSqlError } from "../../persistence/Errors.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../Services/ProjectionSnapshotQuery.ts";
import { ProjectionStoreV2 } from "../ProjectionStore.ts";
import { ProjectStoreV2 } from "../ProjectStore.ts";
import { ProjectService } from "../../project/ProjectService.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { ThreadSearch } from "../ThreadSearch.ts";
import { LegacyV1ThreadImporter } from "../legacy/LegacyV1ThreadImporter.ts";
import {
  legacyThreadShell,
  legacyThreadDetail,
  legacyStoredHistory,
  legacyActivities,
  withRetainedActivitySequence,
} from "../legacyProjection.expbkt3.ts";
import { makeForkProviderNameResolver } from "../forkProviderName.expbkt3.ts";

const make = Effect.gen(function* () {
  const projections = yield* ProjectionStoreV2;
  const projects = yield* ProjectStoreV2;
  const projectService = yield* ProjectService;
  const events = yield* OrchestrationEventStore;
  const importer = yield* LegacyV1ThreadImporter;
  const search = yield* ThreadSearch;
  const sql = yield* SqlClient.SqlClient;
  const providerName = yield* makeForkProviderNameResolver;
  const wrap = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.mapError(toPersistenceSqlError("V2 fork compatibility read")));
  const shell = (location: "active" | "archive" = "active", unsettledOnly = false) =>
    wrap(
      Effect.gen(function* () {
        const snapshot = yield* projections.getShellSnapshot({ location, unsettledOnly });
        // The V2 store returns archived rows in `archivedThreads`, never in `threads`.
        const threads = location === "archive" ? snapshot.archivedThreads : snapshot.threads;
        const names = new Map(
          yield* Effect.forEach(
            [...new Set(threads.map((thread) => thread.providerInstanceId))],
            (instanceId) =>
              providerName(instanceId).pipe(Effect.map((driver) => [instanceId, driver] as const)),
            { concurrency: 2 },
          ),
        );
        return {
          snapshotSequence: snapshot.snapshotSequence,
          threads: threads.map((thread) =>
            legacyThreadShell(thread, names.get(thread.providerInstanceId)),
          ),
          projects: (yield* projectService.listShells()).map((project) =>
            Schema.decodeUnknownSync(OrchestrationProjectShell)({
              ...project,
              ownerUserId: project.ownerUserId ?? null,
              memberUserIds: project.memberUserIds ?? [],
            }),
          ),
          updatedAt: DateTime.formatIso(yield* DateTime.now),
        };
      }),
    );
  const detail = (threadId: ThreadId, hydrate = true) =>
    wrap(
      Effect.gen(function* () {
        const thread = yield* projections.getThreadShell(threadId);
        if (thread === null || thread.deletedAt !== null) return Option.none();
        if (hydrate) yield* importer.ensureTranscript(threadId);
        const projection = yield* projections.getThreadProjection(threadId);
        const history = yield* legacyStoredHistory(threadId).pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
        );
        return Option.some(legacyThreadDetail(projection, history));
      }),
    );
  const lightweight = () =>
    shell().pipe(
      Effect.map((snapshot) => ({
        ...snapshot,
        projects: snapshot.projects.map((project) =>
          Schema.decodeUnknownSync(OrchestrationProject)({ ...project, deletedAt: null }),
        ),
        threads: snapshot.threads.map((thread) =>
          Schema.decodeUnknownSync(OrchestrationThread)({
            ...thread,
            deletedAt: null,
            messages: [],
            proposedPlans: [],
            activities: [],
            checkpoints: [],
          }),
        ),
      })),
    );
  const threadShell = (threadId: ThreadId) =>
    wrap(
      projections
        .getThreadShell(threadId)
        .pipe(
          Effect.flatMap((thread) =>
            thread === null || thread.deletedAt !== null
              ? Effect.succeed(Option.none())
              : providerName(thread.providerInstanceId).pipe(
                  Effect.map((driver) => Option.some(legacyThreadShell(thread, driver))),
                ),
          ),
        ),
    );
  const retainedPlanRows = () =>
    wrap(
      sql<{
        threadId: string;
        id: string;
        turnId: string | null;
        planMarkdown: string;
        implementedAt: string | null;
        implementationThreadId: string | null;
        createdAt: string;
        updatedAt: string;
      }>`
    SELECT plan.thread_id AS threadId, plan.plan_id AS id, plan.turn_id AS turnId, plan.plan_markdown AS planMarkdown, plan.implemented_at AS implementedAt, plan.implementation_thread_id AS implementationThreadId, plan.created_at AS createdAt, plan.updated_at AS updatedAt FROM projection_thread_proposed_plans plan INNER JOIN orchestration_v2_projection_threads thread ON thread.thread_id = plan.thread_id WHERE thread.deleted_at IS NULL AND thread.archived_at IS NULL AND plan.created_at = (SELECT MAX(other.created_at) FROM projection_thread_proposed_plans other WHERE other.thread_id = plan.thread_id)
  `.pipe(
        Effect.map((rows) =>
          rows.map((row) => ({
            threadId: ThreadId.make(row.threadId),
            proposedPlan: Schema.decodeUnknownSync(OrchestrationProposedPlan)(row),
          })),
        ),
      ),
    );
  const retainedActivityRows = (kind: string) =>
    wrap(
      sql<{
        id: string;
        tone: string;
        kind: string;
        summary: string;
        payload: string;
        turnId: string | null;
        sequence: number | null;
        createdAt: string;
      }>`
    SELECT activity.activity_id AS id, activity.tone, activity.kind, activity.summary, activity.payload_json AS payload, activity.turn_id AS turnId, activity.sequence, activity.created_at AS createdAt FROM projection_thread_activities activity INNER JOIN orchestration_v2_projection_threads thread ON thread.thread_id = activity.thread_id WHERE activity.kind = ${kind} AND thread.deleted_at IS NULL AND thread.archived_at IS NULL ORDER BY activity.sequence ASC
  `.pipe(
        Effect.map((rows) =>
          rows.map((row) =>
            Schema.decodeUnknownSync(OrchestrationThreadActivity)({
              ...row,
              sequence: row.sequence ?? undefined,
              payload: JSON.parse(row.payload),
            }),
          ),
        ),
      ),
    );
  const planRows = () =>
    wrap(
      Effect.gen(function* () {
        const retained = yield* retainedPlanRows();
        const rows = yield* sql<{
          payload_json: string;
          updated_at: string;
          created_at: string;
        }>`SELECT plan.payload_json, thread.updated_at, COALESCE(node.started_at,thread.created_at) AS created_at FROM orchestration_v2_projection_plans plan INNER JOIN orchestration_v2_projection_threads thread ON thread.thread_id=plan.thread_id LEFT JOIN orchestration_v2_projection_nodes node ON node.node_id=plan.node_id WHERE plan.kind='proposed_plan' AND thread.deleted_at IS NULL AND thread.archived_at IS NULL`;
        const native = yield* Effect.forEach(rows, (row) =>
          Schema.decodeUnknownEffect(Schema.fromJsonString(OrchestrationV2PlanArtifact))(
            row.payload_json,
          ).pipe(
            Effect.map((plan) => {
              if (plan.kind !== "proposed_plan") return undefined;
              const original = retained.find(
                (item) => item.proposedPlan.id === plan.id,
              )?.proposedPlan;
              return {
                threadId: plan.threadId,
                proposedPlan: Schema.decodeUnknownSync(OrchestrationProposedPlan)({
                  ...original,
                  id: plan.id,
                  turnId: plan.runId,
                  planMarkdown: plan.markdown,
                  implementedAt:
                    plan.status === "completed"
                      ? (original?.implementedAt ?? row.updated_at)
                      : null,
                  implementationThreadId: original?.implementationThreadId ?? null,
                  createdAt: original?.createdAt ?? row.created_at,
                  updatedAt: original?.updatedAt ?? row.updated_at,
                }),
              };
            }),
          ),
        );
        const latest = new Map<ThreadId, (typeof retained)[number]>();
        for (const item of [...retained, ...native.filter((item) => item !== undefined)]) {
          const previous = latest.get(item.threadId);
          if (
            previous === undefined ||
            item.proposedPlan.createdAt >= previous.proposedPlan.createdAt
          )
            latest.set(item.threadId, item);
        }
        return [...latest.values()];
      }),
    );
  const activityRows = (kind: string) =>
    wrap(
      Effect.gen(function* () {
        const retained = yield* retainedActivityRows(kind);
        const rows = yield* sql<{
          payload_json: string;
        }>`SELECT item.payload_json FROM orchestration_v2_projection_turn_items item INNER JOIN orchestration_v2_projection_threads thread ON thread.thread_id=item.thread_id WHERE thread.deleted_at IS NULL AND thread.archived_at IS NULL AND (json_extract(item.payload_json,'$.input.forkLegacyActivity.kind')=${kind} OR (${kind}='user-input.requested' AND item.type='user_input_request') OR (${kind}='approval.requested' AND item.type='approval_request')) ORDER BY item.updated_at ASC,item.ordinal ASC`;
        const items = yield* Effect.forEach(rows, (row) =>
          Schema.decodeUnknownEffect(Schema.fromJsonString(OrchestrationV2TurnItemJson))(
            row.payload_json,
          ),
        );
        const retainedById = new Map(retained.map((activity) => [activity.id, activity]));
        const native = legacyActivities({ turnItems: items }).map((activity) =>
          withRetainedActivitySequence(activity, retainedById.get(activity.id)),
        );
        return [
          ...retained.filter((item) => !native.some((activity) => activity.id === item.id)),
          ...native,
        ];
      }),
    );
  const checkpointContext = (threadId: ThreadId) =>
    detail(threadId).pipe(
      Effect.flatMap((thread) => {
        if (Option.isNone(thread)) return Effect.succeed(Option.none());
        const value = thread.value;
        return wrap(projects.get(value.projectId)).pipe(
          Effect.map(
            Option.map((project) => ({
              threadId,
              projectId: value.projectId,
              workspaceRoot: project.workspaceRoot,
              worktreePath: value.worktreePath,
              checkpoints: value.checkpoints,
            })),
          ),
        );
      }),
    );
  const service: ProjectionSnapshotQueryShape = {
    getCommandReadModel: lightweight,
    getSnapshot: () =>
      lightweight().pipe(
        Effect.flatMap((snapshot) =>
          Effect.forEach(snapshot.threads, (thread) => detail(thread.id), { concurrency: 2 }).pipe(
            Effect.map((threads) => ({
              ...snapshot,
              threads: threads.flatMap((thread) => (Option.isSome(thread) ? [thread.value] : [])),
            })),
          ),
        ),
      ),
    getShellSnapshot: (options) => shell("active", options?.unsettledOnly),
    getArchivedShellSnapshot: () => shell("archive"),
    getThreadShellById: threadShell,
    getThreadDetailById: (threadId, query) =>
      detail(threadId).pipe(
        Effect.map(
          Option.map((thread) =>
            query?.activityKinds === undefined
              ? thread
              : {
                  ...thread,
                  activities: thread.activities.filter((activity) =>
                    query.activityKinds?.includes(activity.kind),
                  ),
                },
          ),
        ),
      ),
    getThreadDetailSnapshot: (threadId) =>
      wrap(
        Effect.gen(function* () {
          yield* importer.ensureTranscript(threadId);
          return yield* sql.withTransaction(
            Effect.gen(function* () {
              const thread = yield* detail(threadId, false);
              if (Option.isNone(thread)) return Option.none();
              return Option.some({
                snapshotSequence: yield* events.latestApplicationSequence,
                thread: thread.value,
              });
            }),
          );
        }),
      ),
    getThreadRuntimeContext: (threadId) =>
      threadShell(threadId).pipe(
        Effect.map(
          Option.map(({ id, projectId, title, titleState, session }) => ({
            id,
            projectId,
            title,
            titleState,
            session,
          })),
        ),
      ),
    getProjectShellById: (projectId) =>
      wrap(
        projectService.getShell(projectId).pipe(
          Effect.map(
            Option.map((project) =>
              Schema.decodeUnknownSync(OrchestrationProjectShell)({
                ...project,
                ownerUserId: project.ownerUserId ?? null,
                memberUserIds: project.memberUserIds ?? [],
              }),
            ),
          ),
        ),
      ),
    getProjectShells: (projectIds) =>
      wrap(
        projectService.listShells(projectIds === undefined ? undefined : { projectIds }).pipe(
          Effect.map((items) =>
            items.map((project) =>
              Schema.decodeUnknownSync(OrchestrationProjectShell)({
                ...project,
                ownerUserId: project.ownerUserId ?? null,
                memberUserIds: project.memberUserIds ?? [],
              }),
            ),
          ),
        ),
      ),
    getActiveProjectByWorkspaceRoot: (workspaceRoot) =>
      wrap(
        projects.findActiveByWorkspaceRoot(workspaceRoot).pipe(
          Effect.map(
            Option.map((project) =>
              Schema.decodeUnknownSync(OrchestrationProject)({
                ...project,
                id: project.projectId,
              }),
            ),
          ),
        ),
      ),
    getThreadAccessById: (threadId) =>
      wrap(
        projections.getThreadShell(threadId).pipe(
          Effect.map((thread) =>
            thread === null || thread.deletedAt !== null
              ? Option.none()
              : Option.some({
                  threadId,
                  projectId: thread.projectId,
                  ownerUserId: thread.ownerUserId ?? null,
                  memberUserIds: thread.memberUserIds ?? [],
                }),
          ),
        ),
      ),
    listThreadShellsByProjectId: (projectId) =>
      shell().pipe(
        Effect.map((snapshot) =>
          snapshot.threads.filter((thread) => thread.projectId === projectId),
        ),
      ),
    getFirstActiveThreadIdByProjectId: (projectId) =>
      shell().pipe(
        Effect.map((snapshot) =>
          Option.fromUndefinedOr(
            snapshot.threads.find((thread) => thread.projectId === projectId)?.id,
          ),
        ),
      ),
    listThreadsWithPullRequests: () =>
      shell().pipe(
        Effect.map((snapshot) =>
          snapshot.threads.filter((thread) => thread.pullRequests.length > 0),
        ),
      ),
    listLatestProposedPlansForActiveThreads: planRows,
    listActivitiesByKind: activityRows,
    getUserInputActivity: ({ threadId, requestId }) =>
      detail(threadId).pipe(
        Effect.map((thread) =>
          Option.isNone(thread)
            ? Option.none()
            : Option.fromUndefinedOr(
                thread.value.activities.findLast(
                  (activity) =>
                    Predicate.isObject(activity.payload) &&
                    "requestId" in activity.payload &&
                    activity.payload.requestId === requestId,
                ),
              ),
        ),
      ),
    getTurnStartMessage: ({ threadId, messageId }) =>
      detail(threadId).pipe(
        Effect.map((thread) =>
          Option.isNone(thread)
            ? Option.none()
            : Option.fromUndefinedOr(
                thread.value.messages.find((message) => message.id === messageId),
              ).pipe(
                Option.map((message) => ({
                  message,
                  hasOtherUserMessages: thread.value.messages.some(
                    (other) => other.role === "user" && other.id !== messageId,
                  ),
                })),
              ),
        ),
      ),
    countThreadUserMessages: (threadId) =>
      wrap(
        projections
          .getThreadRecords(threadId, ["messages"], { messageRoles: ["user"] })
          .pipe(Effect.map((projection) => projection.messages.length)),
      ),
    getThreadCheckpointContext: checkpointContext,
    getFullThreadDiffContext: (threadId, toTurnCount) =>
      checkpointContext(threadId).pipe(
        Effect.map(
          Option.map((context) => ({
            ...context,
            latestCheckpointTurnCount: context.checkpoints.at(-1)?.checkpointTurnCount ?? 0,
            toCheckpointRef:
              context.checkpoints.find(
                (checkpoint) => checkpoint.checkpointTurnCount === toTurnCount,
              )?.checkpointRef ?? null,
          })),
        ),
      ),
    getSnapshotSequence: () =>
      wrap(
        events.latestApplicationSequence.pipe(
          Effect.map((snapshotSequence) => ({ snapshotSequence })),
        ),
      ),
    getCounts: () =>
      shell().pipe(
        Effect.map((snapshot) => ({
          projectCount: snapshot.projects.length,
          threadCount: snapshot.threads.length,
        })),
      ),
    getEventReplayStats: ({ fromSequenceExclusive, toSequenceInclusive }) =>
      wrap(
        sql<{
          eventCount: number;
          payloadBytes: number;
        }>`SELECT COUNT(*) AS eventCount, COALESCE(SUM(length(payload_json)),0) AS payloadBytes FROM orchestration_events WHERE sequence > ${fromSequenceExclusive} AND sequence <= ${toSequenceInclusive}`.pipe(
          Effect.map((rows) => rows[0] ?? { eventCount: 0, payloadBytes: 0 }),
        ),
      ),
    searchThreads: (input) => wrap(search.search(input)),
    getImportedAgentSessionSources: (projectId) =>
      wrap(
        sql<{
          threadId: string;
          source: string;
        }>`SELECT thread.thread_id AS threadId, runtime.runtime_payload_json AS source FROM orchestration_v2_projection_threads thread INNER JOIN provider_session_runtime runtime ON runtime.thread_id = thread.thread_id WHERE thread.project_id = ${projectId}`.pipe(
          Effect.map((rows) =>
            rows.flatMap((row) => {
              const payload: unknown = JSON.parse(row.source);
              if (
                !Predicate.isObject(payload) ||
                !("importedTranscripts" in payload) ||
                !Array.isArray(payload.importedTranscripts)
              )
                return [];
              return payload.importedTranscripts.flatMap((entry: unknown) => {
                const source = Schema.decodeUnknownOption(AgentSessionImportSource)(entry);
                return Option.isSome(source)
                  ? [{ threadId: ThreadId.make(row.threadId), source: source.value }]
                  : [];
              });
            }),
          ),
        ),
      ),
    getDeletedWorktreeThreads: () =>
      wrap(
        sql<{
          id: string;
          projectId: string;
          branch: string;
          worktreePath: string;
          workspaceRoot: string;
          deletedAt: string;
        }>`SELECT thread.thread_id AS id, thread.project_id AS projectId, json_extract(thread.payload_json,'$.branch') AS branch, json_extract(thread.payload_json,'$.worktreePath') AS worktreePath, project.workspace_root AS workspaceRoot, thread.deleted_at AS deletedAt FROM orchestration_v2_projection_threads thread INNER JOIN projection_projects project ON project.project_id = thread.project_id WHERE thread.deleted_at IS NOT NULL AND json_extract(thread.payload_json,'$.worktreePath') IS NOT NULL`.pipe(
          Effect.map((rows) =>
            rows.map((row) => ({
              ...row,
              id: ThreadId.make(row.id),
              projectId: Schema.decodeUnknownSync(OrchestrationThread.fields.projectId)(
                row.projectId,
              ),
            })),
          ),
        ),
      ),
  };
  return service;
});
export const ProjectionSnapshotQueryLive = Layer.effect(ProjectionSnapshotQuery, make);
