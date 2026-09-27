import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { PlanReviewCommentComposer } from "./PlanReviewCommentComposer";

function render(body: string, quotedText = "Backfill the rows") {
  return renderToStaticMarkup(
    <PlanReviewCommentComposer
      quotedText={quotedText}
      body={body}
      onBodyChange={() => {}}
      onSubmit={() => {}}
      onCancel={() => {}}
    />,
  );
}

describe("PlanReviewCommentComposer", () => {
  /**
   * The composer used to float inside the scrolling document. Focusing it
   * scrolled the plan, throwing the reviewer from wherever they were reading
   * back to the top. It docks now, and must not regress to positioned layout.
   */
  it("is docked, not positioned over the document", () => {
    // Asserted on the root element's own classes: the button utilities below it
    // legitimately mention `absolute`, so a whole-markup search would lie.
    const rootClass = /^<div class="([^"]*)"/.exec(render(""))?.[1] ?? "";

    expect(rootClass).toContain("border-t");
    expect(rootClass).not.toContain("absolute");
    expect(rootClass).not.toContain("fixed");
    expect(rootClass).not.toContain("sticky");
  });

  it("is big enough to write in and capped so it cannot swallow the plan", () => {
    const markup = render("");

    expect(markup).toContain("min-height:6rem");
    expect(markup).toContain("max-height:30vh");
  });

  it("shows the quoted anchor and the keyboard shortcuts", () => {
    const markup = render("", "Ticket: new prospect threads");

    expect(markup).toContain("Ticket: new prospect threads");
    expect(markup).toContain("Esc to cancel");
    expect(markup).toContain("Enter to comment");
  });

  it("cannot submit an empty comment", () => {
    // The rendered attribute, not the `disabled:` utility classes every button carries.
    expect(render("")).toContain('disabled=""');
    expect(render("Batch this.")).not.toContain('disabled=""');
    expect(render("   ")).toContain('disabled=""');
  });
});
