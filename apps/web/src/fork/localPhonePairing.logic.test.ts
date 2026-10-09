// T3-CUSTOM(expbkt3): BK Add-ons → "Connect phone to local server" pure logic.
import {
  BearerConnectionTarget,
  PrimaryConnectionTarget,
} from "@t3tools/client-runtime/connection";
import { type AdvertisedEndpoint, EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { desktopLocalConnectionId } from "../connection/desktopLocal";
import {
  bridgeChangeConfirmation,
  describeLocalPairingError,
  findBundledBackendEnvironment,
  localServerStatus,
  networkAccessDescription,
  phonePairingExpiryLabel,
  phonePairingHostUrl,
  phonePairingUrl,
  phoneReachableEndpoints,
  selectPhonePairingEndpoint,
  tailscaleHttpsDescription,
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

  it("offers only Tailscale HTTPS while the server is limited to this Mac", () => {
    const limited = phoneReachableEndpoints({ endpoints: all, networkAccessible: false });
    expect(limited).toEqual([tailscaleHttps]);
    const serveOff = [loopback, lan, tailscaleHttpsOff];
    expect(phoneReachableEndpoints({ endpoints: serveOff, networkAccessible: false })).toEqual([]);
  });

  it("ranks Tailscale HTTPS, then direct tailnet addresses, then the LAN", () => {
    const ranked = phoneReachableEndpoints({ endpoints: all, networkAccessible: true });
    expect(ranked).toEqual([tailscaleHttps, magicDns, tailnetIp, lan]);
  });

  it("never offers loopback or an unavailable endpoint", () => {
    const endpoints = [loopback, tailscaleHttpsOff, lan];
    expect(phoneReachableEndpoints({ endpoints, networkAccessible: true })).toEqual([lan]);
    const onlyLoopback = { endpoints: [loopback], networkAccessible: true };
    expect(phoneReachableEndpoints(onlyLoopback)).toEqual([]);
  });
});

describe("selectPhonePairingEndpoint", () => {
  const candidates = [tailscaleHttps, magicDns, lan];

  it("keeps the user's pick while it is offered", () => {
    expect(selectPhonePairingEndpoint(candidates, lan.id)).toBe(lan);
  });

  it("falls back to the best address when the pick is gone or absent", () => {
    const stale = "desktop-lan:http://10.0.0.9:3774";
    expect(selectPhonePairingEndpoint(candidates, stale)).toBe(tailscaleHttps);
    expect(selectPhonePairingEndpoint(candidates, null)).toBe(tailscaleHttps);
    expect(selectPhonePairingEndpoint([], null)).toBeNull();
  });
});

describe("phone pairing link", () => {
  const code = "ABCDEF123456";

  it("puts the code in the fragment of the endpoint's /pair page", () => {
    const httpsLink = `https://mac.tail.ts.net/pair#token=${code}`;
    const tailnetLink = `http://100.64.0.7:3774/pair#token=${code}`;
    expect(phonePairingUrl(tailscaleHttps, code)).toBe(httpsLink);
    expect(phonePairingUrl(tailnetIp, code)).toBe(tailnetLink);
  });

  it("shows the host with its scheme and without a trailing slash", () => {
    expect(phonePairingHostUrl(tailscaleHttps)).toBe("https://mac.tail.ts.net");
    expect(phonePairingHostUrl(magicDns)).toBe("http://mac.tail.ts.net:3774");
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

  it("describes Tailscale HTTPS by whether Serve is up", () => {
    expect(tailscaleHttpsDescription(null)).toContain("Start Tailscale");
    expect(tailscaleHttpsDescription(tailscaleHttpsOff)).toContain("Tailscale Serve");
    expect(tailscaleHttpsDescription(tailscaleHttps)).toContain("https://mac.tail.ts.net");
  });

  it("asks one question per confirmation, which the dialog uses as its title", () => {
    const confirmations = [
      bridgeChangeConfirmation({ kind: "network", enable: true, tailscalePort: 443 }),
      bridgeChangeConfirmation({ kind: "network", enable: false, tailscalePort: 443 }),
      bridgeChangeConfirmation({ kind: "tailscale", enable: true, tailscalePort: 8443 }),
      bridgeChangeConfirmation({ kind: "tailscale", enable: false, tailscalePort: 443 }),
    ];
    for (const confirmation of confirmations) {
      const lines = confirmation.split("\n");
      expect(lines[0]?.endsWith("?")).toBe(true);
      expect(lines.filter((line) => line.trim().endsWith("?"))).toHaveLength(1);
      expect(confirmation).toContain("T3 Code restarts");
    }
    expect(confirmations[2]).toContain("8443");
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
