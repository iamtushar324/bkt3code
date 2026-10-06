import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import { ProjectionSnapshotQueryLive } from "../orchestration-v2/Layers/ProjectionSnapshotQuery.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import { OrchestrationEngineService } from "../orchestration-v2/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration-v2/Services/ProjectionSnapshotQuery.ts";
import { ThreadSearch } from "../orchestration-v2/ThreadSearch.ts";
import * as LegacyV1ThreadImporter from "../orchestration-v2/legacy/LegacyV1ThreadImporter.ts";
import { legacyActivities } from "../orchestration-v2/legacyProjection.expbkt3.ts";
import { layer as OrchestrationEventStoreLive } from "../persistence/OrchestrationEventStore.ts";
import { layerMemory as SqlitePersistenceMemory } from "../persistence/Sqlite.ts";
import * as PlanReviewDocuments from "../persistence/PlanReviewDocuments.ts";
import { ProjectService } from "../project/ProjectService.ts";
import * as PlanIngestListener from "./PlanIngestListener.ts";
import * as PlanReviewService from "./PlanReviewService.ts";

const stores = Layer.mergeAll(EventStore.layer, ProjectionStore.layer, ProjectStore.layer).pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
);
const importer = LegacyV1ThreadImporter.layer.pipe(
  Layer.provideMerge(EventSink.layer.pipe(Layer.provideMerge(stores))),
);
const query = ProjectionSnapshotQueryLive.pipe(
  Layer.provide(
    Layer.mergeAll(
      OrchestrationEventStoreLive,
      Layer.mock(ProjectService)({}),
      Layer.mock(ThreadSearch)({}),
    ),
  ),
  Layer.provideMerge(importer),
);
const engine = Layer.mock(OrchestrationEngineService)({ streamDomainEvents: Stream.empty });
const reviews = PlanReviewService.layer.pipe(
  Layer.provideMerge(PlanReviewDocuments.layer),
  Layer.provideMerge(query),
  Layer.provide(engine),
  Layer.provide(NodeServices.layer),
);
const TestLayer = PlanIngestListener.layer.pipe(Layer.provideMerge(reviews), Layer.provide(engine));

it.layer(TestLayer)("legacy activity sequence plan capture", (it) => {
  it.effect(
    "captures plans with unsequenced history and preserves original cursors across native dedup",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const legacyImporter = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
        const snapshots = yield* ProjectionSnapshotQuery;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const repository = yield* PlanReviewDocuments.PlanReviewRepository;
        const listener = yield* PlanIngestListener.PlanIngestListener;
        const threadId = ThreadId.make("thread:legacy-plan-sequence");
        const markdown = "# Preserve the legacy plan\n\nKeep its full content and review history.";
        yield* sql`INSERT INTO projection_projects (project_id,title,workspace_root,scripts_json,created_at,updated_at,deleted_at) VALUES ('project:legacy-sequence','Legacy sequence','/tmp/legacy-sequence','[]','2026-01-01T00:00:00Z','2026-01-02T00:00:00Z',NULL)`;
        yield* sql`INSERT INTO projection_threads (thread_id,project_id,title,model_selection_json,runtime_mode,interaction_mode,created_at,updated_at,deleted_at) VALUES (${threadId},'project:legacy-sequence','Legacy plan','{"instanceId":"codex","model":"gpt-5.4"}','full-access','default','2026-01-01T00:00:00Z','2026-01-02T00:00:00Z',NULL)`;
        for (const [id, sequence] of [
          ["activity:null", null],
          ["activity:zero", 0],
          ["activity:cursor", 42],
        ] as const) {
          yield* sql`INSERT INTO projection_thread_activities (activity_id,thread_id,tone,kind,summary,payload_json,sequence,created_at) VALUES (${id},${threadId},'info','context-window.updated','Retained context','{"currentTokens":21}',${sequence},'2026-01-01T01:00:00Z')`;
        }
        yield* sql`INSERT INTO projection_thread_proposed_plans (plan_id,thread_id,plan_markdown,created_at,updated_at) VALUES ('plan:legacy-sequence',${threadId},${markdown},'2026-01-01T02:00:00Z','2026-01-01T02:00:00Z')`;
        yield* legacyImporter.reconcileShells;

        // This reads retained SQL rows before the transcript is hydrated.
        const retained = yield* snapshots.listActivitiesByKind("context-window.updated");
        assert.equal(
          retained.find((activity) => activity.id === "activity:null")?.sequence,
          undefined,
        );
        assert.equal(retained.find((activity) => activity.id === "activity:zero")?.sequence, 0);
        assert.equal(retained.find((activity) => activity.id === "activity:cursor")?.sequence, 42);

        const candidates = yield* snapshots.listLatestProposedPlansForActiveThreads();
        const candidate = candidates.find((plan) => plan.threadId === threadId);
        assert.isDefined(candidate);
        if (candidate === undefined) return;
        // Exercise the real listener, detail adapter, service and SQLite repository.
        yield* listener.ingest(candidate);
        const document = yield* repository.findDocumentBySourcePlanId(candidate.proposedPlan.id);
        assert.isTrue(Option.isSome(document));
        if (Option.isNone(document)) return;
        yield* listener.ingest(candidate);
        const versions = yield* repository.listVersions(document.value.documentId);
        assert.equal(versions.length, 1);
        assert.equal(versions[0]?.contentMarkdown, markdown);
        assert.equal(versions[0]?.sourcePlanId, "plan:legacy-sequence");

        const imported = legacyActivities(yield* projections.getThreadProjection(threadId));
        assert.equal(imported.find((activity) => activity.id === "activity:zero")?.sequence, 0);
        assert.equal(imported.find((activity) => activity.id === "activity:cursor")?.sequence, 42);
        // Older V2 imports omitted the cursor. Read adapters must recover it from V1.
        yield* sql`UPDATE orchestration_v2_projection_turn_items SET payload_json=json_remove(payload_json,'$.input.forkLegacyActivity.sequence') WHERE thread_id=${threadId} AND json_extract(payload_json,'$.input.forkLegacyActivity.id')='activity:cursor'`;
        const nativeWithoutCursor = legacyActivities(
          yield* projections.getThreadProjection(threadId),
        );
        assert.equal(
          nativeWithoutCursor.find((activity) => activity.id === "activity:cursor")?.sequence,
          undefined,
        );
        const detail = yield* snapshots.getThreadDetailById(threadId);
        assert.isTrue(Option.isSome(detail));
        if (Option.isNone(detail)) return;
        assert.equal(
          detail.value.activities.filter((activity) => activity.kind === "context-window.updated")
            .length,
          3,
        );
        assert.equal(detail.value.proposedPlans[0]?.planMarkdown, markdown);
        assert.equal(
          detail.value.activities.find((activity) => activity.id === "activity:null")?.sequence,
          undefined,
        );
        assert.equal(
          detail.value.activities.find((activity) => activity.id === "activity:zero")?.sequence,
          0,
        );
        assert.equal(
          detail.value.activities.find((activity) => activity.id === "activity:cursor")?.sequence,
          42,
        );
        const deduplicated = yield* snapshots.listActivitiesByKind("context-window.updated");
        assert.equal(deduplicated.length, 3);
        assert.equal(
          deduplicated.find((activity) => activity.id === "activity:cursor")?.sequence,
          42,
        );
        assert.deepStrictEqual(
          yield* sql`SELECT sequence FROM projection_thread_activities WHERE activity_id='activity:null'`,
          [{ sequence: null }],
        );
      }),
  );
});
