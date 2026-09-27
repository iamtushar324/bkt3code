/** T3-CUSTOM(expbkt3): expanded agent views follow their environment/thread. */
import { describe, expect, it, beforeEach } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { selectExpandedAgentUiView, useAgentUiExpandedStore } from "./agentUiExpandedStore";

const threadRef = {
  environmentId: EnvironmentId.make("env-1"),
  threadId: ThreadId.make("thread-1"),
};
const otherThreadRef = { ...threadRef, threadId: ThreadId.make("thread-2") };
const otherEnvironmentRef = { ...threadRef, environmentId: EnvironmentId.make("env-2") };
const selected = (ref: typeof threadRef | null) =>
  selectExpandedAgentUiView(useAgentUiExpandedStore.getState(), ref);

describe("useAgentUiExpandedStore", () => {
  beforeEach(() => {
    useAgentUiExpandedStore.setState({ expandedByThread: {} });
  });

  it("hides the view on another thread and restores it when returning", () => {
    const view = { threadRef, renderId: "aui_1" };
    useAgentUiExpandedStore.getState().expand(view);
    expect(selected(threadRef)).toEqual(view);
    expect(selected(otherThreadRef)).toBeNull();
    expect(selected(null)).toBeNull();
    expect(selected(threadRef)).toEqual(view);
  });

  it("retains independent expanded views across threads and environments", () => {
    const store = useAgentUiExpandedStore.getState();
    store.expand({ threadRef, renderId: "aui_1" });
    store.expand({ threadRef: otherThreadRef, renderId: "aui_2" });
    store.expand({ threadRef: otherEnvironmentRef, renderId: "aui_3" });
    expect(selected(threadRef)?.renderId).toBe("aui_1");
    expect(selected(otherThreadRef)?.renderId).toBe("aui_2");
    expect(selected(otherEnvironmentRef)?.renderId).toBe("aui_3");

    store.collapse(otherThreadRef);
    expect(selected(otherThreadRef)).toBeNull();
    expect(selected(threadRef)?.renderId).toBe("aui_1");
    expect(selected(otherEnvironmentRef)?.renderId).toBe("aui_3");
  });

  it("replaces a view within its thread and keeps an explicit close on return", () => {
    const store = useAgentUiExpandedStore.getState();
    store.expand({ threadRef, renderId: "aui_1" });
    store.expand({ threadRef, renderId: "aui_2" });
    expect(selected(threadRef)?.renderId).toBe("aui_2");
    store.collapse(threadRef);
    expect(selected(otherThreadRef)).toBeNull();
    expect(selected(threadRef)).toBeNull();
  });

  it("does not notify subscribers when closing a thread with no expanded view", () => {
    const initial = useAgentUiExpandedStore.getState();
    initial.collapse(threadRef);
    expect(useAgentUiExpandedStore.getState()).toBe(initial);
  });
});
