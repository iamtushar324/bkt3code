// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off - reads /proc from Node callbacks after a host exits, outside any fiber.
// T3-CUSTOM(expbkt3): every child of a process host carries that host's instance marker in its
// environment, and its descendants inherit it. When the host exits, its leftovers are found by
// the marker, so cleanup does not depend on pids the server may never have received.
import * as NodeFSP from "node:fs/promises";

import { HOST_INSTANCE_ENV } from "./processHostProtocol.expbkt3.ts";

const SCAN_BATCH = 64;
// A process can fork between the scan and the kill; later passes catch those children.
const SCAN_PASSES = 3;
const GONE_LIMIT_MS = 1_000;
const GONE_POLL_MS = 10;

interface ProcStat {
  readonly state: string;
  readonly processGroup: number;
}

// The command name in /proc/<pid>/stat can hold spaces and parentheses, so read after the last ")".
const readStat = async (pid: number): Promise<ProcStat | undefined> => {
  try {
    const text = await NodeFSP.readFile(`/proc/${pid}/stat`, "utf8");
    const fields = text.slice(text.lastIndexOf(")") + 2).split(" ");
    return { state: fields[0] ?? "", processGroup: Number(fields[2]) };
  } catch {
    return undefined;
  }
};

// A zombie has already died; only its parent's wait is left.
const isGone = async (pid: number) => {
  const stat = await readStat(pid);
  return stat === undefined || stat.state === "Z" || stat.state === "X";
};

const carriesMarker = async (pid: number, uid: number, entry: string) => {
  try {
    if ((await NodeFSP.stat(`/proc/${pid}`)).uid !== uid) return false;
    const environ = await NodeFSP.readFile(`/proc/${pid}/environ`, "utf8");
    return environ.split("\0").includes(entry);
  } catch {
    // Exited during the scan, or not readable.
    return false;
  }
};

const findMarked = async (entry: string, exclude: ReadonlySet<number>) => {
  const uid = process.getuid?.() ?? -1;
  const names = await NodeFSP.readdir("/proc").catch(() => [] as string[]);
  const pids = names
    .filter((name) => /^\d+$/u.test(name))
    .map(Number)
    .filter((pid) => !exclude.has(pid));
  const found: number[] = [];
  for (let start = 0; start < pids.length; start += SCAN_BATCH) {
    const batch = pids.slice(start, start + SCAN_BATCH);
    const marked = await Promise.all(batch.map((pid) => carriesMarker(pid, uid, entry)));
    batch.forEach((pid, index) => {
      if (marked[index]) found.push(pid);
    });
  }
  return found;
};

const waitUntilGone = async (pids: ReadonlyArray<number>) => {
  const deadline = Date.now() + GONE_LIMIT_MS;
  let pending = pids;
  while (pending.length > 0 && Date.now() < deadline) {
    const gone = await Promise.all(pending.map(isGone));
    pending = pending.filter((_, index) => !gone[index]);
    if (pending.length > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, GONE_POLL_MS));
    }
  }
};

/**
 * SIGKILLs every process of this user whose environment carries the host instance `marker`, and
 * waits up to a second for them to die. Returns how many it signalled.
 */
export const killMarkedProcesses = async (
  marker: string,
  exclude: ReadonlySet<number>,
): Promise<number> => {
  const entry = `${HOST_INSTANCE_ENV}=${marker}`;
  const killed = new Set<number>();
  for (let pass = 0; pass < SCAN_PASSES; pass += 1) {
    const found = (await findMarked(entry, exclude)).filter((pid) => !killed.has(pid));
    if (found.length === 0) break;
    for (const pid of found) {
      const stat = await readStat(pid);
      if (stat === undefined) continue;
      try {
        // A marked group leader was started by the host; its group can hold unmarked members too.
        process.kill(stat.processGroup === pid ? -pid : pid, "SIGKILL");
        killed.add(pid);
      } catch {
        // Already exited.
      }
    }
    await waitUntilGone(found);
  }
  return killed.size;
};
