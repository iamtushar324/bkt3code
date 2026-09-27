/**
 * T3-CUSTOM(expbkt3): log how long each startup phase took.
 *
 * Prod restarts have taken up to ~3 min to reach `Listening` with nothing in
 * the journal to say which phase was slow; spans only reach the trace file.
 * One info line per phase (`server.startup.phase`, `phase`, `durationMs`,
 * `outcome`) names the slow phase on the next slow boot. Parked phases report
 * the time to fork, not the time their background work takes.
 */
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

export const withStartupPhaseTiming = <A, E, R>(phase: string, effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const startedAt = yield* Clock.currentTimeMillis;
    return yield* effect.pipe(
      Effect.onExit((exit) =>
        Effect.flatMap(Clock.currentTimeMillis, (endedAt) =>
          Effect.logInfo("server.startup.phase", {
            phase,
            durationMs: endedAt - startedAt,
            outcome: Exit.isSuccess(exit)
              ? "success"
              : Exit.hasInterrupts(exit)
                ? "interrupted"
                : "failure",
          }),
        ),
      ),
    );
  });
