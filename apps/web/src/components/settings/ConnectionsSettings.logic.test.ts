import type { AdvertisedEndpoint, DesktopWslState } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  applyWslEnableSelection,
  endpointDefaultPreferenceKey,
  isTailscaleHttpsEndpoint,
  // T3-CUSTOM(expbkt3): fork pairing-endpoint selection.
  selectPairingEndpoint,
  selectQrEndpointOption,
  togglePairingScopeSelection,
} from "./ConnectionsSettings.logic";

describe("togglePairingScopeSelection", () => {
  it.each([
    {
      label: "adds terminal:read when terminal:operate is selected",
      current: ["orchestration:read"],
      scope: "terminal:operate",
      checked: true,
      expected: ["orchestration:read", "terminal:operate", "terminal:read"],
    },
    {
      label: "drops terminal:operate when terminal:read is cleared",
      current: ["terminal:read", "terminal:operate", "relay:read"],
      scope: "terminal:read",
      checked: false,
      expected: ["relay:read"],
    },
    {
      label: "keeps terminal:read when terminal:operate is cleared",
      current: ["terminal:read", "terminal:operate"],
      scope: "terminal:operate",
      checked: false,
      expected: ["terminal:read"],
    },
    {
      label: "toggles unrelated scopes on their own",
      current: ["terminal:read"],
      scope: "filesystem:read",
      checked: true,
      expected: ["terminal:read", "filesystem:read"],
    },
  ] as const)("$label", ({ current, scope, checked, expected }) => {
    expect(togglePairingScopeSelection(current, scope, checked)).toEqual(expected);
  });
});

const baseWslState: DesktopWslState = {
  enabled: false,
  distro: null,
  available: true,
  wslOnly: true,
  distros: [],
  preflightError: null,
};

describe("applyWslEnableSelection", () => {
  it("clears WSL-only and updates the distro before enabling both backends", async () => {
    const calls: Array<string> = [];
    let persistedWslOnly = true;
    let persistedDistro: string | null = "Ubuntu";
    const setWslDistro = vi.fn(async (distro: string | null) => {
      calls.push(`setWslDistro:${distro ?? "default"}`);
      persistedDistro = distro;
      return { ...baseWslState, distro, wslOnly: persistedWslOnly };
    });
    const setWslBackendEnabled = vi.fn(async (enabled: boolean) => {
      calls.push(`setWslBackendEnabled:${enabled}`);
      return {
        ...baseWslState,
        enabled,
        distro: persistedDistro,
        wslOnly: persistedWslOnly,
      };
    });
    const setWslOnly = vi.fn(async (enabled: boolean) => {
      calls.push(`setWslOnly:${enabled}`);
      persistedWslOnly = enabled;
      return { ...baseWslState, distro: persistedDistro, wslOnly: enabled };
    });

    const state = await applyWslEnableSelection({
      bridge: { setWslDistro, setWslBackendEnabled, setWslOnly },
      mode: "both",
      nextDistro: "Debian",
      persistedDistro: "Ubuntu",
    });

    expect(calls).toEqual(["setWslOnly:false", "setWslDistro:Debian", "setWslBackendEnabled:true"]);
    expect(state).toMatchObject({ enabled: true, distro: "Debian", wslOnly: false });
  });
});

function makeEndpoint(overrides: Partial<AdvertisedEndpoint>): AdvertisedEndpoint {
  return {
    id: "desktop-lan:http://192.168.1.42:4780",
    label: "Local network",
    provider: { id: "desktop-core", label: "Desktop", kind: "core", isAddon: false },
    httpBaseUrl: "http://192.168.1.42:4780",
    wsBaseUrl: "ws://192.168.1.42:4780",
    reachability: "lan",
    compatibility: { hostedHttpsApp: "unknown", desktopApp: "compatible" },
    source: "desktop-core",
    status: "available",
    ...overrides,
  };
}

describe("selectPairingEndpoint", () => {
  const lan = makeEndpoint({ isDefault: true });
  const magicDns = makeEndpoint({
    id: "tailscale-magicdns:http://desktop.tail.ts.net:4780",
    label: "Tailscale MagicDNS",
    provider: { id: "tailscale", label: "Tailscale", kind: "private-network", isAddon: true },
    httpBaseUrl: "http://desktop.tail.ts.net:4780/",
    wsBaseUrl: "ws://desktop.tail.ts.net:4780/",
    reachability: "private-network",
  });
  const https = makeEndpoint({
    ...magicDns,
    id: "tailscale-magicdns:https://desktop.tail.ts.net/",
    httpBaseUrl: "https://desktop.tail.ts.net/",
    wsBaseUrl: "wss://desktop.tail.ts.net/",
  });

  it("prefers direct MagicDNS over the automatic LAN default", () => {
    const selected = selectPairingEndpoint([lan, magicDns, https]);
    expect(selected?.httpBaseUrl).toBe("http://desktop.tail.ts.net:4780/");
    expect(selected && isTailscaleHttpsEndpoint(selected)).toBe(false);
  });

  it("honors explicit LAN and HTTPS preferences", () => {
    expect(selectPairingEndpoint([lan, magicDns, https], "desktop-core:lan:http")).toBe(lan);
    expect(selectPairingEndpoint([lan, magicDns, https], "tailscale:magicdns:https")).toBe(https);
  });

  it("keeps the MagicDNS preference when the Mac's hostname or server port changes", () => {
    const moved = makeEndpoint({
      ...magicDns,
      id: "tailscale-magicdns:http://renamed.tail.ts.net:5000",
      httpBaseUrl: "http://renamed.tail.ts.net:5000/",
    });
    expect(selectPairingEndpoint([lan, moved], endpointDefaultPreferenceKey(magicDns))).toBe(moved);
  });

  it("falls back to LAN when MagicDNS is unavailable", () => {
    expect(
      selectPairingEndpoint(
        [lan, { ...magicDns, status: "unavailable" }],
        "tailscale:magicdns:http",
      ),
    ).toBe(lan);
    expect(selectPairingEndpoint([{ ...magicDns, status: "unavailable" }])).toBeNull();
  });
});

describe("selectQrEndpointOption", () => {
  const options = [
    {
      id: "desktop-loopback:4780",
      preferenceKey: "desktop-core:loopback:http",
      qrShareable: false,
    },
    {
      id: "tailscale-ip:http://100.84.12.7:4780",
      preferenceKey: "tailscale:ip:http",
      qrShareable: true,
    },
    {
      id: "tailscale-ip:http://100.84.12.8:4780",
      preferenceKey: "tailscale:ip:http",
      qrShareable: true,
    },
    {
      id: "desktop-lan:http://192.168.1.42:4780",
      preferenceKey: "desktop-core:lan:http",
      qrShareable: true,
    },
  ];

  it("resolves an explicit selection by unique endpoint id, not the shared preference key", () => {
    expect(selectQrEndpointOption(options, "tailscale-ip:http://100.84.12.8:4780", null)?.id).toBe(
      "tailscale-ip:http://100.84.12.8:4780",
    );
  });

  it("skips non-QR-shareable options in the fallback so the panel never opens on loopback", () => {
    expect(selectQrEndpointOption(options, "tailscale-ip:gone", "nope")?.id).toBe(
      "tailscale-ip:http://100.84.12.7:4780",
    );
  });
});
