import { describe, expect, it } from "vite-plus/test";

import { PRIMARY_LOCAL_ENVIRONMENT_ID } from "@t3tools/contracts";

import { BK_BUNDLED_BACKEND_ID, resolveBkClientRendererSource } from "./BkManagedEnvironment.ts";

describe("BkManagedDesktop", () => {
  it("serves packaged client assets while connecting to the managed backend", () => {
    expect(
      resolveBkClientRendererSource({
        managedHttpBaseUrl: "https://expbkt3.dev.beknown.live",
        isDevelopment: false,
        devServerUrl: null,
        clientAssetsDirectory: "/Applications/Stage BK T3 Code.app/client",
      }),
    ).toEqual({
      targetOrigin: new URL("https://expbkt3.dev.beknown.live"),
      backendOrigin: new URL("https://expbkt3.dev.beknown.live"),
      clientAssetsDirectory: "/Applications/Stage BK T3 Code.app/client",
    });
  });

  it("uses the Vite renderer in development while keeping the managed backend origin", () => {
    const devServerUrl = new URL("http://127.0.0.1:5733");
    expect(
      resolveBkClientRendererSource({
        managedHttpBaseUrl: "https://expbkt3.dev.beknown.live",
        isDevelopment: true,
        devServerUrl,
        clientAssetsDirectory: "/unused",
      }),
    ).toEqual({
      targetOrigin: devServerUrl,
      backendOrigin: new URL("https://expbkt3.dev.beknown.live"),
    });
  });

  it("registers the bundled backend under a secondary id, never the pool primary", () => {
    // The renderer's secondary-bootstrap reader filters the primary id out
    // (it is same-origin in upstream desktop builds); the bundled backend must
    // therefore never claim it, or it would silently vanish from the client.
    expect(BK_BUNDLED_BACKEND_ID).not.toBe(PRIMARY_LOCAL_ENVIRONMENT_ID);
    expect(BK_BUNDLED_BACKEND_ID).toBe("bk-local");
  });
});
