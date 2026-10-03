/** T3-CUSTOM(expbkt3): legacy resume boundaries must retain the provider's native protocol. */
import { assert, it } from "@effect/vitest";
import { ProviderDriverKind, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as LegacyV1ThreadImporter from "./legacy/LegacyV1ThreadImporter.ts";

const stores = Layer.mergeAll(EventStore.layer, ProjectionStore.layer).pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
);
const sink = EventSink.layer.pipe(Layer.provideMerge(stores));
const TestLayer = LegacyV1ThreadImporter.layer.pipe(Layer.provideMerge(sink));

it.layer(TestLayer)("fork legacy provider resume", (it) => {
  it.effect("imports the current Claude SDK boundary and never guesses from old T3 turn IDs", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const importer = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
      const projection = yield* ProjectionStore.ProjectionStoreV2;
      yield* sql`INSERT INTO projection_projects (project_id,title,workspace_root,default_model_selection_json,scripts_json,created_at,updated_at,deleted_at) VALUES ('project:cursor','Cursor','/tmp/legacy-cursor','{"instanceId":"claudeAgent","model":"claude-sonnet-4-6"}','[]','2026-01-01T00:00:00Z','2026-01-02T00:00:00Z',NULL)`;
      const cases = [
        {
          id: "claude-current",
          driver: "claudeAgent",
          selection: '{"instanceId":"claudeAgent","model":"claude-sonnet-4-6"}',
          nativeId: "68a509ca-01c9-4bfe-8fbb-73515e41db0a",
          cursor:
            '{"resume":"68a509ca-01c9-4bfe-8fbb-73515e41db0a","resumeSessionAt":"d8787ef0-ad63-49db-b8d5-2b6561744bcb","turnStartMessageIds":["old-t3-random-turn-id",null]}',
          head: "d8787ef0-ad63-49db-b8d5-2b6561744bcb",
        },
        {
          id: "claude-without-boundary",
          driver: "claudeAgent",
          selection: '{"instanceId":"claudeAgent","model":"claude-sonnet-4-6"}',
          nativeId: "9099e3a7-c8b3-4057-ab2e-824a664f8e97",
          cursor:
            '{"resume":"9099e3a7-c8b3-4057-ab2e-824a664f8e97","turnStartMessageIds":["old-t3-random-turn-id"]}',
          head: null,
        },
        {
          id: "codex-cursor",
          driver: "codex",
          selection: '{"instanceId":"codex","model":"gpt-5.4"}',
          nativeId: "native-codex-thread",
          cursor: '{"threadId":"native-codex-thread","resumeSessionAt":"unrelated-id"}',
          head: null,
        },
      ];
      for (const item of cases) {
        const threadId = ThreadId.make(`thread:${item.id}`);
        yield* sql`INSERT INTO projection_threads (thread_id,project_id,title,model_selection_json,runtime_mode,interaction_mode,branch,worktree_path,created_at,updated_at,deleted_at) VALUES (${threadId},'project:cursor',${item.id},${item.selection},'full-access','default',NULL,NULL,'2026-01-01T00:00:00Z','2026-01-02T00:00:00Z',NULL)`;
        yield* sql`INSERT INTO provider_session_runtime (thread_id,provider_name,adapter_key,runtime_mode,status,last_seen_at,resume_cursor_json,runtime_payload_json) VALUES (${threadId},${item.driver},${item.driver},'full-access','stopped','2026-01-02T00:00:00Z',${item.cursor},NULL)`;
      }
      yield* importer.reconcileShells;
      for (const item of cases) {
        const records = yield* projection.getThreadRecords(ThreadId.make(`thread:${item.id}`), [
          "providerThreads",
        ]);
        const providerThread = records.providerThreads[0];
        assert.isDefined(providerThread);
        assert.equal(providerThread!.providerSessionId, null);
        assert.equal(providerThread!.status, "not_loaded");
        assert.equal(providerThread!.nativeThreadRef?.nativeId, item.nativeId);
        assert.deepStrictEqual(
          providerThread!.nativeConversationHeadRef,
          item.head === null
            ? null
            : {
                driver: ProviderDriverKind.make("claudeAgent"),
                nativeId: item.head,
                strength: "weak",
              },
        );
      }
    }),
  );
});
