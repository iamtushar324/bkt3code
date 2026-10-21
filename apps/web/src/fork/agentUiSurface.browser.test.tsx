import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../test/render";

const testState = vi.hoisted(() => ({
  queryCalls: [] as string[],
  queries: new Map<
    string,
    {
      data?: { render: Record<string, unknown> };
      isPending: boolean;
      error?: string;
    }
  >(),
}));

vi.mock("../hooks/useSettings", () => ({
  useClientSettings: (selector: (settings: { agentUiSurfacesEnabled: boolean }) => unknown) =>
    selector({ agentUiSurfacesEnabled: true }),
}));
vi.mock("../state/agentUi", () => ({
  agentUiEnvironment: {
    render: ({ input }: { input: { renderId: string } }) => {
      testState.queryCalls.push(input.renderId);
      return input;
    },
  },
}));
vi.mock("../state/query", () => ({
  useEnvironmentQuery: ({ renderId }: { renderId: string }) =>
    testState.queries.get(renderId) ?? { isPending: true },
}));

import { useAgentUiExpandedStore } from "../agentUiExpandedStore";
import { AgentUiExpandedSurface, AgentUiRenderFrame, AgentUiSurfaceRow } from "./agentUiSurface";

const THREAD_REF = {
  environmentId: EnvironmentId.make("environment-fixture"),
  threadId: ThreadId.make("thread-fixture"),
} as const;
const FIRST_URL = "https://fixture.example.test/board#room=alpha,safe-key-a";
const SECOND_URL = "https://fixture.example.test/board#room=beta,safe-key-b";

function setup() {
  testState.queryCalls.length = 0;
  testState.queries.clear();
  useAgentUiExpandedStore.setState({ expandedByThread: {} });
}

function mount(ui: ReactNode) {
  // These surfaces use no links or router hooks, and the exact-text assertions need the tree
  // committed when render resolves rather than after the test router loads.
  return render(ui, { router: false });
}

function iframes(container: HTMLElement): HTMLIFrameElement[] {
  return [...container.querySelectorAll("iframe")];
}

describe("Agent view runtime mitigation", () => {
  it("leaves a URL surface as the ordinary tool row even when the setting is on", async () => {
    setup();
    await using screen = await mount(
      <AgentUiSurfaceRow
        threadRef={THREAD_REF}
        surface={{ renderId: "aui_alpha", kind: "url", height: 360 }}
      >
        <span>ordinary tool row</span>
      </AgentUiSurfaceRow>,
    );

    expect(screen.container.textContent).toBe("ordinary tool row");
    expect(iframes(screen.container)).toHaveLength(0);
    expect(testState.queryCalls).toEqual([]);
  });

  it("mounts an agent-authored HTML surface in a scripts-only sandbox", async () => {
    setup();
    testState.queries.set("aui_html", {
      data: {
        render: {
          renderId: "aui_html",
          title: "Option 1",
          kind: "html",
          html: "<p>baked</p>",
          createdAt: "2026-08-31T18:57:27.170Z",
        },
      },
      isPending: false,
    });

    await using screen = await mount(
      <AgentUiSurfaceRow
        threadRef={THREAD_REF}
        surface={{ renderId: "aui_html", kind: "html", height: 360 }}
      >
        <span>ordinary tool row</span>
      </AgentUiSurfaceRow>,
    );

    const frames = iframes(screen.container);
    expect(frames).toHaveLength(1);
    // An unmodified `allow-scripts` sandbox keeps the opaque origin, which is
    // what makes running the agent's scripts safe.
    expect(frames[0]!.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frames[0]!.getAttribute("srcdoc")).toContain("baked");
    // The upstream row is kept, not replaced.
    expect(screen.container.textContent).toContain("ordinary tool row");
    expect(testState.queryCalls).toContain("aui_html");
  });

  it("opens the expanded surface for a render the user asked to expand", async () => {
    setup();
    useAgentUiExpandedStore.getState().expand({ threadRef: THREAD_REF, renderId: "aui_alpha" });

    await using screen = await mount(<AgentUiExpandedSurface threadRef={THREAD_REF} />);
    expect(screen.container.textContent).toContain("Loading view");
    expect(testState.queryCalls).toEqual(["aui_alpha"]);
  });

  it("shows only the active thread’s fullscreen view and restores each selection on return", async () => {
    setup();
    const otherThread = { ...THREAD_REF, threadId: ThreadId.make("other-thread") };
    const otherEnvironment = {
      ...THREAD_REF,
      environmentId: EnvironmentId.make("other-environment"),
    };
    for (const renderId of ["aui_alpha", "aui_beta"]) {
      testState.queries.set(renderId, {
        data: { render: { renderId, title: renderId, kind: "html", html: `<p>${renderId}</p>` } },
        isPending: false,
      });
    }
    useAgentUiExpandedStore.getState().expand({ threadRef: THREAD_REF, renderId: "aui_alpha" });

    await using screen = await mount(<AgentUiExpandedSurface threadRef={THREAD_REF} />);
    const { container } = screen;
    expect(iframes(container)[0]!.getAttribute("srcdoc")).toContain("aui_alpha");
    await screen.rerender(<AgentUiExpandedSurface threadRef={otherThread} />);
    expect(iframes(container)).toHaveLength(0);
    expect(container.textContent).toBe("");
    const callsBeforeHiddenNavigation = testState.queryCalls.length;
    await screen.rerender(<AgentUiExpandedSurface threadRef={otherEnvironment} />);
    await screen.rerender(<AgentUiExpandedSurface threadRef={null} />);
    expect(iframes(container)).toHaveLength(0);
    expect(testState.queryCalls).toHaveLength(callsBeforeHiddenNavigation);

    await act(() => {
      useAgentUiExpandedStore.getState().expand({ threadRef: otherThread, renderId: "aui_beta" });
    });
    await screen.rerender(<AgentUiExpandedSurface threadRef={otherThread} />);
    expect(iframes(container)[0]!.getAttribute("srcdoc")).toContain("aui_beta");
    await screen.rerender(<AgentUiExpandedSurface threadRef={THREAD_REF} />);
    expect(iframes(container)[0]!.getAttribute("srcdoc")).toContain("aui_alpha");
    expect(container.textContent).not.toContain("aui_beta");
    await screen.rerender(<AgentUiExpandedSurface threadRef={otherThread} />);
    expect(iframes(container)[0]!.getAttribute("srcdoc")).toContain("aui_beta");
  });

  it("never mounts either exact same-origin room URL if the inner frame is called directly", async () => {
    setup();
    for (const [renderId, url] of [
      ["aui_alpha", FIRST_URL],
      ["aui_beta", SECOND_URL],
    ] as const) {
      testState.queries.set(renderId, {
        data: {
          render: {
            renderId,
            title: renderId,
            kind: "url",
            url,
            createdAt: "2026-08-29T10:00:00.000Z",
          },
        },
        isPending: false,
      });
    }

    await using screen = await mount(
      <AgentUiRenderFrame threadRef={THREAD_REF} renderId="aui_alpha" />,
    );
    expect(iframes(screen.container)).toHaveLength(0);
    expect(screen.container.textContent).toContain("URL Agent views are temporarily disabled");

    await screen.rerender(<AgentUiRenderFrame threadRef={THREAD_REF} renderId="aui_beta" />);
    expect(iframes(screen.container)).toHaveLength(0);
    expect(screen.container.textContent).toContain("URL Agent views are temporarily disabled");
    expect(FIRST_URL).not.toBe(SECOND_URL);
    expect(testState.queryCalls).toEqual(["aui_alpha", "aui_beta"]);
  });
});
