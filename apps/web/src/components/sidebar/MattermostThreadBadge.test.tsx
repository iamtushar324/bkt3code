/** T3-CUSTOM(expbkt3): the sidebar's Mattermost conversation badge. */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { MattermostThreadBadge } from "./MattermostThreadBadge";
import { resolvePhaseSidebarMattermostLink } from "./PhaseGroupedSidebar.logic";

describe("resolvePhaseSidebarMattermostLink", () => {
  it("labels a channel link with the channel name", () => {
    expect(
      resolvePhaseSidebarMattermostLink("https://chat.example.com/beknown/channels/co-x-tech"),
    ).toEqual({
      label: "Mattermost · #co-x-tech",
      url: "https://chat.example.com/beknown/channels/co-x-tech",
    });
  });

  it("labels a DM link with the recipient", () => {
    expect(
      resolvePhaseSidebarMattermostLink("https://chat.example.com/beknown/messages/@tushar")?.label,
    ).toBe("Mattermost · @tushar");
  });

  it("falls back to the host for a permalink, which carries no readable name", () => {
    expect(
      resolvePhaseSidebarMattermostLink("https://chat.example.com/beknown/pl/abc123")?.label,
    ).toBe("Mattermost · chat.example.com");
  });

  it("returns null for an absent, blank, or unparseable link", () => {
    expect(resolvePhaseSidebarMattermostLink(null)).toBeNull();
    expect(resolvePhaseSidebarMattermostLink(undefined)).toBeNull();
    expect(resolvePhaseSidebarMattermostLink("   ")).toBeNull();
    expect(resolvePhaseSidebarMattermostLink("not a url")).toBeNull();
  });

  it("rejects a non-http scheme so the menu never opens javascript:", () => {
    expect(resolvePhaseSidebarMattermostLink("javascript:alert(1)")).toBeNull();
  });
});

describe("MattermostThreadBadge", () => {
  it("labels the conversation and keeps the provider-lane sizing", () => {
    const markup = renderToStaticMarkup(
      <MattermostThreadBadge label="Mattermost · #co-x-tech" threadId="thread-1" />,
    );

    expect(markup).toContain('data-testid="phase-thread-mattermost-thread-1"');
    expect(markup).toContain('aria-label="Mattermost · #co-x-tech"');
    expect(markup).toContain("size-3.5");
    expect(markup).toContain("<svg");
  });
});
