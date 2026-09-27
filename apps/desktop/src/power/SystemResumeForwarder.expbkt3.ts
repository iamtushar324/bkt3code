/**
 * T3-CUSTOM(expbkt3): tell every renderer when the OS resumes or unlocks.
 *
 * After a laptop sleeps, the renderer's socket is usually dead but nothing
 * says so: the window stays visible, and the focus probe waits out its full
 * 15 s timeout before reconnecting. The OS already knows; forwarding
 * `resume` and `unlock-screen` lets the renderer reconnect at once
 * (`application-active-reconnect`).
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";

import * as ElectronPowerMonitor from "../electron/ElectronPowerMonitor.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as IpcChannels from "../ipc/channels.ts";

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const powerMonitor = yield* ElectronPowerMonitor.ElectronPowerMonitor;
    const electronWindow = yield* ElectronWindow.ElectronWindow;
    // Resume and unlock often fire together; one reconnect covers both.
    const resumes = yield* Queue.sliding<void>(1);
    const offer = () => {
      Queue.offerUnsafe(resumes, undefined);
    };
    yield* powerMonitor.onSimpleEvent("resume", offer);
    yield* powerMonitor.onSimpleEvent("unlock-screen", offer);
    yield* Effect.forkScoped(
      Effect.forever(
        Queue.take(resumes).pipe(
          Effect.andThen(electronWindow.sendAll(IpcChannels.SYSTEM_RESUMED_CHANNEL)),
        ),
      ),
    );
  }),
);
