// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off - a plain Node child process that loads no Effect runtime.
// T3-CUSTOM(expbkt3): the server starts git and gh through this small process, because fork() of
// the multi-GB server blocks its event loop on Linux. Each request mirrors Effect's Node spawner:
// detached process groups, the same kill and release steps, and the same exit and stream events.
import * as NodeChildProcess from "node:child_process";
import type * as NodeStream from "node:stream";

import type {
  HostEvent,
  HostRequest,
  HostSpawnRequest,
  HostStreamId,
  SerializedError,
} from "./processHost/processHostProtocol.expbkt3.ts";

// Unacknowledged output per stream before the host pauses the child's pipe.
const CREDIT_WINDOW_BYTES = 1024 * 1024;
const PROCESS_GROUP_GRACE_MS = 1_000;
const PROCESS_GROUP_POLL_MS = 10;

interface Entry {
  readonly child: NodeChildProcess.ChildProcess;
  readonly detached: boolean;
  readonly killSignal: NodeJS.Signals;
  readonly exited: Promise<void>;
  readonly unacked: [stdout: number, stderr: number];
  readonly readables: [stdout: NodeStream.Readable | null, stderr: NodeStream.Readable | null];
}

const entries = new Map<number, Entry>();

const ignoreSendError = (_error: Error | null) => {};

const send = (event: HostEvent): void => {
  if (process.connected) process.send?.(event, undefined, undefined, ignoreSendError);
};

const serializeError = (error: unknown): SerializedError => {
  if (!(error instanceof Error)) return { name: "Error", message: String(error) };
  const errno = error as NodeJS.ErrnoException & { readonly spawnargs?: unknown };
  return {
    name: error.name,
    message: error.message,
    ...(typeof errno.code === "string" ? { code: errno.code } : {}),
    ...(typeof errno.errno === "number" ? { errno: errno.errno } : {}),
    ...(typeof errno.syscall === "string" ? { syscall: errno.syscall } : {}),
    ...(typeof errno.path === "string" ? { path: errno.path } : {}),
    ...(Array.isArray(errno.spawnargs) ? { spawnargs: errno.spawnargs.map(String) } : {}),
  };
};

const reply = (id: number, seq: number, error?: unknown) =>
  send({ t: "reply", id, seq, ...(error === undefined ? {} : { error: serializeError(error) }) });

const hasExited = (child: NodeChildProcess.ChildProcess) =>
  child.exitCode !== null || child.signalCode !== null;

const ownsProcessGroup = (entry: Entry) => entry.detached || !hasExited(entry.child);

