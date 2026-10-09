// T3-CUSTOM(expbkt3): pure parts of BK Add-ons → "Connect phone to local server".
/**
 * A managed BK desktop's primary environment is the central server, so every
 * upstream pairing surface targets that server. The desktop also runs a bundled
 * local backend as a secondary environment ({@link BK_BUNDLED_BACKEND_ID}); this
 * module decides which of that backend's addresses a phone can dial, builds the
 * link and code a phone needs, and words the rows. The component in
 * `LocalPhonePairingSection.tsx` only wires these to the desktop bridge and the
 * HTTP helper in `localServerPairing.ts`.
 *
 * @module fork/localPhonePairing.logic
 */
import type {
  ConnectionTarget,
  EnvironmentConnectionPhase,
} from "@t3tools/client-runtime/connection";
import type {
  AdvertisedEndpoint,
  AuthClientSession,
  DesktopServerExposureMode,
} from "@t3tools/contracts";

import * as DateTime from "effect/DateTime";

import { isQrShareableEndpoint } from "../components/settings/ConnectionsSettings.logic";
import { resolveDesktopPairingUrl } from "../components/settings/pairingUrls";
import { desktopLocalBackendId } from "../connection/desktopLocal";
import { BK_BUNDLED_BACKEND_ID } from "./managedEnvironment";

/** Prefix of the label stored on a pairing link; the paired session keeps the label. */
const LOCAL_PHONE_PAIRING_LABEL = "Phone (admin)";

export const PAIR_PHONE_DESCRIPTION =
  "Make a link, code and QR code for the T3 Code app on your phone. The phone gets admin access to this Mac's server. The code works once and expires after 5 minutes.";

export const NO_PHONE_ADDRESS_MESSAGE =
  "No address that a phone can reach. Turn on “Reachable on my network” above, then select Refresh.";

const NETWORK_ON_DESCRIPTION =
  "Phones on the same Wi-Fi or tailnet can reach the local server. Turning this off restarts T3 Code.";

const NETWORK_OFF_DESCRIPTION =
  "Only this Mac can reach the local server. Turn this on to let a phone on the same Wi-Fi or tailnet connect. T3 Code restarts to apply it.";

const NETWORK_ON_EFFECT = "A phone on the same Wi-Fi or tailnet can connect after you pair it.";

const NETWORK_OFF_EFFECT = "Paired phones lose their connection until you turn this on again.";

const MISSING_DETAIL =
  "The local server on this Mac is not registered. It starts with the desktop app. Restart T3 Code if it does not appear.";

const FAILED_DETAIL = "This app cannot reach the local server. Restart T3 Code to try again.";

const NO_ACCESS_DETAIL =
  "This app cannot make admin pairing links on the local server yet. Restart T3 Code to refresh its access.";

/** The bundled backend's environment among every registered environment. */
export function findBundledBackendEnvironment<
  T extends { readonly entry: { readonly target: ConnectionTarget } },
>(environments: ReadonlyArray<T>): T | null {
  const bundled = environments.find(
    (environment) => desktopLocalBackendId(environment.entry.target) === BK_BUNDLED_BACKEND_ID,
  );
  return bundled ?? null;
}

/** Direct MagicDNS (`http://<mac>.<tailnet>.ts.net:<port>`), not the Tailscale Serve HTTPS URL. */
const DIRECT_MAGIC_DNS_PREFIX = "tailscale-magicdns:http://";

/**
 * Lower ranks first. The MagicDNS name comes first: a Mac shared into other
 * tailnets keeps that one full name in all of them (Tailscale reaches a shared
 * device only by its full `<host>.<tailnet>.ts.net` name), so one link works
 * from every tailnet the Mac is shared with. The Tailscale IP comes next, then
 * the local network IP.
 */
