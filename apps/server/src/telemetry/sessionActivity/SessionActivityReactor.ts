/**
 * T3-CUSTOM(expbkt3): live session time-in-state metrics (TEC-1631).
 *
 * Feeds the live orchestration V2 event stream to the pure session tracker
 * (`SessionActivityReducer.ts`) and records what it emits through
 * `AnalyticsService`. On boot it seeds open sessions from one shell snapshot
 * read, so their first span carries `resumedAfterRestart: true`. On shutdown it
 * closes every open span with `endReason: "server_stopped"`. Every five
 * minutes it records a `session.state.snapshot` for concurrency and peak load.
 *
 * It does nothing, not even subscribe, when telemetry is off or no PostHog key
 * is set.
 */
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import { EventSinkV2 } from "../../orchestration-v2/EventSink.ts";
import { ProjectionStoreV2 } from "../../orchestration-v2/ProjectionStore.ts";
import { forkParked } from "../../serverActivation.ts";
import { AnalyticsService } from "../AnalyticsService.ts";
import {
  makeSessionActivityTracker,
  type SessionActivityEmission,
} from "./SessionActivityReducer.ts";

const SNAPSHOT_INTERVAL = "5 minutes";

const SessionActivityConfig = Config.all({
  enabled: Config.Boolean("T3CODE_TELEMETRY_ENABLED").pipe(Config.withDefault(true)),
  posthogKey: Config.String("T3CODE_POSTHOG_KEY").pipe(Config.withDefault("")),
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* SessionActivityConfig;
    if (!config.enabled || config.posthogKey.trim() === "") return;

    const analytics = yield* AnalyticsService;
    const eventSink = yield* EventSinkV2;
    const projections = yield* ProjectionStoreV2;
    const tracker = makeSessionActivityTracker({ backfill: false });

    const record = (emissions: ReadonlyArray<SessionActivityEmission>) =>
      Effect.forEach(
        emissions,
        (emission) =>
          analytics.record(emission.event, emission.properties, {
            ...(emission.userId === undefined ? {} : { userId: emission.userId }),
            timestamp: emission.timestamp,
            insertId: emission.insertId,
          }),
        { discard: true },
      );

    // Subscribe from the current head, then seed: an event that lands between
    // the two reads is applied on top of the seed, never lost.
    const afterSequence = yield* eventSink.latestSequence().pipe(Effect.orDie);
    const shells = yield* projections.getShellSnapshot({ location: "active" }).pipe(
      Effect.map((snapshot) => snapshot.threads),
      Effect.catchCause((cause) =>
        Effect.logWarning("session activity: could not seed open sessions", { cause }).pipe(
          Effect.as([]),
        ),
      ),
    );
    const bootMs = yield* Clock.currentTimeMillis;
    for (const shell of shells) tracker.seed(shell, bootMs);

    yield* forkParked(
      eventSink.stream({ afterSequence }).pipe(
        Stream.runForEach((stored) => record(tracker.apply(stored.event))),
        Effect.catchCause((cause) =>
          Effect.logWarning("session activity: event stream failed", { cause }),
        ),
      ),
    );

    yield* forkParked(
      Clock.currentTimeMillis.pipe(
        Effect.flatMap((nowMs) => record(tracker.snapshot(nowMs))),
        Effect.repeat(Schedule.spaced(SNAPSHOT_INTERVAL)),
        Effect.asVoid,
      ),
    );

    // Runs before AnalyticsService's own finalizer, which flushes the buffer.
    yield* Effect.addFinalizer(() =>
      Clock.currentTimeMillis.pipe(
        Effect.flatMap((nowMs) => record(tracker.closeAll(nowMs, "server_stopped"))),
      ),
    );
  }),
);