const isProcessAlive = (entry: Entry): boolean => {
  if (!hasExited(entry.child)) return true;
  if (!ownsProcessGroup(entry)) return false;
  try {
    process.kill(-entry.child.pid!, 0);
    return true;
  } catch (error) {
    // EPERM: the group still exists but only zombies remain.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

const awaitProcessExit = (entry: Entry, timeoutMs: number) =>
  new Promise<void>((resolve) => {
    const deadline = Date.now() + timeoutMs;
    let timer: NodeJS.Timeout | undefined;
    const poll = () => {
      clearTimeout(timer);
      if (Date.now() >= deadline || !isProcessAlive(entry)) {
        entry.child.off("exit", poll);
        resolve();
        return;
      }
      timer = setTimeout(poll, PROCESS_GROUP_POLL_MS);
    };
    entry.child.on("exit", poll);
    poll();
  });

/** Signals the whole process group, then escalates to SIGKILL after `forceKillAfterMs`. */
const terminate = async (
  entry: Entry,
  signal: NodeJS.Signals,
  forceKillAfterMs: number | undefined,
): Promise<void> => {
  const signalGroup = (next: NodeJS.Signals) => {
    if (ownsProcessGroup(entry)) {
      try {
        process.kill(-entry.child.pid!, next);
        return;
      } catch (error) {
        if (hasExited(entry.child) && (error as NodeJS.ErrnoException).code === "EPERM") return;
      }
    }
    if (!entry.child.kill(next)) throw new Error("Failed to kill child process");
  };
  signalGroup(signal);
  if (forceKillAfterMs === undefined) {
    await entry.exited;
    await awaitProcessExit(entry, PROCESS_GROUP_GRACE_MS);
  } else {
    await awaitProcessExit(entry, forceKillAfterMs);
    if (isProcessAlive(entry)) {
      signalGroup("SIGKILL");
      await awaitProcessExit(entry, PROCESS_GROUP_GRACE_MS);
    }
  }
  await entry.exited;
};

const streamIndex = (stream: HostStreamId): 0 | 1 => (stream === 1 ? 0 : 1);

const forwardOutput = (
  id: number,
  entry: Entry,
  stream: HostStreamId,
  readable: NodeStream.Readable | null,
) => {
  if (readable === null) {
    send({ t: "end", id, stream });
    return;
  }
  const index = streamIndex(stream);
  readable.on("data", (chunk: Buffer) => {
    entry.unacked[index] += chunk.byteLength;
    send({ t: "out", id, stream, data: chunk });
    if (entry.unacked[index] >= CREDIT_WINDOW_BYTES) readable.pause();
  });
  readable.on("end", () => send({ t: "end", id, stream }));
  readable.on("error", (error) =>
    send({ t: "streamError", id, stream, error: serializeError(error) }),
  );
};

const spawnChild = (request: HostSpawnRequest): void => {
  if (Date.now() > request.notAfter) {
    send({ t: "declined", id: request.id });
    return;
  }
  let child: NodeChildProcess.ChildProcess;
  try {
    child = NodeChildProcess.spawn(request.command, [...request.args], {
      cwd: request.cwd,
      env: request.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: request.detached,
      shell: request.shell,
      windowsHide: !request.detached,
    });
  } catch {
    // The server's own spawner then throws the same error from the same arguments.
    send({ t: "declined", id: request.id });
    return;
  }
  const { id } = request;
  const entry: Entry = {
    child,
    detached: request.detached,
    killSignal: request.killSignal as NodeJS.Signals,
    exited: new Promise<void>((resolve) => child.once("exit", () => resolve())),
    unacked: [0, 0],
    readables: [child.stdout, child.stderr],
  };
  let spawned = false;
  child.on("error", (error) => {
    if (!spawned) send({ t: "spawnError", id, error: serializeError(error) });
  });
  // Write failures reach the server through each write's callback.
  child.stdin?.on("error", () => {});
  child.once("spawn", () => {
    spawned = true;
    entries.set(id, entry);
    send({ t: "spawned", id, pid: child.pid! });
    forwardOutput(id, entry, 1, child.stdout);
    forwardOutput(id, entry, 2, child.stderr);
    child.once("exit", (code, signal) => {
      send({ t: "exit", id, code, signal });
      if (entry.detached && code !== 0 && code !== null) {
        try {
          process.kill(-child.pid!, entry.killSignal);
        } catch {
          // The group is already gone.
        }
      }
    });
  });
};

const release = async (
  entry: Entry,
  referenced: boolean,
  signal: NodeJS.Signals,
  forceKillAfterMs: number | undefined,
) => {
  const code = entry.child.exitCode;
  const shouldTerminate = hasExited(entry.child)
    ? (code !== 0 && code !== null) || (referenced && entry.detached)
    : referenced;
  if (shouldTerminate) await terminate(entry, signal, forceKillAfterMs).catch(() => {});
};

const handleRequest = (request: HostRequest): void => {
  if (request.t === "spawn") {
    spawnChild(request);
    return;
  }
  const entry = entries.get(request.id);
  switch (request.t) {
    case "stdin": {
      const stdin = entry?.child.stdin;
      if (!stdin) {
        reply(request.id, request.seq, new Error("The process host has no stdin for this child."));
        return;
      }
      stdin.write(request.data, (error) => reply(request.id, request.seq, error ?? undefined));
      return;
    }
    case "stdinEnd": {
      if (request.destroy) entry?.child.stdin?.destroy();
      else entry?.child.stdin?.end();
      return;
    }
    case "ack": {
      if (entry === undefined) return;
      const index = streamIndex(request.stream);
      entry.unacked[index] = Math.max(0, entry.unacked[index] - request.bytes);
      const readable = entry.readables[index];
      if (readable?.isPaused() && entry.unacked[index] < CREDIT_WINDOW_BYTES) {
        readable.resume();
      }
      return;
    }
    case "kill": {
      if (entry === undefined) {
        reply(request.id, request.seq);
        return;
      }
      terminate(entry, request.signal as NodeJS.Signals, request.forceKillAfterMs).then(
        () => reply(request.id, request.seq),
        (error: unknown) => reply(request.id, request.seq, error),
      );
      return;
    }
    case "release": {
      if (entry === undefined) {
        reply(request.id, request.seq);
        return;
      }
      release(entry, request.referenced, request.signal as NodeJS.Signals, request.forceKillAfterMs)
        .catch(() => {})
        .then(() => {
          entries.delete(request.id);
          reply(request.id, request.seq);
        });
      return;
    }
  }
};

process.on("message", (message) => {
  try {
    handleRequest(message as HostRequest);
  } catch (error) {
    process.stderr.write(`[process-host] request failed: ${String(error)}\n`);
  }
});

// The server is gone: nobody can read these children any more.
process.on("disconnect", () => {
  for (const entry of entries.values()) {
    try {
      if (entry.detached) process.kill(-entry.child.pid!, "SIGKILL");
      else if (!hasExited(entry.child)) entry.child.kill("SIGKILL");
    } catch {
      // The group is already gone.
    }
  }
  process.exit(0);
});

send({ t: "ready", pid: process.pid });
