// T3-CUSTOM(expbkt3): retained BK behavior at the native V2 boundary.
import { assert, it } from "@effect/vitest";
import { ThreadId, UserId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as EventSink from "../EventSink.ts";
import * as EventStore from "../EventStore.ts";
import * as ProjectionStore from "../ProjectionStore.ts";
import * as LegacyV1ThreadImporter from "./LegacyV1ThreadImporter.ts";
import { legacyActivities } from "../legacyProjection.expbkt3.ts";

const stores = Layer.mergeAll(EventStore.layer, ProjectionStore.layer).pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
);
const sink = EventSink.layer.pipe(Layer.provideMerge(stores));
const TestLayer = LegacyV1ThreadImporter.layer.pipe(Layer.provideMerge(sink));
it.layer(TestLayer)("fork V1 cutover", (it) => {
  it.effect(
    "retains owners, senders, native cursor, plans, raw activities and checkpoint files once",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const importer = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const threadId = ThreadId.make("thread:fork-legacy");
        yield* sql`INSERT INTO projection_projects (project_id,title,workspace_root,default_model_selection_json,scripts_json,created_at,updated_at,deleted_at,owner_user_id) VALUES ('project:legacy','Legacy','/tmp/fork-legacy','{"instanceId":"codex","model":"gpt-5.4"}','[]','2026-01-01T00:00:00Z','2026-01-02T00:00:00Z',NULL,'user:owner')`;
        yield* sql`INSERT INTO projection_threads (thread_id,project_id,title,model_selection_json,runtime_mode,interaction_mode,branch,worktree_path,created_at,updated_at,deleted_at,title_manually_set,owner_user_id,priority,custom_group,source_control_profile_id,linear_issue_url,mattermost_thread_url) VALUES (${threadId},'project:legacy','Retained session','{"instanceId":"codex","model":"gpt-5.4"}','full-access','default','main',NULL,'2026-01-01T00:00:00Z','2026-01-02T00:00:00Z',NULL,1,'user:owner',1,'Sprint 42','profile-owner','https://linear.app/test/issue/TEC-1','https://chat.example/thread')`;
        yield* sql`INSERT INTO projection_thread_members (thread_id,user_id,added_by_user_id,added_at) VALUES (${threadId},'user:member','user:owner','2026-01-01T00:00:00Z')`;
        yield* sql`INSERT INTO projection_thread_messages (message_id,thread_id,turn_id,role,text,is_streaming,created_at,updated_at,sent_by_user_id) VALUES ('message:legacy',${threadId},'turn:legacy','user','Keep the fork',0,'2026-01-01T01:00:00Z','2026-01-01T01:00:00Z','user:member')`;
        yield* sql`INSERT INTO projection_thread_messages (message_id,thread_id,turn_id,role,text,is_streaming,created_at,updated_at) VALUES ('reasoning:legacy',${threadId},'turn:legacy','reasoning','Preserve the reasoning',0,'2026-01-01T01:00:30Z','2026-01-01T01:00:30Z')`;
        yield* sql`INSERT INTO projection_turns (thread_id,turn_id,pending_message_id,state,requested_at,started_at,completed_at,checkpoint_turn_count,checkpoint_ref,checkpoint_status,checkpoint_files_json) VALUES (${threadId},'turn:legacy','message:legacy','completed','2026-01-01T01:00:00Z','2026-01-01T01:00:01Z','2026-01-01T01:02:00Z',1,'refs/t3/checkpoint/legacy','ready','[{"path":"fork.ts","kind":"modified","additions":3,"deletions":1}]')`;
        yield* sql`INSERT INTO projection_thread_activities (activity_id,thread_id,turn_id,tone,kind,summary,payload_json,sequence,created_at) VALUES ('activity:legacy',${threadId},'turn:legacy','tool','tool.completed','Retained UI','{"t3Ui":{"uiId":"ui:legacy"},"output":"full payload"}',10,'2026-01-01T01:01:00Z')`;
        yield* sql`INSERT INTO projection_thread_activities (activity_id,thread_id,turn_id,tone,kind,summary,payload_json,sequence,created_at) VALUES ('question:legacy',${threadId},'turn:legacy','approval','user-input.requested','Pending question','{"requestId":"question:legacy","responseMode":"message"}',11,'2026-01-01T01:01:01Z')`;
        yield* sql`INSERT INTO projection_thread_proposed_plans (plan_id,thread_id,turn_id,plan_markdown,created_at,updated_at) VALUES ('plan:legacy',${threadId},'turn:legacy','# Retained plan','2026-01-01T01:01:30Z','2026-01-01T01:01:30Z')`;
        yield* sql`INSERT INTO projection_thread_sessions (thread_id,status,provider_name,provider_session_id,provider_thread_id,active_turn_id,last_error,updated_at) VALUES (${threadId},'ready','codex','process:old','conversation:legacy',NULL,NULL,'2026-01-02T00:00:00Z')`;
        yield* importer.reconcileShells;
        assert.equal((yield* projections.getThreadShell(threadId))?.hasPendingAsyncUserInput, true);
        yield* importer.ensureTranscript(threadId);
        const projection = yield* projections.getThreadProjection(threadId);
        assert.equal(projection.thread.ownerUserId, UserId.make("user:owner"));
        assert.include(projection.thread.memberUserIds ?? [], UserId.make("user:member"));
        assert.equal(projection.thread.sourceControlProfileId, "profile-owner");
        assert.equal(projection.thread.priority, 1);
        assert.equal(projection.thread.titleManuallySet, true);
        assert.equal(
          projection.turnItems.find((item) => item.type === "reasoning")?.type,
          "reasoning",
        );
        assert.equal(projection.thread.customGroup, "Sprint 42");
        assert.equal(projection.messages[0]?.sentByUserId, "user:member");
        assert.equal(
          projection.providerThreads[0]?.nativeThreadRef?.nativeId,
          "conversation:legacy",
        );
        assert.equal(projection.providerThreads[0]?.providerSessionId, null);
        assert.equal(projection.runs[0]?.status, "completed");
        assert.equal(projection.plans[0]?.kind, "proposed_plan");
        assert.deepStrictEqual(projection.checkpoints[0]?.files, [
          { path: "fork.ts", kind: "modified", additions: 3, deletions: 1 },
        ]);
        assert.equal(projection.checkpoints[0]?.ref, "refs/t3/checkpoint/legacy");
        assert.equal(projection.checkpointScopes[0]?.cwd, "/tmp/fork-legacy");
        assert.deepStrictEqual(
          legacyActivities(projection).find((activity) => activity.id === "activity:legacy")
            ?.payload,
          { t3Ui: { uiId: "ui:legacy" }, output: "full payload" },
        );
        const before = yield* sql<{
          count: number;
        }>`SELECT COUNT(*) AS count FROM orchestration_events WHERE application_event_version=2 AND stream_id=${threadId}`;
        yield* importer.reconcileShells;
        yield* importer.ensureTranscript(threadId);
        const after = yield* sql<{
          count: number;
        }>`SELECT COUNT(*) AS count FROM orchestration_events WHERE application_event_version=2 AND stream_id=${threadId}`;
        assert.deepStrictEqual(after, before);
        const retained = yield* sql<{
          count: number;
        }>`SELECT COUNT(*) AS count FROM projection_thread_proposed_plans WHERE thread_id=${threadId}`;
        assert.equal(retained[0]?.count, 1);
      }),
  );
});
