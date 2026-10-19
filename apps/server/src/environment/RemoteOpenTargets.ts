import { type RemoteOpenTarget } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NetService from "@t3tools/shared/Net";
import { readTailscaleSshEnabled, readTailscaleStatus } from "@t3tools/tailscale";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
// T3-CUSTOM(expbkt3): BEGIN - backport of upstream #8305.
import * as NodeOS from "node:os";

/**
 * The login account on the environment host, so a remote open-in-editor deep
 * link can name the user to SSH as. Hosts differ (ds1 is `ubuntu`, a Mac is
 * not), and the viewer's own username is not a usable guess, so the host
 * reports its own. Lived in `@t3tools/shared/hostProcess` until upstream
 * replaced that module with `HostProcess`.
 */
export const HostUsername = Context.Reference<string | null>(
  "t3/environment/RemoteOpenTargets/HostUsername",
  {
    defaultValue: () => {
      try {
        return NodeOS.userInfo().username.trim() || null;
      } catch {
        return null;
      }
    },
  },
);
// T3-CUSTOM(expbkt3): END

const SSH_PORT = 22;

export class RemoteOpenTargets extends Context.Service<
  RemoteOpenTargets,
  {
    readonly resolveTargets: () => Effect.Effect<ReadonlyArray<RemoteOpenTarget>>;
  }
>()("t3/environment/RemoteOpenTargets") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const net = yield* NetService.NetService;

  const resolveTargets = Effect.gen(function* () {
    // Check both loopback families: sshd can be bound IPv6-only.
    const sshdListening = yield* Effect.zipWith(
      net.hasListenerOnHost(SSH_PORT, "127.0.0.1"),
      net.hasListenerOnHost(SSH_PORT, "::1"),
      (ipv4, ipv6) => ipv4 || ipv6,
    );

    // T3-CUSTOM(expbkt3): BEGIN - backport of upstream #8305. Each host reports
    // the account its own T3 server runs as, so one client can open worktrees on
    // several machines with different logins without per-host configuration.
    const username = yield* HostUsername;
    // T3-CUSTOM(expbkt3): END

    const magicDnsName = yield* readTailscaleStatus.pipe(
      Effect.map((status) => status.magicDnsName),
      Effect.orElseSucceed(() => null),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );

    const targets: Array<RemoteOpenTarget> = [];

    if (!sshdListening) {
      // Tailscale SSH answers on the tailnet name with no local sshd, so only
      // that name can work. A running tailscaled alone is not an SSH route.
      if (
        magicDnsName !== null &&
        (yield* readTailscaleSshEnabled.pipe(
          Effect.orElseSucceed(() => false),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        ))
      ) {
        // T3-CUSTOM(expbkt3): BEGIN - backport of upstream #8305.
        targets.push({
          kind: "tailscale",
          host: magicDnsName,
          ...(username === null ? {} : { username }),
        });
        // T3-CUSTOM(expbkt3): END
      }
      return targets;
    }

    if (magicDnsName !== null) {
      // T3-CUSTOM(expbkt3): BEGIN - backport of upstream #8305.
      targets.push({
        kind: "tailscale",
        host: magicDnsName,
        ...(username === null ? {} : { username }),
      });
      // T3-CUSTOM(expbkt3): END
    }

    // os.hostname() may already be an FQDN (macOS often reports
    // "Name.local"); mDNS names are always `<first-label>.local`.
    const hostname = yield* HostProcess.Hostname;
    const shortHostname = hostname.split(".")[0]?.trim();
    if (shortHostname !== undefined && shortHostname.length > 0) {
      // T3-CUSTOM(expbkt3): BEGIN - backport of upstream #8305.
      targets.push({
        kind: "mdns",
        host: `${shortHostname}.local`,
        ...(username === null ? {} : { username }),
      });
      // T3-CUSTOM(expbkt3): END
    }

    return targets;
  });

  return RemoteOpenTargets.of({ resolveTargets: () => resolveTargets });
});

export const layer = Layer.effect(RemoteOpenTargets, make);
