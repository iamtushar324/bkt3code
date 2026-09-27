// T3-CUSTOM(expbkt3): wait for a just-created thread to reach the local shell.
//
// A dispatch acknowledgement carries the projected sequence, not the projection
// itself: the shell stream event that adds the thread to this client arrives on
// its own. The chat route redirects to "/" for a thread its shell does not know
// about, so anything that creates a thread and then navigates to it has to wait
// for the row to exist first.
import type { ScopedThreadRef } from "@t3tools/contracts";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { readThreadShell } from "./entities";
import { environmentThreadShells } from "./threads";

/** Long enough to cover a slow relay, short enough to not hang a click. */
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Resolves true once the thread is in the local shell projection, false if it
 * never arrives. Event-driven — the timer only guards the case where the shell
 * event is lost, so the common path resolves on the next stream frame.
 */
export function waitForThreadShell(
  ref: ScopedThreadRef,
  options?: { readonly timeoutMs?: number },
): Promise<boolean> {
  if (readThreadShell(ref) !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    let unsubscribe: (() => void) | null = null;
    let timer: number | null = null;
    let settled = false;
    const finish = (arrived: boolean) => {
      if (settled) return;
      settled = true;
      if (timer !== null) window.clearTimeout(timer);
      unsubscribe?.();
      resolve(arrived);
    };
    unsubscribe = appAtomRegistry.subscribe(
      environmentThreadShells.threadShellAtom(ref),
      (shell) => {
        if (shell !== null) finish(true);
      },
    );
    timer = window.setTimeout(() => finish(false), options?.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    // The subscription may have missed an event that landed between the read
    // above and the subscribe call.
    if (readThreadShell(ref) !== null) finish(true);
  });
}
