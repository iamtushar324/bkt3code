// T3-CUSTOM(expbkt3): smart git prompts retain settings and native queue intent.
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
const testState = vi.hoisted(() => ({
  shell: null as Record<string, unknown> | null,
  commands: [] as Array<{ input: Record<string, unknown> }>,
}));
vi.mock("~/state/entities", () => ({ readThreadShell: () => testState.shell }));
vi.mock("~/rpc/atomRegistry", () => ({ appAtomRegistry: { get: () => null } }));
vi.mock("~/state/threads", () => ({
  environmentThreadDetails: { threadAtom: () => ({}) },
  threadEnvironment: { startTurn: {} },
}));
vi.mock("~/state/identity", () => ({ currentClerkUserAtom: {} }));
vi.mock("../environmentOperatorIdentity", () => ({
  readEnvironmentOperatorUserId: () => "user-fixture",
}));
vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  runAtomCommand: (
    _registry: unknown,
    _command: unknown,
    target: { input: Record<string, unknown> },
  ) => {
    testState.commands.push(target);
    return new Promise(() => {});
  },
}));
import { sendThreadPrompt } from "./sendThreadPrompt";
const THREAD_REF = {
  environmentId: EnvironmentId.make("environment-fixture"),
  threadId: ThreadId.make("thread-fixture"),
};
const MODEL = { instanceId: "codex", model: "gpt-5" };
function shell(status: string | null, extra: Record<string, unknown> = {}) {
  return {
    modelSelection: MODEL,
    runtimeMode: "full-access",
    interactionMode: "plan",
    runtime: status === null ? null : { status },
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    ...extra,
  };
}
describe("sendThreadPrompt", () => {
  it("does nothing for a thread the server does not know", () => {
    testState.shell = null;
    expect(sendThreadPrompt(THREAD_REF, "Unknown")).toBe("unavailable");
  });
  it("sends an action in build mode without access to the composer draft", () => {
    testState.shell = shell("idle");
    expect(sendThreadPrompt(THREAD_REF, "Commit idle")).toBe("send");
    expect(testState.commands.at(-1)?.input).toMatchObject({
      message: { text: "Commit idle", role: "user", attachments: [] },
      modelSelection: MODEL,
      runtimeMode: "full-access",
      interactionMode: "default",
      outboxIdentityKey: "user-fixture",
      dispatchMode: "auto",
    });
  });
  it.each(["running", "starting", "preparing"])("queues behind a %s runtime", (status) => {
    testState.shell = shell(status);
    expect(sendThreadPrompt(THREAD_REF, `Commit ${status}`)).toBe("queue");
    expect(testState.commands.at(-1)?.input).toMatchObject({ dispatchMode: "queue" });
  });
  it("does not duplicate a command that is still on the wire", () => {
    testState.shell = shell("running");
    expect(sendThreadPrompt(THREAD_REF, "Unique duplicate")).toBe("queue");
    expect(sendThreadPrompt(THREAD_REF, "Unique duplicate")).toBe("duplicate");
  });
});
