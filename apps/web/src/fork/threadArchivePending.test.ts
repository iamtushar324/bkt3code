// T3-CUSTOM(expbkt3): archive progress and duplicate requests across web entry points.
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  isThreadArchivePending,
  runWithThreadArchivePending,
  useThreadArchivePendingStore,
} from "./threadArchivePending";

const thread = (environmentId = "environment-a", threadId = "thread-a") => ({
  environmentId: EnvironmentId.make(environmentId),
  threadId: ThreadId.make(threadId),
});

function deferred<A>() {
  let resolve!: (value: A) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<A>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("archive progress", () => {
  afterEach(() => {
    useThreadArchivePendingStore.setState({ pendingKeys: new Set() });
  });

  it("blocks a second request synchronously and stays pending until completion", async () => {
    const request = deferred<string>();
    const archive = vi.fn(() => request.promise);
    const result = runWithThreadArchivePending(thread(), archive);

    expect(isThreadArchivePending(thread())).toBe(true);
    const duplicate = runWithThreadArchivePending(thread(), archive);
    expect(duplicate).toBe(result);
    await Promise.resolve();
    expect(archive).toHaveBeenCalledOnce();
    expect(isThreadArchivePending(thread())).toBe(true);

    request.resolve("archived");
    await expect(result).resolves.toBe("archived");
    await expect(duplicate).resolves.toBe("archived");
    expect(isThreadArchivePending(thread())).toBe(false);
  });

  it("restores controls after a reported mutation failure and permits retry", async () => {
    const failure = { _tag: "Failure", reason: "server unavailable" };
    await expect(runWithThreadArchivePending(thread(), async () => failure)).resolves.toBe(failure);
    expect(isThreadArchivePending(thread())).toBe(false);
    await expect(runWithThreadArchivePending(thread(), async () => "retried")).resolves.toBe(
      "retried",
    );
  });

  it("restores controls after a rejected request", async () => {
    const request = deferred<string>();
    const result = runWithThreadArchivePending(thread(), () => request.promise);
    const duplicate = runWithThreadArchivePending(thread(), () =>
      Promise.resolve("incorrect success"),
    );
    expect(duplicate).toBe(result);
    const assertion = expect(result).rejects.toThrow("connection lost");
    request.reject(new Error("connection lost"));
    await assertion;
    expect(isThreadArchivePending(thread())).toBe(false);
  });

  it("restores controls when the request throws before returning a promise", async () => {
    await expect(
      runWithThreadArchivePending(thread(), () => {
        throw new Error("request failed");
      }),
    ).rejects.toThrow("request failed");
    expect(isThreadArchivePending(thread())).toBe(false);
  });

  it("allows independent requests in different environments and clears only the completed one", async () => {
    const firstRequest = deferred<string>();
    const secondRequest = deferred<string>();
    const first = thread("environment-a");
    const second = thread("environment-b");
    const firstResult = runWithThreadArchivePending(first, () => firstRequest.promise);
    const secondResult = runWithThreadArchivePending(second, () => secondRequest.promise);
    expect(isThreadArchivePending(first)).toBe(true);
    expect(isThreadArchivePending(second)).toBe(true);

    firstRequest.resolve("first");
    await firstResult;
    expect(isThreadArchivePending(first)).toBe(false);
    expect(isThreadArchivePending(second)).toBe(true);

    secondRequest.resolve("second");
    await secondResult;
    expect(isThreadArchivePending(second)).toBe(false);
  });

  it("does not collide when an environment or thread ID contains a colon", async () => {
    const firstRequest = deferred<string>();
    const first = thread("environment:a", "thread");
    const second = thread("environment", "a:thread");
    const result = runWithThreadArchivePending(first, () => firstRequest.promise);
    await expect(runWithThreadArchivePending(second, async () => "second")).resolves.toBe("second");
    expect(isThreadArchivePending(first)).toBe(true);
    firstRequest.resolve("first");
    await result;
  });
});
