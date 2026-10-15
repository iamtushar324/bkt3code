import { describe, expect, it } from "vite-plus/test";

import { resolveWidePlanBox } from "./planCardLayout";
import { isHtmlPlan, planHtmlTitle, splitPlanSegments } from "./planContent";
import { planHtmlDocument, planHtmlFrameHeight } from "./planHtml";
import { planCardTitle, summarizePlan } from "./planSummary";

const PAGE =
  "<!doctype html>\n<html><head><title>Rollout &amp; risks</title></head><body><h1>x</h1></body></html>";

describe("splitPlanSegments", () => {
  it("keeps a Markdown plan as one Markdown part", () => {
    const plan = "# Ship it\n\n1. Build\n2. Test";
    expect(splitPlanSegments(plan)).toEqual([{ kind: "markdown", text: plan }]);
  });

  it("renders a whole-document plan as one page titled from the document", () => {
    expect(splitPlanSegments(PAGE)).toEqual([
      { kind: "html", html: PAGE, title: "Rollout & risks" },
    ]);
    expect(planCardTitle(PAGE, "Proposed plan")).toBe("Rollout & risks");
  });

  it("treats a balanced root element as an HTML plan, but not an inline example", () => {
    expect(isHtmlPlan('<div class="plan"><h2>Steps</h2></div>')).toBe(true);
    expect(isHtmlPlan("<div>example</div>\n\nThen change the parser.")).toBe(false);
  });

  it("splits html-render fences out of Markdown and leaves plain html fences as code", () => {
    const plan = [
      "# Plan",
      "",
      "```html-render",
      "<h2>Chart</h2><svg></svg>",
      "```",
      "",
      "```html",
      "<p>markup the plan proposes</p>",
      "```",
    ].join("\n");
    expect(splitPlanSegments(plan)).toEqual([
      { kind: "markdown", text: "# Plan\n" },
      { kind: "html", html: "<h2>Chart</h2><svg></svg>", title: "Chart" },
      {
        kind: "markdown",
        text: "\n```html\n<p>markup the plan proposes</p>\n```",
      },
    ]);
  });

  it("lifts a raw HTML document out of a Markdown plan up to its closing tag", () => {
    const plan = `# Title\n\nIntro.\n\n${PAGE}\n\nAfter.`;
    const segments = splitPlanSegments(plan);
    expect(segments.map((segment) => segment.kind)).toEqual(["markdown", "html", "markdown"]);
    expect(segments[1]).toMatchObject({ kind: "html", html: PAGE });
  });

  it("does not lift a document that sits inside a code fence", () => {
    const plan = `Example:\n\n\`\`\`\n${PAGE}\n\`\`\``;
    expect(splitPlanSegments(plan)).toEqual([{ kind: "markdown", text: plan }]);
  });

  it("falls back to the given title for an untitled page", () => {
    expect(planHtmlTitle("<p>no title</p>")).toBeNull();
    expect(splitPlanSegments("```html-render\n<p>x</p>\n```", "Plan")).toEqual([
      { kind: "html", html: "<p>x</p>", title: "Plan" },
    ]);
  });
});

describe("planHtmlDocument", () => {
  it("adds the chat theme bootstrap, then a transparent page background the page can override", () => {
    const document = planHtmlDocument(
      "<html><head><style>html{background:red}</style></head></html>",
    );
    const theme = document.indexOf('<style id="t3-theme">');
    const transparent = document.indexOf("html{background:transparent}");
    const own = document.indexOf("html{background:red}");
    expect(theme).toBeGreaterThan(-1);
    expect(transparent).toBeGreaterThan(theme);
    expect(own).toBeGreaterThan(transparent);
  });

  it("fits the frame to the page within sane bounds", () => {
    expect(planHtmlFrameHeight(undefined)).toBe(320);
    expect(planHtmlFrameHeight(10)).toBe(80);
    expect(planHtmlFrameHeight(1234.4)).toBe(1234);
    expect(planHtmlFrameHeight(1_000_000)).toBe(16_000);
  });
});

describe("resolveWidePlanBox", () => {
  const area = { left: 0, right: 1600 };

  it("grows evenly around a centred column, capped for readability", () => {
    expect(resolveWidePlanBox({ lane: { left: 432, right: 1168 }, area, padding: 20 })).toEqual({
      offset: -272,
      width: 1280,
    });
  });

  it("uses the whole free band when it is narrower than the cap", () => {
    expect(
      resolveWidePlanBox({
        lane: { left: 232, right: 968 },
        area: { left: 0, right: 1200 },
        padding: 20,
      }),
    ).toEqual({ offset: -212, width: 1160 });
  });

  it("stops before a floating card on the right and slides left instead", () => {
    expect(
      resolveWidePlanBox({
        lane: { left: 300, right: 1036 },
        area,
        padding: 20,
        obstacles: [1100],
      }),
    ).toEqual({ offset: -280, width: 1060 });
  });

  it("ignores floating things that already overlap or sit left of the column", () => {
    expect(
      resolveWidePlanBox({ lane: { left: 300, right: 1036 }, area, padding: 20, obstacles: [500] }),
    ).toEqual({ offset: -272, width: 1280 });
  });

  it("has nothing to offer when the column already fills the area", () => {
    expect(resolveWidePlanBox({ lane: { left: 20, right: 1580 }, area, padding: 20 })).toBeNull();
  });
});

describe("summarizePlan", () => {
  it("counts top-level steps and task items, not code or nested lines", () => {
    const plan = [
      "# Plan",
      "1. First",
      "2. Second",
      "   1. nested detail",
      "- [ ] Check CI",
      "```",
      "1. not a step",
      "```",
    ].join("\n");
    expect(summarizePlan(plan)).toEqual({ steps: 3, readMinutes: 1 });
  });

  it("estimates reading time from the words, including HTML text", () => {
    const words = Array.from({ length: 660 }, () => "word").join(" ");
    expect(summarizePlan(words).readMinutes).toBe(3);
    expect(
      summarizePlan(`<html><body><p>${words}</p><script>${words}</script></body></html>`),
    ).toEqual({
      steps: 0,
      readMinutes: 3,
    });
  });
});
