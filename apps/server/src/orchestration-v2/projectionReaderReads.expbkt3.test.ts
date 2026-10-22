// T3-CUSTOM(expbkt3): thread snapshot, window, shell and record reads run on the SQLite
// reader workers, so a client syncing a thread never waits behind the writer.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  EventId,
  type ModelSelection,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;

it.live("thread reads do not wait for an open write transaction", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "projection-reader-reads-" });
    const database = SqlitePersistence.layerFromPath(path.join(directory, "statev2.sqlite"));
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const createdAt = DateTime.makeUnsafe("2026-10-22T09:00:00.000Z");
      const threadId = ThreadId.make("thread:reader-reads");
      const thread = {
        createdBy: "user" as const,
        creationSource: "web" as const,
        id: threadId,
        projectId: ProjectId.make("project:reader-reads"),
        title: "Committed title",
        providerInstanceId: modelSelection.instanceId,
        modelSelection,
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
        forkedFrom: null,
        createdAt,
        updatedAt: createdAt,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      };
      yield* store.apply({
        id: EventId.make("event:reader-reads:created"),
        type: "thread.created",
        threadId,
        occurredAt: createdAt,
        payload: thread,
      });

      const writerHeld = yield* Deferred.make<string | undefined>();
      const releaseWriter = yield* Deferred.make<void>();
      const writer = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* store.apply({
              id: EventId.make("event:reader-reads:renamed"),
              type: "thread.metadata-updated",
              threadId,
              occurredAt: createdAt,
              payload: { ...thread, title: "Uncommitted title" },
            });
            // Inside the open write transaction the read stays on the writer and sees its rows.
            const ownShell = yield* store.getThreadShell(threadId);
            yield* Deferred.succeed(writerHeld, ownShell?.title);
            yield* Deferred.await(releaseWriter);
          }),
        )
        .pipe(Effect.forkChild);

      assert.equal(yield* Deferred.await(writerHeld), "Uncommitted title");

      // The writer stays held, so a read routed to the writer would time out here.
      const titles = yield* Effect.gen(function* () {
        const shell = yield* store.getThreadShell(threadId);
        const snapshot = yield* store.getThreadSnapshot(threadId);
        const window = yield* store.getThreadSnapshotWindow(threadId, { rowLimit: 10 });
        const records = yield* store.getThreadRecords(threadId, []);
        return [
          shell?.title,
          snapshot.projection.thread.title,
          window.projection.thread.title,
          records.thread.title,
        ];
      }).pipe(Effect.timeout("10 seconds"));
      assert.deepEqual(titles, [
        "Committed title",
        "Committed title",
        "Committed title",
        "Committed title",
      ]);

      yield* Deferred.succeed(releaseWriter, undefined);
      yield* Fiber.join(writer);

      // A reader transaction that starts after the commit sees it.
      const afterCommit = yield* store.getThreadShell(threadId);
      assert.equal(afterCommit?.title, "Uncommitted title");
      const recordsAfterCommit = yield* store.getThreadRecords(threadId, []);
      assert.equal(recordsAfterCommit.thread.title, "Uncommitted title");
    }).pipe(Effect.provide(ProjectionStore.layer.pipe(Layer.provideMerge(database))));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
