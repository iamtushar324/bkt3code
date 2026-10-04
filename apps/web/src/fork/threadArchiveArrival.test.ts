// T3-CUSTOM(expbkt3): archive feedback follows the shell, rather than the RPC acknowledgement.
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("../rpc/atomRegistry", () => ({ appAtomRegistry: {} }));
vi.mock("../state/entities", () => ({ readThreadShell: vi.fn() }));
vi.mock("../state/threads", () => ({ environmentThreadShells: {} }));

import { waitForArchiveProjection } from "./threadArchiveArrival";
import { isThreadArchivePending, runWithThreadArchivePending } from "./threadArchivePending";

describe("archive projection arrival", () => {
  afterEach(() => vi.useRealTimers());

  it("keeps the card blocked after the RPC reply until the shell archives it", async () => {
    const ref = {
      environmentId: EnvironmentId.make("arrival-env"),
      threadId: ThreadId.make("arrival-thread"),
    };
    let archived = false;
    let changed = () => {};
    const unsubscribe = vi.fn();
    const archive = vi.fn(async () => {
      // The RPC has already succeeded. The authoritative shell has not arrived.
      await waitForArchiveProjection(
        () => archived,
        (listener) => {
          changed = listener;
          return unsubscribe;
        },
      );
      return "archived";
    });
    const result = runWithThreadArchivePending(ref, archive);
    await Promise.resolve();
    expect(isThreadArchivePending(ref)).toBe(true);
    expect(runWithThreadArchivePending(ref, archive)).toBe(result);
    expect(archive).toHaveBeenCalledOnce();
    changed();
    expect(isThreadArchivePending(ref)).toBe(true);
    archived = true;
    changed();
    await expect(result).resolves.toBe("archived");
    expect(isThreadArchivePending(ref)).toBe(false);
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("accepts a shell event that arrived before the RPC reply", async () => {
    const subscribe = vi.fn();
    await expect(waitForArchiveProjection(() => true, subscribe)).resolves.toBeUndefined();
    expect(subscribe).not.toHaveBeenCalled();
  });

  it("does not miss an archive between the first read and subscription", async () => {
    let archived = false;
    const unsubscribe = vi.fn();
    await waitForArchiveProjection(
      () => archived,
      () => {
        archived = true;
        return unsubscribe;
      },
    );
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("reports a lost shell event and removes the subscription", async () => {
    vi.useFakeTimers();
    const unsubscribe = vi.fn();
    const result = waitForArchiveProjection(
      () => false,
      () => unsubscribe,
    );
    const assertion = expect(result).rejects.toThrow("sidebar did not update");
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
