// T3-CUSTOM(expbkt3): durable delivery regressions across reconnects and first sends.
import { afterEach, beforeEach, describe, expect, it, vi } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import type { AtomCommandResult } from "../state/runtime.ts";
import { resetThreadOutboxDeliveries } from "./delivery.ts";
import {
  retryQueuedThreadMessage,
  type QueuedThreadMessage,
  type ThreadSettingsSnapshot,
} from "./model.ts";
import { createDurableOutboxReplay } from "./replay.ts";

const environmentId = EnvironmentId.make("environment-1");
const identityKey = "user-1";
const settings: ThreadSettingsSnapshot = {
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "plan",
};
const queued = (id = "a", overrides: Partial<QueuedThreadMessage> = {}): QueuedThreadMessage => ({
  environmentId,
  identityKey,
  threadId: ThreadId.make(`thread-${id}`),
  messageId: MessageId.make(`message-${id}`),
  commandId: CommandId.make(`command-${id}`),
  text: `Continue ${id}`,
  attachments: [],
  createdAt: "2026-10-03T10:00:00.000Z",
  ...overrides,
});
const transientFailure = () =>
  AsyncResult.failure(
    Cause.fail({ _tag: "RpcClientError", message: "An error occurred during Read" }),
  );
const runners: Array<ReturnType<typeof createDurableOutboxReplay>> = [];

