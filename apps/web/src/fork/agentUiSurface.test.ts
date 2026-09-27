/**
 * T3-CUSTOM(expbkt3): the pure half of agent-rendered UI surfaces.
 *
 * `resolveAgentUiSurface` runs on every work-log row in the timeline, before any
 * hooks, so it has to stay total: an unexpected payload shape must fall back to
 * the ordinary tool row rather than throw inside the list renderer.
 */
import { describe, expect, it } from "vite-plus/test";

import { resolveAgentUiSurface } from "./agentUiSurface";
import { isAgentUiSurfaceRenderable } from "./agentUiRuntime";

describe("resolveAgentUiSurface", () => {
  it("reads a well-formed handle", () => {
    expect(
      resolveAgentUiSurface({ agentUi: { renderId: "aui_1", kind: "html", height: 400 } }),
    ).toEqual({ renderId: "aui_1", kind: "html", height: 400 });
  });

  it("returns null for an ordinary work entry", () => {
    expect(resolveAgentUiSurface({})).toBeNull();
    expect(resolveAgentUiSurface({ agentUi: undefined })).toBeNull();
  });

  it("survives payload shapes it was not built for", () => {
    for (const agentUi of [null, "aui_1", 42, [], { renderId: 7 }, { renderId: "" }]) {
      expect(resolveAgentUiSurface({ agentUi })).toBeNull();
    }
  });

  it("defaults the kind to html and only accepts url as the alternative", () => {
    expect(resolveAgentUiSurface({ agentUi: { renderId: "a" } })?.kind).toBe("html");
    expect(resolveAgentUiSurface({ agentUi: { renderId: "a", kind: "url" } })?.kind).toBe("url");
    expect(resolveAgentUiSurface({ agentUi: { renderId: "a", kind: "nonsense" } })?.kind).toBe(
      "html",
    );
  });

  it("clamps a height an agent could otherwise use to take over the transcript", () => {
    expect(resolveAgentUiSurface({ agentUi: { renderId: "a", height: 99_999 } })?.height).toBe(900);
    expect(resolveAgentUiSurface({ agentUi: { renderId: "a", height: -10 } })?.height).toBe(120);
    expect(resolveAgentUiSurface({ agentUi: { renderId: "a", height: "tall" } })?.height).toBe(360);
    expect(resolveAgentUiSurface({ agentUi: { renderId: "a" } })?.height).toBe(360);
  });
});

describe("Agent view runtime gate", () => {
  it("blocks URL targets while leaving agent-authored HTML renderable", () => {
    expect(isAgentUiSurfaceRenderable("html")).toBe(true);
    expect(isAgentUiSurfaceRenderable("url")).toBe(false);
  });
});
