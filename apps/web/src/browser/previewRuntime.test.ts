import type { EnvironmentId } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  desktop: false,
  primary: null as string | null,
  serverBrowser: new Set<string>(),
}));

vi.mock("~/env", () => ({ isElectron: false }));
vi.mock("~/previewStateStore", () => ({ isPreviewSupportedInRuntime: () => state.desktop }));
vi.mock("~/rpc/atomRegistry", () => ({ appAtomRegistry: { get: () => state.primary } }));
vi.mock("~/state/primaryEnvironment", () => ({ primaryEnvironmentIdAtom: {} }));
vi.mock("~/state/entities", () => ({
  readEnvironmentSupportsServerBrowser: (id: string) => state.serverBrowser.has(id),
  useEnvironmentSupportsServerBrowser: () => false,
}));
// T3-CUSTOM(expbkt3): BEGIN — the fork's host `previewBrowser` setting picks the runtime.
// Its default, `client`, keeps a desktop app's tabs in its own browser.
vi.mock("~/fork/desktopOwnEnvironment", () => ({ desktopOwnEnvironmentIdAtom: {} }));
vi.mock("~/fork/previewBrowserHost", async () => {
  const { resolvePreviewRuntime } = await vi.importActual<
    typeof import("~/fork/previewBrowserHost.logic")
  >("~/fork/previewBrowserHost.logic");
  return {
    forkPreviewRuntimeFor: (_environmentId: string, serverBrowser: boolean) =>
      resolvePreviewRuntime({
        serverBrowser,
        desktopBrowser: state.desktop,
        previewBrowser: "client",
      }),
  };
});
// T3-CUSTOM(expbkt3): END

import { alternatePreviewRuntime, previewRuntimeFor } from "./previewRuntime";

const local = "local" as EnvironmentId;
const remote = "remote" as EnvironmentId;

afterEach(() => {
  state.desktop = false;
  state.primary = null;
  state.serverBrowser = new Set();
});

describe("previewRuntimeFor", () => {
  it("opens a remote environment's tabs on this computer in the desktop app", () => {
    state.desktop = true;
    state.primary = local;
    state.serverBrowser = new Set([local, remote]);

    expect(previewRuntimeFor(remote)).toBeUndefined();
    // T3-CUSTOM(expbkt3): under the default `client` setting the desktop app keeps its tabs.
    expect(previewRuntimeFor(local)).toBeUndefined();
  });

  it("uses the environment's browser where the client has none of its own", () => {
    state.serverBrowser = new Set([remote]);

    expect(previewRuntimeFor(remote)).toBe("server");
  });
});

describe("alternatePreviewRuntime", () => {
  it("moves a remote environment's tab between this computer and the environment", () => {
    state.desktop = true;

    expect(alternatePreviewRuntime(remote, local, true, {})).toBe("server");
    expect(alternatePreviewRuntime(remote, local, true, { runtime: "server" })).toBe("desktop");
    expect(alternatePreviewRuntime(local, local, true, {})).toBeNull();
    expect(alternatePreviewRuntime(remote, local, false, {})).toBeNull();
  });

  it("offers no move outside the desktop app", () => {
    expect(alternatePreviewRuntime(remote, null, true, { runtime: "server" })).toBeNull();
  });
});
