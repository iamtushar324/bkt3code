import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { EventId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as Tracer from "effect/Tracer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";

import { layer as OrchestrationEventStoreLive } from "../../persistence/OrchestrationEventStore.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import { ProjectService } from "../../project/ProjectService.ts";
import * as EventSink from "../EventSink.ts";
import * as EventStore from "../EventStore.ts";
import * as LegacyV1ThreadImporter from "../legacy/LegacyV1ThreadImporter.ts";
import * as ProjectionStore from "../ProjectionStore.ts";
import * as ProjectStore from "../ProjectStore.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { ThreadSearch } from "../ThreadSearch.ts";
import { ProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";

// t3_get_session reads a whole session through getThreadDetailSnapshot. That read
// takes seconds on a large session, so it must not hold the writer or the event loop.

const threadId = ThreadId.make("thread:legacy-detail-snapshot");

/** The connection a statement ran on: its own span, or the transaction span above it. */
const connectionOf = (span: Tracer.Span): unknown => {
  let current: Tracer.AnySpan | undefined = span;
  while (current !== undefined) {
    if (current._tag === "Span") {
      const connection = current.attributes.get("db.connection");
      if (connection !== undefined) return connection;
    }
    current = current._tag === "Span" ? Option.getOrUndefined(current.parent) : undefined;
  }
  return undefined;
};

const withSnapshotQuery = <A, E>(
  use: Effect.Effect<
    A,
    E,
    ProjectionSnapshotQuery | LegacyV1ThreadImporter.LegacyV1ThreadImporter | SqlClient.SqlClient
  >,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-detail-snapshot-" });
    const stores = Layer.mergeAll(EventStore.layer, ProjectionStore.layer, ProjectStore.layer).pipe(
      Layer.provideMerge(SqlitePersistence.layerFromPath(path.join(directory, "state.sqlite"))),
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
    return yield* use.pipe(Effect.provide(query));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

it.effect("imports a v1 transcript on the writer, then reads the session on the reader", () =>
  withSnapshotQuery(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const legacyImporter = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
      const snapshots = yield* ProjectionSnapshotQuery;
      yield* sql`INSERT INTO projection_projects (project_id,title,workspace_root,scripts_json,created_at,updated_at,deleted_at) VALUES ('project:detail-snapshot','Detail snapshot','/tmp/detail-snapshot','[]','2026-01-01T00:00:00Z','2026-01-02T00:00:00Z',NULL)`;
      yield* sql`INSERT INTO projection_threads (thread_id,project_id,title,model_selection_json,runtime_mode,interaction_mode,created_at,updated_at,deleted_at) VALUES (${threadId},'project:detail-snapshot','Legacy session','{"instanceId":"codex","model":"gpt-5.4"}','full-access','default','2026-01-01T00:00:00Z','2026-01-02T00:00:00Z',NULL)`;
      yield* sql`INSERT INTO projection_thread_activities (activity_id,thread_id,tone,kind,summary,payload_json,sequence,created_at) VALUES ('activity:legacy',${threadId},'info','context-window.updated','Retained context','{"currentTokens":21}',7,'2026-01-01T01:00:00Z')`;
      yield* legacyImporter.reconcileShells;

      // Read each span's connection after the call: a statement outside a
      // transaction is tagged when it takes its connection, after the transformer.
      const recordStatements = <A, E, R>(effect: Effect.Effect<A, E, R>) => {
        const spans: Array<{ readonly query: string; readonly span: Tracer.Span }> = [];
        const record: Statement.Transformer = (statement, _sql, _fiber, span) => {
          spans.push({ query: statement.compile()[0], span });
          return Effect.succeed(statement);
        };
        return effect.pipe(
          Effect.provideService(Statement.CurrentTransformer, record),
          Effect.provideService(Statement.SpanPropagationEnabled, true),
          Effect.map((value) => ({
            value,
            statements: spans.map(({ query, span }) => ({ query, connection: connectionOf(span) })),
          })),
        );
      };

      // The first read imports the v1 transcript, which writes. On the reader that
      // write would fail with "attempt to write a readonly database".
      const first = yield* recordStatements(snapshots.getThreadDetailSnapshot(threadId));
      assert.isTrue(Option.isSome(first.value));
      const writes = first.statements.filter(({ query }) => /\b(INSERT|UPDATE)\b/i.test(query));
      assert.isAbove(writes.length, 0);
      assert.deepEqual([...new Set(writes.map(({ connection }) => connection))], ["writer"]);

      // The transcript is in place now, so the import check costs nothing and every
      // statement of the session read runs on the reader.
      const second = yield* recordStatements(snapshots.getThreadDetailSnapshot(threadId));
      assert.isTrue(Option.isSome(second.value));
      if (Option.isNone(second.value)) return;
      assert.include(
        second.value.value.thread.activities.map((activity) => activity.id),
        EventId.make("activity:legacy"),
      );
      assert.isTrue(
        second.statements.some(({ query }) =>
          /FROM\s+orchestration_v2_projection_turn_items\b/i.test(query),
        ),
      );
      assert.deepEqual(
        [...new Set(second.statements.map(({ connection }) => connection))],
        ["reader"],
      );
    }),
  ),
);