function harness(
  initial: ReadonlyArray<QueuedThreadMessage>,
  dispatch: (
    message: QueuedThreadMessage,
    settings: ThreadSettingsSnapshot,
    stillCurrent: () => boolean,
  ) => Promise<AtomCommandResult<unknown, unknown> | null> = async () => AsyncResult.success(1),
) {
  let items = [...initial];
  let connected = false;
  let shellLive = true;
  const threads = new Map(initial.map((message) => [message.threadId, settings]));
  const committed = new Set<string>();
  const discarded: QueuedThreadMessage[] = [];
  const failed: QueuedThreadMessage[] = [];
  const runner = createDurableOutboxReplay({
    environmentId,
    identityKey,
    dispatch,
    discard: async (message) => {
      discarded.push(message);
      items = items.filter((item) => item.messageId !== message.messageId);
      update();
    },
    fail: async (message) => {
      failed.push(message);
      items = items.map((item) => (item.messageId === message.messageId ? message : item));
      update();
    },
  });
  runners.push(runner);
  const update = () =>
    runner.update({
      items,
      connected,
      shellLive,
      threadSettings: (message) => threads.get(message.threadId) ?? null,
      isCommitted: (message) => committed.has(message.messageId),
    });
  return {
    runner,
    threads,
    committed,
    discarded,
    failed,
    update,
    get items() {
      return items;
    },
    connect: () => {
      connected = true;
      update();
    },
    disconnect: () => {
      connected = false;
      update();
    },
    synchronize: (live: boolean) => {
      shellLive = live;
      update();
    },
    save: (message: QueuedThreadMessage) => {
      items = [message];
      update();
    },
    clear: () => {
      items = [];
      update();
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  resetThreadOutboxDeliveries();
});
afterEach(() => {
  for (const runner of runners.splice(0)) runner.dispose();
  vi.useRealTimers();
});

describe("durable outbox replay", () => {
  it.each(["discarded", "replaced"])(
    "ignores a late upload failure after the row was %s",
    async (action) => {
      let reject: (error: Error) => void = () => undefined;
      let attempt = 0;
      const dispatch = vi.fn((_message: QueuedThreadMessage) =>
        ++attempt === 1
          ? new Promise<AtomCommandResult<unknown, unknown>>((_resolve, fail) => {
              reject = fail;
            })
          : Promise.resolve(AsyncResult.success(1)),
      );
      const message = queued();
      const state = harness([message], dispatch);
      state.connect();
      if (action === "discarded") state.clear();
      else state.save({ ...message, commandId: CommandId.make("replacement"), text: "New text" });
      reject(new Error("The file could not be prepared."));
      await vi.advanceTimersByTimeAsync(0);
      expect(state.failed).toEqual([]);
      expect(state.items).toEqual([]);
      if (action === "replaced")
        expect(dispatch.mock.calls[1]?.[0]).toMatchObject({
          commandId: "replacement",
          text: "New text",
        });
      else expect(dispatch).toHaveBeenCalledTimes(1);
    },
  );
  it("retries a fulfilled transport Failure while the connection stays connected", async () => {
    const message = queued();
    let attempt = 0;
    const dispatch = vi.fn(async (_message: QueuedThreadMessage) =>
      ++attempt === 1 ? transientFailure() : AsyncResult.success(1),
    );
    const state = harness([message], dispatch);
    state.connect();
    await vi.advanceTimersByTimeAsync(0);
    expect(state.items).toEqual([message]);
    expect(state.failed).toEqual([]);
    await vi.advanceTimersByTimeAsync(999);
    expect(dispatch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatch.mock.calls[0]?.[0]).toEqual(message);
    expect(dispatch.mock.calls[1]?.[0]).toEqual(message);
    expect(state.items).toEqual([]);
  });

  it("backs off repeated failures and caps the delay at sixteen seconds", async () => {
    const dispatch = vi.fn(async (_message: QueuedThreadMessage) => transientFailure());
    const state = harness([queued()], dispatch);
    state.connect();
    await vi.advanceTimersByTimeAsync(0);
    let calls = 1;
    for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000, 16_000]) {
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(dispatch).toHaveBeenCalledTimes(calls);
      await vi.advanceTimersByTimeAsync(1);
      expect(dispatch).toHaveBeenCalledTimes(++calls);
    }
    expect(state.failed).toEqual([]);
  });

  it("drains queued turns from all threads once the environment reconnects", async () => {
    const a = queued("a");
    const b = queued("b", { createdAt: "2026-10-03T10:01:00.000Z" });
    const dispatch = vi.fn(async (_message: QueuedThreadMessage) => AsyncResult.success(1));
    const state = harness([b, a], dispatch);
    state.update();
    await vi.advanceTimersByTimeAsync(0);
    expect(dispatch).not.toHaveBeenCalled();
    state.connect();
    await vi.advanceTimersByTimeAsync(0);
    expect(dispatch.mock.calls.map(([message]) => message.threadId)).toEqual([
      a.threadId,
      b.threadId,
    ]);
    expect(state.items).toEqual([]);
  });

  it("replays a first-send bootstrap before the thread shell exists", async () => {
    const message = queued("first", {
      bootstrap: {
        createThread: {
          projectId: ProjectId.make("project-1"),
          title: "First turn",
          ...settings,
          branch: null,
          worktreePath: null,
          createdAt: "2026-10-03T09:59:00.000Z",
        },
      },
    });
    const dispatch = vi.fn(async (_message: QueuedThreadMessage) => AsyncResult.success(1));
    const state = harness([message], dispatch);
    state.threads.clear();
    state.connect();
    await vi.advanceTimersByTimeAsync(0);
    expect(dispatch).toHaveBeenCalledWith(message, settings, expect.any(Function));
    expect(state.items).toEqual([]);
  });

  it("waits for an authoritative shell before replaying a missing-thread bootstrap", async () => {
    const message = queued("first", {
      bootstrap: {
        createThread: {
          projectId: ProjectId.make("project-1"),
          title: "First turn",
          ...settings,
          branch: null,
          worktreePath: null,
          createdAt: "2026-10-03T09:59:00.000Z",
        },
      },
    });
    const dispatch = vi.fn(async (_message: QueuedThreadMessage) => AsyncResult.success(1));
    const state = harness([message], dispatch);
    state.threads.clear();
    state.synchronize(false);
    state.connect();
    await vi.advanceTimersByTimeAsync(0);
    expect(dispatch).not.toHaveBeenCalled();
    state.synchronize(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("does not replay another operator's or another environment's payload", async () => {
    const ours = queued("ours");
    const foreign = queued("foreign", { identityKey: "user-2" });
    const remote = queued("remote", { environmentId: EnvironmentId.make("environment-2") });
    const dispatch = vi.fn(async (_message: QueuedThreadMessage) => AsyncResult.success(1));
    const state = harness([foreign, remote, ours], dispatch);
    state.connect();
    await vi.advanceTimersByTimeAsync(0);
    expect(dispatch.mock.calls.map(([message]) => message.messageId)).toEqual([ours.messageId]);
    expect(state.items).toEqual([foreign, remote]);
  });

  it("retains a definitive rejection and only retries an explicit new command", async () => {
    const message = queued();
    let attempt = 0;
    const dispatch = vi.fn(async (_message: QueuedThreadMessage) =>
      ++attempt === 1
        ? AsyncResult.failure(Cause.fail(new Error("The selected model is unavailable.")))
        : AsyncResult.success(1),
    );
    const state = harness([message], dispatch);
    state.connect();
    await vi.advanceTimersByTimeAsync(0);
    expect(state.failed[0]).toMatchObject({
      ...message,
      deliveryState: "failed",
      failureDetail: "The selected model is unavailable.",
    });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(dispatch).toHaveBeenCalledTimes(1);
    state.save(retryQueuedThreadMessage(state.items[0]!, CommandId.make("explicit-retry")));
    await vi.advanceTimersByTimeAsync(0);
    expect(dispatch.mock.calls[1]?.[0]).toMatchObject({
      messageId: message.messageId,
      commandId: "explicit-retry",
    });
    expect(state.items).toEqual([]);
  });

  it("cancels the retry timer when disconnected and resumes after reconnect", async () => {
    const dispatch = vi.fn(async (_message: QueuedThreadMessage) => transientFailure());
    const state = harness([queued()], dispatch);
    state.connect();
    await vi.advanceTimersByTimeAsync(0);
    state.disconnect();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(dispatch).toHaveBeenCalledTimes(1);
    state.connect();
    await vi.advanceTimersByTimeAsync(0);
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it("removes committed messages without dispatching them again", async () => {
    const message = queued();
    const dispatch = vi.fn(async (_message: QueuedThreadMessage) => AsyncResult.success(1));
    const state = harness([message], dispatch);
    state.committed.add(message.messageId);
    state.connect();
    await vi.advanceTimersByTimeAsync(0);
    expect(dispatch).not.toHaveBeenCalled();
    expect(state.items).toEqual([]);
  });

  it("disposes retry timers and ignores a late failed dispatch", async () => {
    let finish: (result: AtomCommandResult<unknown, unknown>) => void = () => undefined;
    const dispatch = vi.fn(
      (_message: QueuedThreadMessage) =>
        new Promise<AtomCommandResult<unknown, unknown>>((resolve) => {
          finish = resolve;
        }),
    );
    const state = harness([queued()], dispatch);
    state.connect();
    state.runner.dispose();
    finish(transientFailure());
    await vi.advanceTimersByTimeAsync(30_000);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(state.failed).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears an already scheduled retry when disposed", async () => {
    const dispatch = vi.fn(async (_message: QueuedThreadMessage) => transientFailure());
    const state = harness([queued()], dispatch);
    state.connect();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);
    state.runner.dispose();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not leave a retry timer after a failure arrives during disconnection", async () => {
    let finish: (result: AtomCommandResult<unknown, unknown>) => void = () => undefined;
    const dispatch = vi.fn(
      (_message: QueuedThreadMessage) =>
        new Promise<AtomCommandResult<unknown, unknown>>((resolve) => {
          finish = resolve;
        }),
    );
    const state = harness([queued()], dispatch);
    state.connect();
    state.disconnect();
    finish(transientFailure());
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(state.failed).toEqual([]);
    state.connect();
    expect(dispatch).toHaveBeenCalledTimes(2);
  });
});
