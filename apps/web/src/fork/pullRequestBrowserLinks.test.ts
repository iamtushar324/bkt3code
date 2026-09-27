import { describe, expect, it } from "vite-plus/test";

import { resolvePullRequestBrowserTarget } from "./pullRequestBrowserLinks";

const PR_URL = "https://github.com/beknown-work/bkt3code/pull/206";

describe("resolvePullRequestBrowserTarget", () => {
  const base = {
    nativeViewEnabled: false,
    url: PR_URL,
    hasThread: true,
    previewSupported: true,
  } as const;

  it("opens a pull request in the integrated browser while the native view is off", () => {
    expect(resolvePullRequestBrowserTarget(base)).toBe("app");
  });

  it("leaves the click to the native view when it is on", () => {
    expect(resolvePullRequestBrowserTarget({ ...base, nativeViewEnabled: true })).toBe("native");
  });

  it("does not take over links that are not pull requests", () => {
    expect(
      resolvePullRequestBrowserTarget({ ...base, url: "https://github.com/beknown-work/bkt3code" }),
    ).toBe("native");
  });

  it("falls back to an ordinary link with no thread to open the browser beside", () => {
    expect(resolvePullRequestBrowserTarget({ ...base, hasThread: false })).toBe("link");
  });

  it("falls back to an ordinary link where the runtime has no integrated browser", () => {
    expect(resolvePullRequestBrowserTarget({ ...base, previewSupported: false })).toBe("link");
  });
});
