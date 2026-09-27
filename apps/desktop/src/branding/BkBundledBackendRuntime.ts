/**
 * Fork-owned runtime choices for the bundled backend in managed BK desktop
 * builds. Keep them here so the upstream desktop startup path remains
 * unchanged when no managed BK environment is baked into the bundle.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as NetService from "@t3tools/shared/Net";

import type { BkManagedChannel } from "./BkManagedEnvironment.ts";

const PORT_PROBE_HOSTS = ["127.0.0.1", "0.0.0.0", "::"] as const;

export const BK_BUNDLED_BACKEND_PORT_RANGES = {
  production: { start: 3_773, end: 3_872 },
  staging: { start: 4_773, end: 4_872 },
} as const satisfies Record<BkManagedChannel, { readonly start: number; readonly end: number }>;

export class BkBundledBackendPortUnavailableError extends Schema.TaggedError<BkBundledBackendPortUnavailableError>()(
  "BkBundledBackendPortUnavailableError",
  {
    channel: Schema.Literals(["staging", "production"]),
    startPort: Schema.Int,
    maxPort: Schema.Int,
  },
) {
  override get message(): string {
    return `No bundled ${this.channel} backend port is available between ${this.startPort} and ${this.maxPort}.`;
  }
}

export const resolveBkBundledBackendPort = Effect.fn("bk.bundledBackend.resolvePort")(
  function* (input: {
    readonly channel: BkManagedChannel;
    readonly configuredPort: Option.Option<number>;
  }): Effect.fn.Return<
    { readonly port: number; readonly selectedByScan: boolean },
    BkBundledBackendPortUnavailableError,
    NetService.NetService
  > {
    if (Option.isSome(input.configuredPort)) {
      return { port: input.configuredPort.value, selectedByScan: false };
    }

    const range = BK_BUNDLED_BACKEND_PORT_RANGES[input.channel];
    const net = yield* NetService.NetService;
    for (let port = range.start; port <= range.end; port += 1) {
      let availableOnEveryHost = true;
      for (const host of PORT_PROBE_HOSTS) {
        if (!(yield* net.canListenOnHost(port, host))) {
          availableOnEveryHost = false;
          break;
        }
      }
      if (availableOnEveryHost) {
        return { port, selectedByScan: true };
      }
    }

    return yield* new BkBundledBackendPortUnavailableError({
      channel: input.channel,
      startPort: range.start,
      maxPort: range.end,
    });
  },
);
