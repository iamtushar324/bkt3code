import { UserId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { PhaseSidebarOwnerAvatarView } from "./PhaseSidebarOwnerAvatar";

describe("PhaseSidebarOwnerAvatarView", () => {
  const owner = {
    id: UserId.make("user_them"),
    name: "Ada Lovelace",
    email: "ada@example.com",
    imageUrl: "https://example.com/ada.png",
  };

  it("names the owner and keeps the provider-lane sizing", () => {
    const markup = renderToStaticMarkup(
      <PhaseSidebarOwnerAvatarView owner={owner} threadId="thread-1" />,
    );

    expect(markup).toContain('data-testid="phase-thread-owner-thread-1"');
    expect(markup).toContain('aria-label="Started by Ada Lovelace"');
    expect(markup).toContain("size-3.5");
    expect(markup).toContain("https://example.com/ada.png");
  });

  it("falls back to initials for a member with no name or image", () => {
    const markup = renderToStaticMarkup(
      <PhaseSidebarOwnerAvatarView
        owner={{
          id: UserId.make("user_them"),
          name: null,
          email: "grace.hopper@example.com",
          imageUrl: null,
        }}
        threadId="thread-2"
      />,
    );

    expect(markup).toContain('aria-label="Started by grace.hopper@example.com"');
    expect(markup).toContain("GH");
    expect(markup).not.toContain("<img");
  });
});
