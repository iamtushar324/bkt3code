// T3-CUSTOM(expbkt3): account policies observe and stop native V2 sessions.
// This facade owns no execution state; V2 remains the source of truth.
import {
  ProviderDriverKind,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import { ProviderSessionManagerV2 } from "../orchestration-v2/ProviderSessionManager.ts";
import { ProjectionStoreV2 } from "../orchestration-v2/ProjectionStore.ts";

const listeners = new Set<(event: ProviderRuntimeEvent) => Effect.Effect<void>>();
export const emitForkProviderEvent = (event: ProviderRuntimeEvent): Effect.Effect<void> =>
  Effect.forEach(listeners, (listener) => listener(event), { discard: true });

export class ForkProviderSessions extends Context.Service<
  ForkProviderSessions,
  {
    readonly stopSession: (input: { readonly threadId: ThreadId }) => Effect.Effect<void>;
    readonly listSessions: () => Effect.Effect<ReadonlyArray<ProviderSession>>;
    readonly streamEvents: Stream.Stream<ProviderRuntimeEvent>;
  }
>()("t3/provider/ForkProviderSessions.expbkt3/ForkProviderSessions") {}

export const layer = Layer.effect(
  ForkProviderSessions,
  Effect.gen(function* () {
    const sessions = yield* ProviderSessionManagerV2;
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
      stopSession: ({ threadId }) =>
        Effect.gen(function* () {
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
        }).pipe(Effect.orDie),
      listSessions: () =>
        Effect.gen(function* () {
          const shell = yield* projection.getShellSnapshot();
          const result: ProviderSession[] = [];
          for (const thread of [...shell.threads, ...shell.archivedThreads]) {
            const records = yield* projection.getThreadRecords(thread.id, ["providerSessions"]);
            for (const session of records.providerSessions) {
              const live = yield* sessions.get(session.id);
              if (live._tag === "None") continue;
              result.push({
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
            }
          }
          return result;
        }).pipe(Effect.orDie),
      streamEvents: Stream.fromPubSub(events),
    });
  }),
);
