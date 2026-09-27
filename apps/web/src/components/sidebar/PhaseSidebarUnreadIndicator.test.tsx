import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { PhaseSidebarUnreadIndicator } from "./PhaseSidebarUnreadIndicator";

describe("PhaseSidebarUnreadIndicator", () => {
  it("labels an unread session without exposing lifecycle status text", () => {
    const markup = renderToStaticMarkup(
      <PhaseSidebarUnreadIndicator isUnread threadId="thread-1" />,
    );

    expect(markup).toContain('data-testid="phase-thread-unread-thread-1"');
    expect(markup).toContain('aria-label="Unread session"');
    expect(markup).toContain("bg-emerald-500");
    expect(markup).toContain("size-[9px]");
    expect(markup).not.toContain("Completed");
    expect(markup).not.toContain("Planning");
    expect(markup).not.toContain("Implementing");
  });

  it("keeps the leading alignment slot empty for a read session", () => {
    const markup = renderToStaticMarkup(
      <PhaseSidebarUnreadIndicator isUnread={false} threadId="thread-1" />,
    );

    expect(markup).toContain('data-testid="phase-thread-unread-slot-thread-1"');
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).not.toContain('data-testid="phase-thread-unread-thread-1"');
    expect(markup).not.toContain("Unread session");
    expect(markup).not.toContain("bg-emerald-500");
  });
});
