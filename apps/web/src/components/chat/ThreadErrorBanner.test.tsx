// T3-CUSTOM(expbkt3): the fork's Retry/Dismiss test renders the banner.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  dismissThreadErrorBannerForSession,
  getThreadErrorBannerKey,
  isThreadErrorBannerDismissedForSession,
  shouldShowThreadErrorBanner,
  // T3-CUSTOM(expbkt3): rendered by the fork's Retry/Dismiss test.
  ThreadErrorBanner,
} from "./ThreadErrorBanner";

describe("ThreadErrorBanner", () => {
  // T3-CUSTOM(expbkt3): recovery and failed outbox actions expose explicit retry/dismiss.
  it("renders Retry and Dismiss actions for exhausted recovery", () => {
    const markup = renderToStaticMarkup(
      <ThreadErrorBanner
        error="Automatic recovery was exhausted."
        onRetry={() => {}}
        onDismiss={() => {}}
      />,
    );

    expect(markup).toContain(">Retry<");
    expect(markup).toContain('aria-label="Dismiss error"');
  });

  it("stays hidden after its current error is dismissed", () => {
    const bannerKey = getThreadErrorBannerKey("env:thread-a", "Aborted");
    dismissThreadErrorBannerForSession(bannerKey);

    expect(
      shouldShowThreadErrorBanner(
        "env:thread-a",
        "Aborted",
        isThreadErrorBannerDismissedForSession(bannerKey),
      ),
    ).toBe(false);
  });

  it("reappears when a new error arrives on the same thread", () => {
    dismissThreadErrorBannerForSession(getThreadErrorBannerKey("env:thread-b", "Turn failed"));
    const newErrorKey = getThreadErrorBannerKey("env:thread-b", "Provider crashed");

    expect(isThreadErrorBannerDismissedForSession(newErrorKey)).toBe(false);
    expect(
      shouldShowThreadErrorBanner(
        "env:thread-b",
        "Provider crashed",
        isThreadErrorBannerDismissedForSession(newErrorKey),
      ),
    ).toBe(true);
  });

  it("scopes dismissals to the thread that dismissed them", () => {
    dismissThreadErrorBannerForSession(getThreadErrorBannerKey("env:thread-c", "Aborted"));
    const otherThreadKey = getThreadErrorBannerKey("env:other-thread", "Aborted");

    expect(isThreadErrorBannerDismissedForSession(otherThreadKey)).toBe(false);
    expect(
      shouldShowThreadErrorBanner(
        "env:other-thread",
        "Aborted",
        isThreadErrorBannerDismissedForSession(otherThreadKey),
      ),
    ).toBe(true);
  });

  it("keeps a dismissal across visiting threads with no error", () => {
    const bannerKey = getThreadErrorBannerKey("env:thread-d", "Aborted");
    dismissThreadErrorBannerForSession(bannerKey);

    expect(shouldShowThreadErrorBanner("env:thread-d", null, false)).toBe(false);
    expect(isThreadErrorBannerDismissedForSession(bannerKey)).toBe(true);
    expect(
      shouldShowThreadErrorBanner(
        "env:thread-d",
        "Aborted",
        isThreadErrorBannerDismissedForSession(bannerKey),
      ),
    ).toBe(false);
  });

  it("never shows a null error", () => {
    expect(shouldShowThreadErrorBanner("env:thread-e", null, false)).toBe(false);
  });
});
