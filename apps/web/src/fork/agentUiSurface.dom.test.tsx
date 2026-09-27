import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

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

class TestNode {
  parentNode: TestNode | null = null;
  childNodes: TestNode[] = [];
  readonly attributes = new Map<string, string>();
  readonly nodeName: string;
  readonly tagName: string;
  readonly namespaceURI = "http://www.w3.org/1999/xhtml";
  readonly style = {};
  nodeValue: string | null = null;

  constructor(
    name: string,
    readonly ownerDocument: TestNode | null = null,
    readonly nodeType = 1,
  ) {
    this.nodeName = name.toUpperCase();
    this.tagName = this.nodeName;
  }

  set textContent(value: string) {
    this.childNodes = [];
    this.nodeValue = value;
  }

  get textContent(): string {
    return this.nodeValue ?? this.childNodes.map((child) => child.textContent).join("");
  }

  appendChild(child: TestNode) {
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }

  insertBefore(child: TestNode, before: TestNode | null) {
    if (before === null) return this.appendChild(child);
    const index = this.childNodes.indexOf(before);
    child.parentNode = this;
    this.childNodes.splice(index, 0, child);
    return child;
  }

  removeChild(child: TestNode) {
    this.childNodes.splice(this.childNodes.indexOf(child), 1);
    child.parentNode = null;
    return child;
  }

  createElement(name: string) {
    return new TestNode(name, this);
  }

  // The card's icons are SVG, so React reaches for the namespaced factory.
  createElementNS(_namespace: string, name: string) {
    return new TestNode(name, this);
  }

  createTextNode(value: string) {
    const node = new TestNode("#text", this, 3);
    node.nodeValue = value;
    return node;
  }

  setAttribute(name: string, value: string) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name: string) {
    this.attributes.delete(name);
  }

  addEventListener() {}
  removeEventListener() {}
}

function installTestDom() {
  const document = new TestNode("#document", null, 9);
  const window = {
    document,
    HTMLIFrameElement: TestNode,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    addEventListener() {},
    removeEventListener() {},
  };
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", window);
  vi.stubGlobal("HTMLIFrameElement", TestNode);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  return document;
}

/** HTML attribute names are case-insensitive; this fake DOM stores them verbatim. */
function attribute(node: TestNode, name: string): string | null {
  for (const [key, value] of node.attributes) {
    if (key.toLowerCase() === name.toLowerCase()) return value;
  }
  return null;
}

function iframeNodes(root: TestNode): TestNode[] {
  return root.childNodes.flatMap((child) => [
    ...(child.tagName === "IFRAME" ? [child] : []),
    ...iframeNodes(child),
  ]);
}

function renderedText(root: TestNode): string {
  return [
    ...(root.childNodes.length === 0 && root.nodeValue !== null ? [root.nodeValue] : []),
    ...root.childNodes.map(renderedText),
  ].join("");
}

async function render(root: { render: (children: ReactNode) => void }, children: ReactNode) {
  flushSync(() => root.render(children));
  await Promise.resolve();
  flushSync(() => undefined);
}