function phoneEndpointRank(endpoint: AdvertisedEndpoint): number {
  if (endpoint.id.startsWith(DIRECT_MAGIC_DNS_PREFIX)) return 0;
  if (endpoint.id.startsWith("tailscale-ip:")) return 1;
  if (endpoint.reachability === "lan") return 2;
  return 3;
}

/**
 * Direct addresses a phone can dial, best first.
 *
 * Only addresses on the bundled server's own port: the Mac's MagicDNS name, its
 * Tailscale IP and its local network IP. No Tailscale Serve (HTTPS) proxy. The
 * server must listen on the network ("Reachable on my network"); while it is
 * limited to this Mac it binds loopback and no direct address reaches it.
 * Loopback and unavailable endpoints never count.
 */
export function phoneReachableEndpoints(input: {
  readonly endpoints: ReadonlyArray<AdvertisedEndpoint>;
  readonly networkAccessible: boolean;
}): ReadonlyArray<AdvertisedEndpoint> {
  if (!input.networkAccessible) return [];
  const reachable = input.endpoints.filter(
    (endpoint) =>
      isQrShareableEndpoint(endpoint) &&
      (endpoint.id.startsWith(DIRECT_MAGIC_DNS_PREFIX) ||
        endpoint.id.startsWith("tailscale-ip:") ||
        endpoint.id.startsWith("desktop-lan:")),
  );
  return reachable.toSorted((left, right) => phoneEndpointRank(left) - phoneEndpointRank(right));
}

/**
 * The pairing link's label, e.g. "Phone (admin) via Tailscale MagicDNS mac.tail.ts.net".
 * The server copies it onto the phone's session, so the paired devices list
 * shows which path each phone uses.
 */
export function phonePairingLabel(endpoint: AdvertisedEndpoint): string {
  let host = endpoint.httpBaseUrl;
  try {
    host = new URL(endpoint.httpBaseUrl).hostname;
  } catch {
    // Keep the raw base URL; the label is informational only.
  }
  return `${LOCAL_PHONE_PAIRING_LABEL} via ${endpoint.label} ${host}`;
}

/** The user's pick while it is still offered, else the best address, else null. */
export function selectPhonePairingEndpoint(
  candidates: ReadonlyArray<AdvertisedEndpoint>,
  selectedId: string | null,
): AdvertisedEndpoint | null {
  const selected =
    selectedId === null ? undefined : candidates.find((endpoint) => endpoint.id === selectedId);
  return selected ?? candidates[0] ?? null;
}

/** The address a phone types by hand: the full URL with its scheme, no trailing slash. */
export function phonePairingHostUrl(endpoint: AdvertisedEndpoint): string {
  return endpoint.httpBaseUrl.replace(/\/+$/u, "");
}

/** `<host>/pair#token=<code>`, which the mobile app reads from a scan or a paste. */
export function phonePairingUrl(endpoint: AdvertisedEndpoint, credential: string): string {
  return resolveDesktopPairingUrl(endpoint.httpBaseUrl, credential);
}

