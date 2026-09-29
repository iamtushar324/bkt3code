/**
 * T3-CUSTOM(expbkt3): coverage for review comments on assistant messages.
 *
 * The status rules are the contract the sidebar, the MCP tools and the turn
 * injection all rely on, so they are pinned here: who reopens, what a reply
 * does, and what "deliverable" means once delivery is paused.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  MessageId,
  THREAD_COMMENT_MAX_REPLIES,
  ThreadCommentId,
  ThreadId,
  UserId,
  type ThreadCommentAnchor,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { MigrationsLive } from "../persistence/Migrations.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ThreadComments from "../persistence/ThreadComments.ts";
import { ThreadCommentsRepository } from "../persistence/ThreadComments.ts";
import * as ThreadCommentsServiceModule from "./ThreadCommentsService.ts";
import { ThreadCommentsService } from "./ThreadCommentsService.ts";

const threadId = ThreadId.make("thread-comments");
const otherThreadId = ThreadId.make("thread-comments-other");
const actor = { actorUserId: UserId.make("user-reviewer"), actorLabel: "Barsha" };

const anchor = (text = "the quoted passage"): ThreadCommentAnchor => ({
  messageId: MessageId.make("message-1"),
  text,
  start: 10,
  end: 10 + text.length,
  prefix: "before ",
  suffix: " after",
});

const layer = ThreadCommentsServiceModule.layer.pipe(
  Layer.provide(ThreadComments.layer),
  Layer.provide(MigrationsLive),
  Layer.provide(SqlitePersistenceMemory),
  Layer.provide(NodeServices.layer),
);

const withService = <A, E>(
  body: (service: ThreadCommentsService["Service"]) => Effect.Effect<A, E, never>,
) =>
  Effect.gen(function* () {
    const service = yield* ThreadCommentsService;
    return yield* body(service);
  }).pipe(Effect.provide(layer));

describe("ThreadCommentsService", () => {
  it.effect("adds comments with monotonic per-thread numbers, even after a removal", () =>
    withService((service) =>
      Effect.gen(function* () {
        const first = yield* service.add({
          threadId,
          kind: "comment",
          anchor: anchor(),
          body: "Tighten this",
          ...actor,
        });
        expect(first.comments.map((comment) => comment.number)).toEqual([1]);
        expect(first.comments[0]?.status).toBe("open");
        expect(first.comments[0]?.authorLabel).toBe("Barsha");
        expect(first.comments[0]?.commentId.startsWith("tc_")).toBe(true);

        const second = yield* service.add({
          threadId,
          kind: "good",
          anchor: anchor("nice"),
          body: "",
          ...actor,
        });
        expect(second.comments.map((comment) => comment.number)).toEqual([1, 2]);

        const removed = yield* service.remove({
          threadId,
          commentId: second.comments[1]!.commentId,
        });
        expect(removed.comments.map((comment) => comment.number)).toEqual([1]);

        const third = yield* service.add({
          threadId,
          kind: "remove",
          anchor: anchor("drop"),
          body: "",
          ...actor,
        });
        expect(third.comments.map((comment) => comment.number)).toEqual([1, 3]);

        // Numbers are per thread.
        const elsewhere = yield* service.add({
          threadId: otherThreadId,
          kind: "okay",
          anchor: anchor(),
          body: "",
          ...actor,
        });
        expect(elsewhere.comments.map((comment) => comment.number)).toEqual([1]);
        expect(elsewhere.threadId).toBe(otherThreadId);
      }),
    ),
  );

  it.effect("rejects a free-text comment without text", () =>
    withService((service) =>
      Effect.gen(function* () {
        const error = yield* service
          .add({ threadId, kind: "comment", anchor: anchor(), body: "   ", ...actor })
          .pipe(Effect.flip);
        expect(error.reason).toBe("invalid");
      }),
    ),
  );

  it.effect("agent replies can mark a comment addressed; a user reply reopens it", () =>
    withService((service) =>
      Effect.gen(function* () {
        const added = yield* service.add({
          threadId,
          kind: "comment",
          anchor: anchor(),
          body: "Rename it",
          ...actor,
        });
        const commentId = added.comments[0]!.commentId;

        const addressed = yield* service.agentReply({
          threadId,
          commentId,
          body: "Renamed to fooBar",
          addressed: true,
        });
        expect(addressed.status).toBe("addressed");
        expect(addressed.replies.map((reply) => reply.author)).toEqual(["agent"]);
        expect(addressed.replies[0]?.authorUserId).toBeNull();

        const reopened = yield* service.reply({
          threadId,
          commentId,
          body: "Not that name",
          ...actor,
        });
        const comment = reopened.comments[0]!;
        expect(comment.status).toBe("open");
        expect(comment.replies.map((reply) => reply.author)).toEqual(["agent", "user"]);
        expect(comment.replies[1]?.authorLabel).toBe("Barsha");

        // A bare addressed=true without a body records no reply.
        const again = yield* service.agentReply({ threadId, commentId, addressed: true });
        expect(again.status).toBe("addressed");
        expect(again.replies).toHaveLength(2);
      }),
    ),
  );

  it.effect("an agent reply needs a body or an addressed flag", () =>
    withService((service) =>
      Effect.gen(function* () {
        const added = yield* service.add({
          threadId,
          kind: "comment",
          anchor: anchor(),
          body: "x",
          ...actor,
        });
        const error = yield* service
          .agentReply({ threadId, commentId: added.comments[0]!.commentId })
          .pipe(Effect.flip);
        expect(error.reason).toBe("invalid");
      }),
    ),
  );

  it.effect("only the user resolves; the agent cannot reopen a resolved comment", () =>
    withService((service) =>
      Effect.gen(function* () {
        const added = yield* service.add({
          threadId,
          kind: "comment",
          anchor: anchor(),
          body: "x",
          ...actor,
        });
        const commentId = added.comments[0]!.commentId;

        const resolved = yield* service.setStatus({ threadId, commentId, status: "resolved" });
        expect(resolved.comments[0]?.status).toBe("resolved");
        expect(resolved.comments[0]?.resolvedAt).not.toBeNull();

        const afterAgent = yield* service.agentReply({
          threadId,
          commentId,
          body: "late",
          addressed: true,
        });
        expect(afterAgent.status).toBe("resolved");

        const reopened = yield* service.setStatus({ threadId, commentId, status: "open" });
        expect(reopened.comments[0]?.status).toBe("open");
        expect(reopened.comments[0]?.resolvedAt).toBeNull();
      }),
    ),
  );

  it.effect("resolveAll closes open and addressed comments and leaves resolved ones alone", () =>
    withService((service) =>
      Effect.gen(function* () {
        yield* service.add({ threadId, kind: "comment", anchor: anchor(), body: "one", ...actor });
        const two = yield* service.add({
          threadId,
          kind: "comment",
          anchor: anchor(),
          body: "two",
          ...actor,
        });
        const three = yield* service.add({
          threadId,
          kind: "comment",
          anchor: anchor(),
          body: "three",
          ...actor,
        });
        yield* service.agentReply({
          threadId,
          commentId: two.comments[1]!.commentId,
          addressed: true,
        });
        const early = yield* service.setStatus({
          threadId,
          commentId: three.comments[2]!.commentId,
          status: "resolved",
        });
        const earlyResolvedAt = early.comments[2]!.resolvedAt;

        const snapshot = yield* service.resolveAll(threadId);
        expect(snapshot.comments.map((comment) => comment.status)).toEqual([
          "resolved",
          "resolved",
          "resolved",
        ]);
        expect(snapshot.comments[2]?.resolvedAt).toBe(earlyResolvedAt);
        expect(snapshot.comments[0]?.resolvedAt).not.toBeNull();
      }),
    ),
  );

  it.effect("openForDelivery returns open comments only, and nothing while paused", () =>
    withService((service) =>
      Effect.gen(function* () {
        const one = yield* service.add({
          threadId,
          kind: "comment",
          anchor: anchor(),
          body: "one",
          ...actor,
        });
        const two = yield* service.add({
          threadId,
          kind: "good",
          anchor: anchor(),
          body: "",
          ...actor,
        });
        yield* service.agentReply({
          threadId,
          commentId: two.comments[1]!.commentId,
          addressed: true,
        });
        yield* service.add({
          threadId: otherThreadId,
          kind: "comment",
          anchor: anchor(),
          body: "elsewhere",
          ...actor,
        });

        const open = yield* service.openForDelivery(threadId);
        expect(open.map((comment) => comment.commentId)).toEqual([one.comments[0]!.commentId]);

        const paused = yield* service.setDeliveryPaused({ threadId, paused: true });
        expect(paused.deliveryPaused).toBe(true);
        expect(yield* service.openForDelivery(threadId)).toEqual([]);
        // Pausing one thread does not touch another.
        expect(yield* service.openForDelivery(otherThreadId)).toHaveLength(1);

        const resumed = yield* service.setDeliveryPaused({ threadId, paused: false });
        expect(resumed.deliveryPaused).toBe(false);
        expect(yield* service.openForDelivery(threadId)).toHaveLength(1);
      }),
    ),
  );

  it.effect("caps replies at the contract maximum, dropping the oldest", () =>
    withService((service) =>
      Effect.gen(function* () {
        const added = yield* service.add({
          threadId,
          kind: "comment",
          anchor: anchor(),
          body: "x",
          ...actor,
        });
        const commentId = added.comments[0]!.commentId;
        for (let index = 0; index < THREAD_COMMENT_MAX_REPLIES + 2; index += 1) {
          yield* service.reply({ threadId, commentId, body: `reply ${index}`, ...actor });
        }
        const snapshot = yield* service.snapshot(threadId);
        const replies = snapshot.comments[0]!.replies;
        expect(replies).toHaveLength(THREAD_COMMENT_MAX_REPLIES);
        expect(replies[0]?.body).toBe("reply 2");
        expect(replies[replies.length - 1]?.body).toBe(`reply ${THREAD_COMMENT_MAX_REPLIES + 1}`);
      }),
    ),
  );

  it.effect("reports not-found for a comment on another thread", () =>
    withService((service) =>
      Effect.gen(function* () {
        const added = yield* service.add({
          threadId,
          kind: "comment",
          anchor: anchor(),
          body: "x",
          ...actor,
        });
        const commentId = added.comments[0]!.commentId;
        const error = yield* service
          .reply({ threadId: otherThreadId, commentId, body: "hi", ...actor })
          .pipe(Effect.flip);
        expect(error.reason).toBe("not-found");
        const missing = yield* service
          .remove({ threadId, commentId: ThreadCommentId.make("tc_missing") })
          .pipe(Effect.flip);
        expect(missing.reason).toBe("not-found");
      }),
    ),
  );

  it.effect("watch emits the current snapshot and one per mutation on that thread", () =>
    withService((service) =>
      Effect.gen(function* () {
        yield* service.add({
          threadId,
          kind: "comment",
          anchor: anchor(),
          body: "first",
          ...actor,
        });
        const collector = yield* Effect.forkChild(
          service.watch(threadId).pipe(Stream.take(3), Stream.runCollect),
          { startImmediately: true },
        );
        yield* service.add({
          threadId: otherThreadId,
          kind: "comment",
          anchor: anchor(),
          body: "noise",
          ...actor,
        });
        yield* service.add({
          threadId,
          kind: "comment",
          anchor: anchor(),
          body: "second",
          ...actor,
        });
        yield* service.setDeliveryPaused({ threadId, paused: true });
        const snapshots = yield* Fiber.join(collector);
        expect(snapshots.map((snapshot) => snapshot.comments.length)).toEqual([1, 2, 2]);
        expect(snapshots.map((snapshot) => snapshot.deliveryPaused)).toEqual([false, false, true]);
      }),
    ),
  );

  it.effect("a user reply on a resolved comment reopens it", () =>
    withService((service) =>
      Effect.gen(function* () {
        const added = yield* service.add({
          threadId,
          kind: "comment",
          anchor: anchor(),
          body: "x",
          ...actor,
        });
        const commentId = added.comments[0]!.commentId;
        yield* service.setStatus({ threadId, commentId, status: "resolved" });
        const reopened = yield* service.reply({
          threadId,
          commentId,
          body: "actually, not done",
          ...actor,
        });
        expect(reopened.comments[0]?.status).toBe("open");
        expect(reopened.comments[0]?.resolvedAt).toBeNull();
        expect(yield* service.openForDelivery(threadId)).toHaveLength(1);
      }),
    ),
  );

  it.effect("an agent reply racing a user resolve keeps both the reply and the resolve", () =>
    withService((service) =>
      Effect.gen(function* () {
        const added = yield* service.add({
          threadId,
          kind: "comment",
          anchor: anchor(),
          body: "x",
          ...actor,
        });
        const commentId = added.comments[0]!.commentId;
        yield* Effect.all(
          [
            service.agentReply({ threadId, commentId, body: "done", addressed: true }),
            service.setStatus({ threadId, commentId, status: "resolved" }),
          ],
          { concurrency: "unbounded" },
        );
        const snapshot = yield* service.snapshot(threadId);
        expect(snapshot.comments[0]?.status).toBe("resolved");
        expect(snapshot.comments[0]?.replies.map((reply) => reply.body)).toEqual(["done"]);
      }),
    ),
  );

  // A write that lands between a watcher subscribing and its first read must
  // still reach it: the initial snapshot may or may not carry it, but the
  // change notification must. The gate holds the very first list read open
  // so the write provably lands in that window.
  it.effect("watch observes a write that races its initial read", () =>
    Effect.gen(function* () {
      const firstReadStarted = yield* Deferred.make<void>();
      const releaseFirstRead = yield* Deferred.make<void>();
      const gatedRepository = Layer.effect(
        ThreadCommentsRepository,
        Effect.gen(function* () {
          const real = yield* ThreadCommentsRepository;
          let reads = 0;
          return ThreadCommentsRepository.of({
            ...real,
            listForThread: (id) =>
              Effect.gen(function* () {
                reads += 1;
                if (reads === 1) {
                  yield* Deferred.succeed(firstReadStarted, undefined);
                  yield* Deferred.await(releaseFirstRead);
                }
                return yield* real.listForThread(id);
              }),
          });
        }),
      ).pipe(Layer.provide(ThreadComments.layer));
      const gatedLayer = ThreadCommentsServiceModule.layer.pipe(
        Layer.provide(gatedRepository),
        Layer.provide(MigrationsLive),
        Layer.provide(SqlitePersistenceMemory),
        Layer.provide(NodeServices.layer),
      );

      yield* Effect.gen(function* () {
        const service = yield* ThreadCommentsService;
        const collector = yield* Effect.forkChild(
          service.watch(threadId).pipe(Stream.take(2), Stream.runCollect),
          { startImmediately: true },
        );
        yield* Deferred.await(firstReadStarted);
        // The watcher is parked inside its first read; this write publishes
        // its change now, before that read returns.
        yield* service.add({
          threadId,
          kind: "comment",
          anchor: anchor(),
          body: "raced",
          ...actor,
        });
        yield* Deferred.succeed(releaseFirstRead, undefined);
        const snapshots = yield* Fiber.join(collector);
        expect(snapshots).toHaveLength(2);
        expect(snapshots[1]!.comments.map((comment) => comment.body)).toEqual(["raced"]);
      }).pipe(Effect.provide(gatedLayer));
    }),
  );
});