describe("Agent view runtime mitigation", () => {
  beforeEach(() => {
    testState.queryCalls.length = 0;
    testState.queries.clear();
    useAgentUiExpandedStore.setState({ expandedByThread: {} });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => setImmediate(resolve));
    vi.unstubAllGlobals();
  });

  it("leaves a URL surface as the ordinary tool row even when the setting is on", async () => {
    const document = installTestDom();
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    const root = createRoot(container as unknown as Element);

    try {
      await render(
        root,
        <AgentUiSurfaceRow
          threadRef={THREAD_REF}
          surface={{ renderId: "aui_alpha", kind: "url", height: 360 }}
        >
          <span>ordinary tool row</span>
        </AgentUiSurfaceRow>,
      );

      expect(renderedText(container)).toBe("ordinary tool row");
      expect(iframeNodes(container)).toHaveLength(0);
      expect(testState.queryCalls).toEqual([]);
    } finally {
      flushSync(() => root.unmount());
    }
  });

  it("mounts an agent-authored HTML surface in a scripts-only sandbox", async () => {
    const document = installTestDom();
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    const root = createRoot(container as unknown as Element);
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

    try {
      await render(
        root,
        <AgentUiSurfaceRow
          threadRef={THREAD_REF}
          surface={{ renderId: "aui_html", kind: "html", height: 360 }}
        >
          <span>ordinary tool row</span>
        </AgentUiSurfaceRow>,
      );

      const frames = iframeNodes(container);
      expect(frames).toHaveLength(1);
      // An unmodified `allow-scripts` sandbox keeps the opaque origin, which is
      // what makes running the agent's scripts safe.
      expect(attribute(frames[0]!, "sandbox")).toBe("allow-scripts");
      expect(attribute(frames[0]!, "srcdoc")).toContain("baked");
      // The upstream row is kept, not replaced.
      expect(renderedText(container)).toContain("ordinary tool row");
      expect(testState.queryCalls).toContain("aui_html");
    } finally {
      flushSync(() => root.unmount());
    }
  });

  it("opens the expanded surface for a render the user asked to expand", async () => {
    const document = installTestDom();
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    const root = createRoot(container as unknown as Element);
    useAgentUiExpandedStore.getState().expand({ threadRef: THREAD_REF, renderId: "aui_alpha" });

    try {
      await render(root, <AgentUiExpandedSurface threadRef={THREAD_REF} />);
      expect(renderedText(container)).toContain("Loading view");
      expect(testState.queryCalls).toEqual(["aui_alpha"]);
    } finally {
      flushSync(() => root.unmount());
    }
  });

  it("shows only the active thread’s fullscreen view and restores each selection on return", async () => {
    const document = installTestDom();
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    const root = createRoot(container as unknown as Element);
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

    try {
      await render(root, <AgentUiExpandedSurface threadRef={THREAD_REF} />);
      expect(attribute(iframeNodes(container)[0]!, "srcdoc")).toContain("aui_alpha");
      await render(root, <AgentUiExpandedSurface threadRef={otherThread} />);
      expect(iframeNodes(container)).toHaveLength(0);
      expect(renderedText(container)).toBe("");
      const callsBeforeHiddenNavigation = testState.queryCalls.length;
      await render(root, <AgentUiExpandedSurface threadRef={otherEnvironment} />);
      await render(root, <AgentUiExpandedSurface threadRef={null} />);
      expect(iframeNodes(container)).toHaveLength(0);
      expect(testState.queryCalls).toHaveLength(callsBeforeHiddenNavigation);

      flushSync(() => {
        useAgentUiExpandedStore.getState().expand({ threadRef: otherThread, renderId: "aui_beta" });
      });
      await render(root, <AgentUiExpandedSurface threadRef={otherThread} />);
      expect(attribute(iframeNodes(container)[0]!, "srcdoc")).toContain("aui_beta");
      await render(root, <AgentUiExpandedSurface threadRef={THREAD_REF} />);
      expect(attribute(iframeNodes(container)[0]!, "srcdoc")).toContain("aui_alpha");
      expect(renderedText(container)).not.toContain("aui_beta");
      await render(root, <AgentUiExpandedSurface threadRef={otherThread} />);
      expect(attribute(iframeNodes(container)[0]!, "srcdoc")).toContain("aui_beta");
    } finally {
      flushSync(() => root.unmount());
    }
  });

  it("never mounts either exact same-origin room URL if the inner frame is called directly", async () => {
    const document = installTestDom();
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    const root = createRoot(container as unknown as Element);
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

    try {
      await render(root, <AgentUiRenderFrame threadRef={THREAD_REF} renderId="aui_alpha" />);
      expect(iframeNodes(container)).toHaveLength(0);
      expect(renderedText(container)).toContain("URL Agent views are temporarily disabled");

      await render(root, <AgentUiRenderFrame threadRef={THREAD_REF} renderId="aui_beta" />);
      expect(iframeNodes(container)).toHaveLength(0);
      expect(renderedText(container)).toContain("URL Agent views are temporarily disabled");
      expect(FIRST_URL).not.toBe(SECOND_URL);
      expect(testState.queryCalls).toEqual(["aui_alpha", "aui_beta"]);
    } finally {
      flushSync(() => root.unmount());
    }
  });
});
