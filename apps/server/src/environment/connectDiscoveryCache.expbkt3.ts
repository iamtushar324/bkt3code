/**
 * T3-CUSTOM(expbkt3): answer connect-time discovery from the last result.
 *
 * Every websocket connect builds the server config, which embeds the installed
 * editors, the file-manager reveal kind and the SSH open targets. Upstream
 * discovers them inline on the connection fiber, each under the 5 s
 * `CONFIG_DISCOVERY_TIMEOUT` in ws.ts. On a busy server every PATH probe waits
 * behind other event-loop work, so the steps run into their timeouts and the
 * config takes 12 s or more. Clients give a new connection 15 s, so they gave
 * up and retried in a loop: on bkt3 (2026-10-01) one reconnect took three
 * attempts over 27 s, each editor scan 5.0-5.2 s against 26 ms when idle. A
 * scan cut off by the timeout was never cached, so every retry paid again.
 *
 * Here each discovery answers from its last success at once and refreshes in
 * the background once that is older than a minute. Only the first call after
 * startup waits, and its scan runs in the layer's scope: a caller that times
 * out or disconnects leaves the scan running, and the next connect gets its
 * result.
 */
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ExternalLauncher from "../process/externalLauncher.ts";
import * as RemoteOpenTargets from "./RemoteOpenTargets.ts";

export const CONNECT_DISCOVERY_REFRESH_AFTER = Duration.minutes(1);

/**
 * Wraps `discover` so callers get its last successful value immediately; a
 * value older than `refreshAfter` starts one background refresh. Callers that
 * arrive before the first success share one scan. Refreshes run in the scope
 * this is built in, never on a caller's fiber, so build it in a long-lived one.
 */
export const makeStaleWhileRevalidate = <A>(
  discover: Effect.Effect<A>,
  refreshAfter: Duration.Input,
) =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const refreshAfterNanos = Duration.toNanosUnsafe(refreshAfter);
    let latest: { readonly value: A; readonly discoveredAtNanos: bigint } | undefined;
    let inFlight: Deferred.Deferred<A> | undefined;

    const startRefresh = Effect.gen(function* () {
      const done = yield* Deferred.make<A>();
      // Claimed before forking, so a scan that settles at once cannot leave a
      // stale claim behind.
      inFlight = done;
      yield* Effect.forkIn(
        discover.pipe(
          Effect.tap((value) =>
            Effect.map(Clock.currentTimeNanos, (discoveredAtNanos) => {
              latest = { value, discoveredAtNanos };
            }),
          ),
          // onExit also settles waiters when shutdown interrupts the scan.
          Effect.onExit((exit) => Deferred.done(done, exit)),
          Effect.ensuring(
            Effect.sync(() => {
              if (inFlight === done) inFlight = undefined;
            }),
          ),
        ),
        scope,
      );
      return done;
    });

    return Effect.gen(function* () {
      const current = latest;
      if (current !== undefined) {
        const nowNanos = yield* Clock.currentTimeNanos;
        if (inFlight === undefined && nowNanos - current.discoveredAtNanos >= refreshAfterNanos) {
          yield* startRefresh;
        }
        return current.value;
      }
      return yield* Deferred.await(inFlight ?? (yield* startRefresh));
    });
  });

/** `ExternalLauncher.layer` with editor and reveal-kind discovery served from the last result. */
export const cachedExternalLauncherLayer = Layer.effect(
  ExternalLauncher.ExternalLauncher,
  Effect.gen(function* () {
    const launcher = yield* ExternalLauncher.ExternalLauncher;
    const editors = yield* makeStaleWhileRevalidate(
      launcher.resolveAvailableEditors(),
      CONNECT_DISCOVERY_REFRESH_AFTER,
    );
    const revealKind = yield* makeStaleWhileRevalidate(
      launcher.resolveFileManagerRevealKind(),
      CONNECT_DISCOVERY_REFRESH_AFTER,
    );
    return ExternalLauncher.ExternalLauncher.of({
      ...launcher,
      resolveAvailableEditors: () => editors,
      resolveFileManagerRevealKind: () => revealKind,
    });
  }),
).pipe(Layer.provide(ExternalLauncher.layer));

/** `RemoteOpenTargets.layer` with its SSH and Tailscale probes served from the last result. */
export const cachedRemoteOpenTargetsLayer = Layer.effect(
  RemoteOpenTargets.RemoteOpenTargets,
  Effect.gen(function* () {
    const remoteOpenTargets = yield* RemoteOpenTargets.RemoteOpenTargets;
    const targets = yield* makeStaleWhileRevalidate(
      remoteOpenTargets.resolveTargets(),
      CONNECT_DISCOVERY_REFRESH_AFTER,
    );
    return RemoteOpenTargets.RemoteOpenTargets.of({ resolveTargets: () => targets });
  }),
).pipe(Layer.provide(RemoteOpenTargets.layer));
