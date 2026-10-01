/**
 * RemoteOpenTargets - resolves the SSH hostnames this environment advertises
 * for remote open-in-editor deep links (`vscode://vscode-remote/ssh-remote+…`).
 *
 * The server can only check itself: sshd listening locally, tailscaled
 * reporting a MagicDNS name, and the machine hostname for mDNS. Whether a
 * given name resolves from the viewer's machine is inherently client-side.
 * Targets are ordered most-reachable first (tailnet name works from anywhere
 * on the tailnet; `<hostname>.local` only on the same LAN).
 */
import { type RemoteOpenTarget } from "@t3tools/contracts";
// T3-CUSTOM(expbkt3): HostProcessUsername is a backport of upstream #8305.
import { HostProcessHostname, HostProcessUsername } from "@t3tools/shared/hostProcess";
import * as NetService from "@t3tools/shared/Net";
import { readTailscaleStatus } from "@t3tools/tailscale";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

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
    // No local sshd means no name can work; advertise nothing so clients
    // render a clear "no SSH route" state instead of links that hang.
    // Check both loopback families: sshd can be bound IPv6-only.
    const sshdListening = yield* Effect.zipWith(
      net.hasListenerOnHost(SSH_PORT, "127.0.0.1"),
      net.hasListenerOnHost(SSH_PORT, "::1"),
      (ipv4, ipv6) => ipv4 || ipv6,
    );
    if (!sshdListening) {
      return [];
    }

    const targets: Array<RemoteOpenTarget> = [];
    // T3-CUSTOM(expbkt3): BEGIN - backport of upstream #8305. Each host reports
    // the account its own T3 server runs as, so one client can open worktrees on
    // several machines with different logins without per-host configuration.
    const username = yield* HostProcessUsername;
    // T3-CUSTOM(expbkt3): END

    // Tailscale absent or down is the common case, not an error.
    const magicDnsName = yield* readTailscaleStatus.pipe(
      Effect.map((status) => status.magicDnsName),
      Effect.orElseSucceed(() => null),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );
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
    const hostname = yield* HostProcessHostname;
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
