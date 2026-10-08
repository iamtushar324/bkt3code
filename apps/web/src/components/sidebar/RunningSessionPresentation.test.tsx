import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { RunningSessionDivider } from "./RunningSessionDivider";
import { RunningSessionGlint } from "./RunningSessionGlint";

describe("running session presentation", () => {
  it("renders the motion layer as decorative content", () => {
    const markup = renderToStaticMarkup(<RunningSessionGlint />);

    expect(markup).toContain('aria-hidden="true"');
    expect(markup).toContain('class="phase-running-session-glint"');
  });

  it("renders an accessible, quietly labelled section boundary", () => {
    const markup = renderToStaticMarkup(<RunningSessionDivider />);

    expect(markup).toContain('role="separator"');
    // T3-CUSTOM(expbkt3): "Agent work", so it never reads as the MONITORING badge.
    expect(markup).toContain('aria-label="Agent work"');
    expect(markup).toContain("Agent work");
    expect(markup).not.toContain("Monitoring");
    expect(markup).not.toContain(">Running<");
  });
});