/** Countdown to a pairing code's expiry, e.g. "Expires in 4:05". */
export function phonePairingExpiryLabel(expiresAtMs: number, nowMs: number): string {
  const remainingSeconds = Math.ceil((expiresAtMs - nowMs) / 1_000);
  if (remainingSeconds <= 0) return "Expired. Generate a new link.";
  const minutes = Math.floor(remainingSeconds / 60);
  const seconds = remainingSeconds % 60;
  return `Expires in ${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** The "Reachable on my network" row's description. */
export function networkAccessDescription(input: {
  readonly mode: DesktopServerExposureMode | null;
  readonly loadError: string | null;
}): string {
  if (input.mode === null) return input.loadError ?? "Loading…";
  return input.mode === "network-accessible" ? NETWORK_ON_DESCRIPTION : NETWORK_OFF_DESCRIPTION;
}

/**
 * Confirmation for the network access switch, which relaunches the app. The
 * first line is the question; the confirm dialog shows it as the title and the
 * rest as the description.
 */
export function networkChangeConfirmation(enable: boolean): string {
  const restart = "T3 Code restarts to apply this.";
  if (enable) {
    return `Make the local server reachable on your network?\n${NETWORK_ON_EFFECT} ${restart}`;
  }
  return `Limit the local server to this Mac?\n${NETWORK_OFF_EFFECT} ${restart}`;
}

export type LocalServerStatusKind =
  | "missing"
  | "starting"
  | "failed"
  | "checking"
  | "no-access"
  | "ready";

export interface LocalServerStatus {
  readonly kind: LocalServerStatusKind;
  readonly label: string;
  readonly detail: string;
}

/**
 * What the status row says about the bundled backend, and whether a pairing
 * link can be made. Only `ready` allows one: the renderer's own session on the
 * backend must hold `access:write` for the server to issue an admin link.
 */
export function localServerStatus(input: {
  readonly present: boolean;
  readonly phase: EnvironmentConnectionPhase | null;
  readonly error: string | null;
  readonly sessionChecked: boolean;
  readonly canWriteAccess: boolean;
}): LocalServerStatus {
  if (!input.present) {
    return { kind: "missing", label: "Not running", detail: MISSING_DETAIL };
  }
  if (input.phase === "error" || input.phase === "unsupported") {
    const detail = input.error
      ? `This app cannot reach the local server: ${input.error}`
      : FAILED_DETAIL;
    return { kind: "failed", label: "Not reachable", detail };
  }
  if (input.phase !== "connected") {
    const detail = "The local server is starting. Wait a moment.";
    return { kind: "starting", label: "Starting", detail };
  }
  if (!input.sessionChecked) {
    const detail = "Checking what this app may do on the local server.";
    return { kind: "checking", label: "Connected", detail };
  }
  if (!input.canWriteAccess) {
    return { kind: "no-access", label: "Connected", detail: NO_ACCESS_DETAIL };
  }
  return { kind: "ready", label: "Connected", detail: "Ready to pair a phone." };
}

/** The message for a failed request: the server's own words when it sent any. */
export function describeLocalPairingError(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.trim().length > 0) return cause.message;
  if (typeof cause === "string" && cause.trim().length > 0) return cause;
  return fallback;
}

export interface PairedDevice {
  readonly sessionId: AuthClientSession["sessionId"];
  readonly title: string;
  readonly detail: string;
  readonly connected: boolean;
}

/**
 * Sessions on the local server other than this app's own, as rows for the
 * paired devices list: connected ones first, then the most recently seen.
 * `formatTime` renders a last-seen time; it is injected so tests stay stable.
 */
export function pairedDevices(
  sessions: ReadonlyArray<AuthClientSession>,
  formatTime: (epochMs: number) => string,
): ReadonlyArray<PairedDevice> {
  const lastSeen = (session: AuthClientSession) =>
    session.lastConnectedAt === null ? 0 : DateTime.toEpochMillis(session.lastConnectedAt);
  return sessions
    .filter((session) => !session.current)
    .toSorted(
      (left, right) =>
        Number(right.connected) - Number(left.connected) || lastSeen(right) - lastSeen(left),
    )
    .map((session) => {
      const client = session.client;
      const device =
        client.deviceType === "unknown"
          ? null
          : `${client.deviceType[0]?.toUpperCase() ?? ""}${client.deviceType.slice(1)}`;
      const seen = session.connected
        ? "Connected now"
        : session.lastConnectedAt === null
          ? "Never connected"
          : `Last seen ${formatTime(DateTime.toEpochMillis(session.lastConnectedAt))}`;
      const detail = [device, client.os ?? null, client.ipAddress ?? null, seen]
        .filter((part): part is string => part !== null && part.length > 0)
        .join(" · ");
      return {
        sessionId: session.sessionId,
        title: client.label ?? device ?? session.subject,
        detail,
        connected: session.connected,
      };
    });
}
