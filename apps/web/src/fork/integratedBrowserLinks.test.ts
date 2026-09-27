import { describe, expect, it } from "vite-plus/test";

import { effectiveBrowserLinkTarget } from "./effectiveBrowserLinkTarget";
import { shouldInterceptLinkClick } from "./integratedBrowserLinks";

describe("effectiveBrowserLinkTarget", () => {
  it("opens links in the app while the flag is on, whatever the preference says", () => {
    expect(
      effectiveBrowserLinkTarget({
        openLinksInIntegratedBrowser: true,
        browserLinkTarget: "system",
      }),
    ).toBe("app");
  });

  it("returns to the Open links in preference while the flag is off", () => {
    expect(
      effectiveBrowserLinkTarget({
        openLinksInIntegratedBrowser: false,
        browserLinkTarget: "system",
      }),
    ).toBe("system");
    expect(
      effectiveBrowserLinkTarget({ openLinksInIntegratedBrowser: false, browserLinkTarget: "app" }),
    ).toBe("app");
  });
});

describe("shouldInterceptLinkClick", () => {
  const plainClick = {
    enabled: true,
    defaultPrevented: false,
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    href: "https://linear.app/beknown/issue/TEC-1",
    hasDownload: false,
    appOrigin: "https://bkt3.dev.beknown.live",
  };

  it("takes a plain click on an external link", () => {
    expect(shouldInterceptLinkClick(plainClick)).toBe(true);
  });

  it("leaves Cmd/Ctrl and other modified clicks to the system browser", () => {
    for (const modifier of ["metaKey", "ctrlKey", "shiftKey", "altKey"] as const) {
      expect(shouldInterceptLinkClick({ ...plainClick, [modifier]: true })).toBe(false);
    }
  });

  it("leaves a link something else already handled", () => {
    expect(shouldInterceptLinkClick({ ...plainClick, defaultPrevented: true })).toBe(false);
  });

  it("leaves the app's own routes, downloads and non-web links alone", () => {
    expect(
      shouldInterceptLinkClick({ ...plainClick, href: "https://bkt3.dev.beknown.live/settings" }),
    ).toBe(false);
    expect(shouldInterceptLinkClick({ ...plainClick, hasDownload: true })).toBe(false);
    expect(shouldInterceptLinkClick({ ...plainClick, href: "mailto:someone@example.com" })).toBe(
      false,
    );
  });

  it("does nothing while the flag is off or for a non-primary button", () => {
    expect(shouldInterceptLinkClick({ ...plainClick, enabled: false })).toBe(false);
    expect(shouldInterceptLinkClick({ ...plainClick, button: 1 })).toBe(false);
  });
});
