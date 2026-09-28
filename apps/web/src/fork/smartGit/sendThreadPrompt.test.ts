// T3-CUSTOM(expbkt3): smart git prompts ride upstream's queued-message store.
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => ({
  shell: null as Record<string, unknown> | null,
}));

vi.mock("~/state/entities", () => ({
  readThreadShell: () => testState.shell,
  readThread: () => ({ activities: [] }),
}));

import { useQueuedMessageStore } from "~/queuedMessageStore";
import { sendThreadPrompt } from "./sendThreadPrompt";

const THREAD_REF = {
  environmentId: EnvironmentId.make("environment-fixture"),
  threadId: ThreadId.make("thread-fixture"),
};
const THREAD_KEY = scopedThreadKey(THREAD_REF);
const MODEL = { instanceId: "codex", model: "gpt-5" };

function shell(status: string | null, overrides: Record<string, unknown> = {}) {
  return {
    modelSelection: MODEL,
    runtimeMode: "full-access",
    interactionMode: "default",
    session: status === null ? null : { status },
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    ...overrides,
  };
}

function queue() {
  return useQueuedMessageStore.getState().queuesByThreadKey[THREAD_KEY] ?? [];
}

beforeEach(() => {
  useQueuedMessageStore.setState({ queuesByThreadKey: {}, lastDispatchByThreadKey: {} });
  testState.shell = null;
});

describe("sendThreadPrompt", () => {
  it("does nothing for a thread the server does not know yet", () => {
    expect(sendThreadPrompt(THREAD_REF, "Commit")).toBe("unavailable");
    expect(queue()).toEqual([]);
  });

  it("sends at once on an idle thread, with the thread's own settings", () => {
    testState.shell = shell("ready");
    expect(sendThreadPrompt(THREAD_REF, "Commit")).toBe("send");
    expect(queue()).toHaveLength(1);
    expect(queue()[0]).toMatchObject({
      prompt: "Commit",
      images: [],
      files: [],
      sendSettings: {
        modelSelection: MODEL,
        runtimeMode: "full-access",
        interactionMode: "default",
        promptEffort: null,
      },
    });
    expect(queue()[0]?.holdUntilUserAction).toBeUndefined();
  });

  it.each([
    { name: "running turn", thread: shell("running") },
    { name: "starting session", thread: shell("starting") },
    { name: "pending approval", thread: shell("ready", { hasPendingApprovals: true }) },
    { name: "pending question", thread: shell("ready", { hasPendingUserInput: true }) },
  ])("queues behind a $name", ({ thread }) => {
    testState.shell = thread;
    expect(sendThreadPrompt(THREAD_REF, "Commit")).toBe("queue");
    expect(queue()).toHaveLength(1);
  });

  it("queues behind a message that will still leave on its own", () => {
    testState.shell = shell("ready");
    sendThreadPrompt(THREAD_REF, "First");
    expect(sendThreadPrompt(THREAD_REF, "Commit")).toBe("queue");
    expect(queue().map((message) => message.prompt)).toEqual(["First", "Commit"]);
  });

  it("does not queue the same request twice", () => {
    testState.shell = shell("running");
    sendThreadPrompt(THREAD_REF, "Commit");
    expect(sendThreadPrompt(THREAD_REF, "Commit")).toBe("duplicate");
    expect(queue()).toHaveLength(1);
  });
});
