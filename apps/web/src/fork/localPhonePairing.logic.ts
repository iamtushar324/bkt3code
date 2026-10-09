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
import type { AdvertisedEndpoint, DesktopServerExposureMode } from "@t3tools/contracts";

import {
  isQrShareableEndpoint,
  isTailscaleHttpsEndpoint,
} from "../components/settings/ConnectionsSettings.logic";
import { resolveDesktopPairingUrl } from "../components/settings/pairingUrls";
import { desktopLocalBackendId } from "../connection/desktopLocal";
import { BK_BUNDLED_BACKEND_ID } from "./managedEnvironment";

/** Label stored on the pairing link, shown later in the server's client list. */
export const LOCAL_PHONE_PAIRING_LABEL = "Phone (admin)";

export const PAIR_PHONE_DESCRIPTION =
  "Make a link, code and QR code for the T3 Code app on your phone. The phone gets admin access to this Mac's server. The code works once and expires after 5 minutes.";

export const NO_PHONE_ADDRESS_MESSAGE =
  "No address that a phone can reach. Turn on “Reachable on my network” or “Tailscale HTTPS” above.";

const NETWORK_ON_DESCRIPTION =
  "Phones on the same Wi-Fi or tailnet can reach the local server. Turning this off restarts T3 Code.";

const NETWORK_OFF_DESCRIPTION =
  "Only this Mac can reach the local server. Turn this on to let a phone on the same Wi-Fi or tailnet connect. T3 Code restarts to apply it.";

const TAILSCALE_MISSING_DESCRIPTION =
  "Start Tailscale on this Mac to serve the local server over HTTPS on your tailnet.";

const TAILSCALE_OFF_DESCRIPTION =
  "Serve the local server over HTTPS on your tailnet with Tailscale Serve. Works even while the server is limited to this Mac. T3 Code restarts to apply it.";

const NETWORK_ON_EFFECT = "A phone on the same Wi-Fi or tailnet can connect after you pair it.";

const NETWORK_OFF_EFFECT =
  "Phones connected over your network lose their connection. Tailscale HTTPS keeps working.";

const TAILSCALE_OFF_EFFECT = "Phones that use the Tailscale HTTPS address lose their connection.";

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

/**
 * Lower ranks first. Tailscale HTTPS works from anywhere on the tailnet and even
 * while the server listens on loopback only; a direct tailnet address beats a
 * LAN one because it keeps working when the phone leaves the Wi-Fi.
 */
function phoneEndpointRank(endpoint: AdvertisedEndpoint): number {
  if (isTailscaleHttpsEndpoint(endpoint)) return 0;
  if (endpoint.id.startsWith("tailscale-magicdns:http://")) return 1;
  if (endpoint.id.startsWith("tailscale-ip:")) return 2;
  if (endpoint.reachability === "private-network") return 3;
  if (endpoint.reachability === "lan") return 4;
  return 5;
}

/**
 * Addresses a phone can dial, best first.
 *
 * Mirrors the Connections page: while the server is limited to this machine it
 * binds loopback, so only Tailscale Serve (which proxies to loopback) reaches
 * it; direct addresses count only once network access is on. Loopback and
 * unavailable endpoints never count, because a phone dialling them reaches
 * itself or nothing.
 */
export function phoneReachableEndpoints(input: {
  readonly endpoints: ReadonlyArray<AdvertisedEndpoint>;
  readonly networkAccessible: boolean;
}): ReadonlyArray<AdvertisedEndpoint> {
  const reachable = input.endpoints.filter(
    (endpoint) =>
      isQrShareableEndpoint(endpoint) &&
      (input.networkAccessible || isTailscaleHttpsEndpoint(endpoint)),
  );
  return reachable.toSorted((left, right) => phoneEndpointRank(left) - phoneEndpointRank(right));
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

/** The "Tailscale HTTPS" row's description. No endpoint means Tailscale is not running. */
export function tailscaleHttpsDescription(endpoint: AdvertisedEndpoint | null): string {
  if (endpoint === null) return TAILSCALE_MISSING_DESCRIPTION;
  if (endpoint.status !== "available") return TAILSCALE_OFF_DESCRIPTION;
  const host = phonePairingHostUrl(endpoint);
  return `Serving ${host}. Works even while the server is limited to this Mac.`;
}

/**
 * Confirmation for a desktop bridge change. Both changes relaunch the app, so
 * each one asks first. The first line is the question; the confirm dialog shows
 * it as the title and the rest as the description.
 */
export function bridgeChangeConfirmation(input: {
  readonly kind: "network" | "tailscale";
  readonly enable: boolean;
  readonly tailscalePort: number;
}): string {
  const restart = "T3 Code restarts to apply this.";
  if (input.kind === "network" && input.enable) {
    return `Make the local server reachable on your network?\n${NETWORK_ON_EFFECT} ${restart}`;
  }
  if (input.kind === "network") {
    return `Limit the local server to this Mac?\n${NETWORK_OFF_EFFECT} ${restart}`;
  }
  if (input.enable) {
    const port = input.tailscalePort;
    const effect = `Tailscale Serve shares it on your tailnet over HTTPS (port ${port}).`;
    return `Turn on Tailscale HTTPS?\n${effect} ${restart}`;
  }
  return `Turn off Tailscale HTTPS?\n${TAILSCALE_OFF_EFFECT} ${restart}`;
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
