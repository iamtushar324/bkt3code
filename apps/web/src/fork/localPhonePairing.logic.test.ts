// T3-CUSTOM(expbkt3): BK Add-ons → "Connect phone to local server" pure logic.
import {
  BearerConnectionTarget,
  PrimaryConnectionTarget,
} from "@t3tools/client-runtime/connection";
import {
  type AdvertisedEndpoint,
  type AuthClientSession,
  AuthSessionId,
  EnvironmentId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { desktopLocalConnectionId } from "../connection/desktopLocal";
import {
  describeLocalPairingError,
  findBundledBackendEnvironment,
  localServerStatus,
  networkAccessDescription,
  networkChangeConfirmation,
  pairedDevices,
  phonePairingExpiryLabel,
  phonePairingHostUrl,
  phonePairingLabel,
  phonePairingUrl,
  phoneReachableEndpoints,
  selectPhonePairingEndpoint,
} from "./localPhonePairing.logic";

function makeEndpoint(overrides: Partial<AdvertisedEndpoint>): AdvertisedEndpoint {
  return {
    id: "desktop-lan:http://192.168.1.42:3774",
    label: "Local network",
    provider: { id: "desktop-core", label: "Desktop", kind: "core", isAddon: false },
    httpBaseUrl: "http://192.168.1.42:3774",
    wsBaseUrl: "ws://192.168.1.42:3774",
    reachability: "lan",
    compatibility: { hostedHttpsApp: "unknown", desktopApp: "compatible" },
    source: "desktop-core",
    status: "available",
    ...overrides,
  };
}

const TAILSCALE: AdvertisedEndpoint["provider"] = {
  id: "tailscale",
  label: "Tailscale",
  kind: "private-network",
  isAddon: true,
};

const loopback = makeEndpoint({
  id: "desktop-loopback:3774",
  label: "This machine",
  httpBaseUrl: "http://127.0.0.1:3774",
  wsBaseUrl: "ws://127.0.0.1:3774",
  reachability: "loopback",
});
const lan = makeEndpoint({});
const tailnetIp = makeEndpoint({
  id: "tailscale-ip:http://100.64.0.7:3774",
  label: "Tailscale IP",
  provider: TAILSCALE,
  httpBaseUrl: "http://100.64.0.7:3774",
  wsBaseUrl: "ws://100.64.0.7:3774",
  reachability: "private-network",
  source: "desktop-addon",
});
const magicDns = makeEndpoint({
  id: "tailscale-magicdns:http://mac.tail.ts.net:3774",
  label: "Tailscale MagicDNS",
  provider: TAILSCALE,
  httpBaseUrl: "http://mac.tail.ts.net:3774",
  wsBaseUrl: "ws://mac.tail.ts.net:3774",
  reachability: "private-network",
  source: "desktop-addon",
});
const tailscaleHttps = makeEndpoint({
  id: "tailscale-magicdns:https://mac.tail.ts.net",
  label: "Tailscale HTTPS",
  provider: TAILSCALE,
  httpBaseUrl: "https://mac.tail.ts.net/",
  wsBaseUrl: "wss://mac.tail.ts.net/",
  reachability: "private-network",
  source: "desktop-addon",
});
const tailscaleHttpsOff = makeEndpoint({ ...tailscaleHttps, status: "unavailable" });

describe("findBundledBackendEnvironment", () => {
  const primary = {
    entry: {
      target: new PrimaryConnectionTarget({
        environmentId: EnvironmentId.make("environment-central"),
        httpBaseUrl: "https://stagebkt3.dev.beknown.live",
        label: "stagebkt3",
        wsBaseUrl: "wss://stagebkt3.dev.beknown.live",
      }),
    },
  };
  const wsl = {
    entry: {
      target: new BearerConnectionTarget({
        connectionId: desktopLocalConnectionId("wsl:Ubuntu"),
        environmentId: EnvironmentId.make("environment-wsl"),
        label: "WSL (Ubuntu)",
      }),
    },
  };
  const bundled = {
    entry: {
      target: new BearerConnectionTarget({
        connectionId: desktopLocalConnectionId("bk-local"),
        environmentId: EnvironmentId.make("environment-bundled"),
        label: "Local",
      }),
    },
  };

  it("finds the managed build's bundled backend by its pool id", () => {
    expect(findBundledBackendEnvironment([primary, wsl, bundled])).toBe(bundled);
  });

  it("is null when the bundled backend is not registered", () => {
    expect(findBundledBackendEnvironment([primary, wsl])).toBeNull();
  });
});

describe("phoneReachableEndpoints", () => {
  const all = [loopback, lan, tailnetIp, magicDns, tailscaleHttps];

  it("offers nothing while the server is limited to this Mac", () => {
    expect(phoneReachableEndpoints({ endpoints: all, networkAccessible: false })).toEqual([]);
  });

  it("offers MagicDNS first, then the Tailscale IP, then the local network IP", () => {
    const ranked = phoneReachableEndpoints({ endpoints: all, networkAccessible: true });
    expect(ranked).toEqual([magicDns, tailnetIp, lan]);
  });

  it("never offers Tailscale Serve, loopback or an unavailable endpoint", () => {
    const endpoints = [loopback, tailscaleHttpsOff, tailscaleHttps];
    expect(phoneReachableEndpoints({ endpoints, networkAccessible: true })).toEqual([]);
    const lanOff = makeEndpoint({ status: "unavailable" });
    expect(phoneReachableEndpoints({ endpoints: [lanOff], networkAccessible: true })).toEqual([]);
  });
});

describe("selectPhonePairingEndpoint", () => {
  const candidates = [magicDns, tailnetIp, lan];

  it("keeps the user's pick while it is offered", () => {
    expect(selectPhonePairingEndpoint(candidates, lan.id)).toBe(lan);
  });

  it("falls back to the best address when the pick is gone or absent", () => {
    const stale = "tailscale-ip:http://100.80.1.2:3774";
    expect(selectPhonePairingEndpoint(candidates, stale)).toBe(magicDns);
    expect(selectPhonePairingEndpoint(candidates, null)).toBe(magicDns);
    expect(selectPhonePairingEndpoint([], null)).toBeNull();
  });
});

describe("phone pairing link", () => {
  const code = "ABCDEF123456";

  it("puts the code in the fragment of the endpoint's /pair page", () => {
    const tailnetLink = `http://100.64.0.7:3774/pair#token=${code}`;
    const lanLink = `http://192.168.1.42:3774/pair#token=${code}`;
    expect(phonePairingUrl(tailnetIp, code)).toBe(tailnetLink);
    expect(phonePairingUrl(lan, code)).toBe(lanLink);
  });

  it("shows the host with its scheme and without a trailing slash", () => {
    expect(phonePairingHostUrl(tailscaleHttps)).toBe("https://mac.tail.ts.net");
    expect(phonePairingHostUrl(tailnetIp)).toBe("http://100.64.0.7:3774");
  });

  it("names the path in the label the paired session keeps", () => {
    expect(phonePairingLabel(magicDns)).toBe(
      "Phone (admin) via Tailscale MagicDNS mac.tail.ts.net",
    );
    expect(phonePairingLabel(tailnetIp)).toBe("Phone (admin) via Tailscale IP 100.64.0.7");
    expect(phonePairingLabel(lan)).toBe("Phone (admin) via Local network 192.168.1.42");
  });
});

describe("phonePairingExpiryLabel", () => {
  const issuedAt = 1_000_000;
  const expired = "Expired. Generate a new link.";

  it("counts down in minutes and seconds", () => {
    expect(phonePairingExpiryLabel(issuedAt + 300_000, issuedAt)).toBe("Expires in 5:00");
    expect(phonePairingExpiryLabel(issuedAt + 59_100, issuedAt)).toBe("Expires in 1:00");
    expect(phonePairingExpiryLabel(issuedAt + 9_000, issuedAt)).toBe("Expires in 0:09");
  });

  it("says when the code has expired", () => {
    expect(phonePairingExpiryLabel(issuedAt, issuedAt)).toBe(expired);
    expect(phonePairingExpiryLabel(issuedAt - 1, issuedAt)).toBe(expired);
  });
});

describe("localServerStatus", () => {
  const connected = {
    present: true,
    phase: "connected" as const,
    error: null,
    sessionChecked: true,
    canWriteAccess: true,
  };

  it("is ready only when connected with access:write", () => {
    expect(localServerStatus(connected).kind).toBe("ready");
    expect(localServerStatus({ ...connected, canWriteAccess: false }).kind).toBe("no-access");
    expect(localServerStatus({ ...connected, sessionChecked: false }).kind).toBe("checking");
  });

  it("explains a missing, starting or failed server", () => {
    expect(localServerStatus({ ...connected, present: false }).kind).toBe("missing");
    expect(localServerStatus({ ...connected, phase: "connecting" }).kind).toBe("starting");
    const failed = localServerStatus({ ...connected, phase: "error", error: "port in use" });
    expect(failed.kind).toBe("failed");
    expect(failed.detail).toContain("port in use");
  });
});

describe("row copy", () => {
  it("describes network access per exposure mode", () => {
    const loading = networkAccessDescription({ mode: null, loadError: null });
    const failed = networkAccessDescription({ mode: null, loadError: "Bridge failed." });
    const limited = networkAccessDescription({ mode: "local-only", loadError: null });
    const open = networkAccessDescription({ mode: "network-accessible", loadError: null });
    expect(loading).toBe("Loading…");
    expect(failed).toBe("Bridge failed.");
    expect(limited).toContain("Only this Mac");
    expect(open).toContain("same Wi-Fi");
  });

  it("asks one question per confirmation, which the dialog uses as its title", () => {
    for (const confirmation of [
      networkChangeConfirmation(true),
      networkChangeConfirmation(false),
    ]) {
      const lines = confirmation.split("\n");
      expect(lines[0]?.endsWith("?")).toBe(true);
      expect(lines.filter((line) => line.trim().endsWith("?"))).toHaveLength(1);
      expect(confirmation).toContain("T3 Code restarts");
    }
  });
});

describe("pairedDevices", () => {
  const at = (iso: string) => DateTime.makeUnsafe(iso);
  const session = (overrides: Partial<AuthClientSession>): AuthClientSession => ({
    sessionId: AuthSessionId.make("session-phone"),
    userId: null,
    subject: "pairing:anonymous",
    scopes: [],
    method: "bearer-access-token",
    client: { label: "Phone (admin) via Tailscale IP 100.64.0.7", deviceType: "mobile" },
    issuedAt: at("2026-10-09T10:00:00Z"),
    expiresAt: at("2126-10-09T10:00:00Z"),
    lastConnectedAt: at("2026-10-09T11:00:00Z"),
    connected: false,
    current: false,
    ...overrides,
  });
  const formatTime = (epochMs: number) => new Date(epochMs).toISOString();

  it("leaves out this app's own session and lists connected devices first", () => {
    const own = session({ sessionId: AuthSessionId.make("session-own"), current: true });
    const older = session({ sessionId: AuthSessionId.make("session-old") });
    const live = session({
      sessionId: AuthSessionId.make("session-live"),
      client: { label: "Phone (admin) via Local network 192.168.1.42", deviceType: "mobile" },
      connected: true,
    });
    const rows = pairedDevices([own, older, live], formatTime);
    expect(rows.map((row) => row.sessionId)).toEqual(["session-live", "session-old"]);
    expect(rows[0]?.detail).toBe("Mobile · Connected now");
    expect(rows[1]?.title).toBe("Phone (admin) via Tailscale IP 100.64.0.7");
    expect(rows[1]?.detail).toBe("Mobile · Last seen 2026-10-09T11:00:00.000Z");
  });

  it("falls back to the device type, then the subject, for a session without a label", () => {
    const unlabeled = session({ client: { deviceType: "mobile" }, lastConnectedAt: null });
    expect(pairedDevices([unlabeled], formatTime)[0]).toMatchObject({
      title: "Mobile",
      detail: "Mobile · Never connected",
    });
    const unknown = session({ client: { deviceType: "unknown" } });
    expect(pairedDevices([unknown], formatTime)[0]?.title).toBe("pairing:anonymous");
  });
});

describe("describeLocalPairingError", () => {
  it("prefers the server's message and falls back otherwise", () => {
    const fallback = "fallback";
    const serverError = new Error("needs access:write");
    expect(describeLocalPairingError(serverError, fallback)).toBe("needs access:write");
    expect(describeLocalPairingError("timed out", fallback)).toBe("timed out");
    expect(describeLocalPairingError(new Error("  "), fallback)).toBe(fallback);
    expect(describeLocalPairingError({ code: 1 }, fallback)).toBe(fallback);
  });
});
