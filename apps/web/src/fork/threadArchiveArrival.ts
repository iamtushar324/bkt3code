// T3-CUSTOM(expbkt3): a successful RPC does not mean the archive reached the sidebar yet.
import type { ScopedThreadRef } from "@t3tools/contracts";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { readThreadShell } from "../state/entities";
import { environmentThreadShells } from "../state/threads";

export function waitForThreadArchive(ref: ScopedThreadRef): Promise<void> {
  return waitForArchiveProjection(
    () => {
      const shell = readThreadShell(ref);
      return shell === null || shell.archivedAt !== null;
    },
    (changed) => appAtomRegistry.subscribe(environmentThreadShells.threadShellAtom(ref), changed),
  );
}

/** Subscribe to the authoritative shell, including an event that precedes the RPC reply. */
export function waitForArchiveProjection(
  isArchived: () => boolean,
  subscribe: (changed: () => void) => () => void,
): Promise<void> {
  if (isArchived()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let unsubscribe: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let finished = false;
    const check = () => {
      if (!isArchived() || finished) return;
      finished = true;
      if (timer !== undefined) clearTimeout(timer);
      unsubscribe?.();
      resolve();
    };
    unsubscribe = subscribe(check);
    if (finished) {
      unsubscribe();
      return;
    }
    // A lost stream must restore the controls with an error, rather than spin forever.
    timer = setTimeout(() => {
      finished = true;
      unsubscribe?.();
      reject(
        new Error(
          "The archive response arrived, but the sidebar did not update. Reload to check the session.",
        ),
      );
    }, 30_000);
    check();
  });
}
