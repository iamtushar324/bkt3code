// T3-CUSTOM(expbkt3): account policies observe and stop native V2 sessions.
// This facade owns no execution state; V2 remains the source of truth.
import {
  type OrchestrationV2ProviderSession,
  ProviderDriverKind,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import { ProviderSessionManagerV2 } from "../orchestration-v2/ProviderSessionManager.ts";
import { ProjectionStoreV2 } from "../orchestration-v2/ProjectionStore.ts";

/** One live provider session, as the thread it serves sees it. */
const toProviderSession = (
  thread: { readonly id: ThreadId; readonly runtimeMode: ProviderSession["runtimeMode"] },
  session: OrchestrationV2ProviderSession,
): ProviderSession => ({
  threadId: thread.id,
  provider: ProviderDriverKind.make(
    String(session.driver) === "claude" ? "claudeAgent" : String(session.driver),
  ),
  providerInstanceId: session.providerInstanceId,
  status:
    session.status === "stopped"
      ? "closed"
      : session.status === "starting"
        ? "connecting"
        : session.status === "waiting"
          ? "running"
          : session.status,
  runtimeMode: thread.runtimeMode,
  cwd: session.cwd,
  ...(session.model === null ? {} : { model: session.model }),
  createdAt: DateTime.formatIso(session.createdAt),
  updatedAt: DateTime.formatIso(session.updatedAt),
});

const listeners = new Set<(event: ProviderRuntimeEvent) => Effect.Effect<void>>();
export const emitForkProviderEvent = (event: ProviderRuntimeEvent): Effect.Effect<void> =>
  Effect.forEach(listeners, (listener) => listener(event), { discard: true });

/** Observes fork events for the life of the scope, without the session layer (adapter tests). */
export const observeForkProviderEvents = (
  listener: (event: ProviderRuntimeEvent) => Effect.Effect<void>,
) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      listeners.add(listener);
    }),
    () =>
      Effect.sync(() => {
        listeners.delete(listener);
      }),
  );

export class ForkProviderSessions extends Context.Service<
  ForkProviderSessions,
  {
    readonly stopSession: (input: { readonly threadId: ThreadId }) => Effect.Effect<void>;
    /**
     * Whether a live session of the thread still runs background work between
     * turns: a subagent, a background command or monitor, or a wake not yet
     * delivered. Stopping that session ends the work. A failed check answers
     * true, as the session manager's own configuration refresh does: a restart
     * can wait, but killed work does not come back.
     *
     * Each check counts as activity on the thread's own sessions (their idle
     * release starts again), so poll it only for threads that wait on it.
     */
    readonly hasLiveBackgroundWork: (input: {
      readonly threadId: ThreadId;
    }) => Effect.Effect<boolean>;
    readonly listSessions: () => Effect.Effect<ReadonlyArray<ProviderSession>>;
    readonly streamEvents: Stream.Stream<ProviderRuntimeEvent>;
  }
>()("t3/provider/ForkProviderSessions.expbkt3/ForkProviderSessions") {}

export const layer = Layer.effect(
  ForkProviderSessions,
  Effect.gen(function* () {
    const sessions = yield* ProviderSessionManagerV2;
    const listLive = sessions.listLive;
    const projection = yield* ProjectionStoreV2;
    const events = yield* PubSub.unbounded<ProviderRuntimeEvent>();
    const listener = (event: ProviderRuntimeEvent) =>
      PubSub.publish(events, event).pipe(Effect.asVoid);
    listeners.add(listener);
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        listeners.delete(listener);
      }),
    );
    return ForkProviderSessions.of({
      stopSession: Effect.fn("ForkProviderSessions.stopSession")(function* ({ threadId }) {
        const { providerThreads } = yield* projection.getThreadRecords(threadId, [
          "providerThreads",
        ]);
        for (const providerSessionId of new Set(
          providerThreads.flatMap((thread) =>
            thread.providerSessionId === null ? [] : [thread.providerSessionId],
          ),
        )) {
          yield* sessions.release({ providerSessionId, reason: "manual_shutdown" });
        }
      }, Effect.orDie),
      hasLiveBackgroundWork: Effect.fn("ForkProviderSessions.hasLiveBackgroundWork")(
        function* ({ threadId }) {
          const { providerThreads } = yield* projection.getThreadRecords(threadId, [
            "providerThreads",
          ]);
          for (const providerSessionId of new Set(
            providerThreads.flatMap((thread) =>
              thread.providerSessionId === null ? [] : [thread.providerSessionId],
            ),
          )) {
            const live = yield* sessions.get(providerSessionId);
            if (live._tag === "None" || live.value.hasPendingBackgroundWork === undefined) continue;
            if (yield* live.value.hasPendingBackgroundWork) return true;
          }
          return false;
        },
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause) ? Effect.interrupt : Effect.succeed(true),
        ),
      ),
      listSessions: Effect.fn("ForkProviderSessions.listSessions")(function* () {
        const result: ProviderSession[] = [];
        if (listLive !== undefined) {
          // Only the threads a live session serves are read. The full shell
          // (every active and archived thread) blocked the event loop for
          // seconds, and account policies list sessions at every turn end.
          for (const live of yield* listLive()) {
            for (const threadId of live.threadIds) {
              const records = yield* projection
                .getThreadRecords(threadId, ["providerSessions"])
                .pipe(
                  Effect.catchTags({
                    ProjectionStoreThreadNotFoundError: () => Effect.succeed(null),
                  }),
                );
              // The shell never lists a deleted thread.
              if (records === null || records.thread.deletedAt !== null) continue;
              const session = records.providerSessions.find(
                (candidate) => candidate.id === live.providerSessionId,
              );
              if (session !== undefined) result.push(toProviderSession(records.thread, session));
            }
          }
          return result;
        }
        const shell = yield* projection.getShellSnapshot();
        for (const thread of [...shell.threads, ...shell.archivedThreads]) {
          const records = yield* projection.getThreadRecords(thread.id, ["providerSessions"]);
          for (const session of records.providerSessions) {
            const live = yield* sessions.get(session.id);
            if (live._tag === "None") continue;
            result.push(toProviderSession(thread, session));
          }
        }
        return result;
      }, Effect.orDie),
      streamEvents: Stream.fromPubSub(events),
    });
  }),
);
