// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalTimersInEffect:off globalDate:off globalDateInEffect:off - the host needs a raw Node IPC channel, and its deadlines run in Node callbacks.
// T3-CUSTOM(expbkt3): on Linux libuv starts every child with fork(), which copies the page tables
// of the multi-GB server and then takes copy-on-write faults, blocking the event loop each time.
// git and gh therefore start from one small long-lived host process (process-host.expbkt3.ts).
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as Redacted from "effect/Redacted";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner, CommandLine } from "effect/process";

import * as ProcessRunner from "../processRunner.ts";
import type {
  HostEvent,
  HostRequest,
  HostStreamId,
  SerializedError,
} from "./processHostProtocol.expbkt3.ts";

// A host that reads a spawn request later than this declines it, and the server spawns directly.
const SPAWN_DEADLINE_MS = 2_000;
// Past this the host counts as hung: it is killed and the request fails, since it may have spawned.
const HOST_REPLY_LIMIT_MS = 30_000;
const STARTUP_LIMIT_MS = 10_000;
const RESTART_BACKOFF_MIN_MS = 1_000;
const RESTART_BACKOFF_MAX_MS = 60_000;
const HEALTHY_UPTIME_MS = 60_000;
const STOP_GRACE_MS = 5_000;
// Layers built per connection or per test come and go; an idle host costs nothing to keep.
const IDLE_STOP_MS = 30_000;

/** Off keeps the spawner below this layer, for a test that watches its own spawns. */
export const ProcessHostEnabled = Context.Reference<boolean>("t3/processHost/ProcessHostEnabled", {
  defaultValue: () => true,
});

type ExitSignal = readonly [code: number | null, signal: string | null];
type OutputQueue = Queue.Queue<Uint8Array, PlatformError.PlatformError | Cause.Done>;

type Reply =
  | { readonly _tag: "Ok" }
  | { readonly _tag: "Failed"; readonly error: SerializedError }
  | { readonly _tag: "HostGone"; readonly reason: string };

type SpawnReply =
  | { readonly _tag: "Spawned" }
  | { readonly _tag: "Failed"; readonly error: SerializedError }
  | { readonly _tag: "Declined" }
  | { readonly _tag: "HostGone"; readonly reason: string };

interface HandleState {
  readonly id: number;
  readonly host: HostConnection;
  readonly display: string;
  readonly detached: boolean;
  pid: number;
  referenced: boolean;
  exitObserved: boolean;
  readonly exit: Deferred.Deferred<ExitSignal, PlatformError.PlatformError>;
  readonly stdout: OutputQueue;
  readonly stderr: OutputQueue;
  readonly replies: Map<number, (reply: Reply) => void>;
  nextSeq: number;
  onSpawnReply: ((reply: SpawnReply) => void) | undefined;
}

interface HostConnection {
  readonly child: NodeChildProcess.ChildProcess;
  readonly startedAt: number;
  readonly ready: Deferred.Deferred<boolean>;
  readonly handles: Map<number, HandleState>;
  startupTimer: NodeJS.Timeout | undefined;
  gone: boolean;
}

interface HostLaunch {
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
}

interface HostStatus {
  readonly key: string;
  readonly level: "info" | "warn";
  readonly message: string;
  readonly annotations: Readonly<Record<string, unknown>>;
}

// One host per server process: per-connection layer builds must not each start their own.
const manager = {
  refs: 0,
  launch: undefined as HostLaunch | undefined,
  current: undefined as HostConnection | undefined,
  retryAt: 0,
  backoffMs: RESTART_BACKOFF_MIN_MS,
  nextId: 1,
  idleStopTimer: undefined as NodeJS.Timeout | undefined,
  status: undefined as HostStatus | undefined,
  loggedStatusKey: undefined as string | undefined,
};

const setStatus = (status: HostStatus) => {
  manager.status = status;
};

const reportStatus = Effect.suspend(() => {
  const status = manager.status;
  if (status === undefined || status.key === manager.loggedStatusKey) return Effect.void;
  manager.loggedStatusKey = status.key;
  const log =
    status.level === "warn" ? Effect.logWarning(status.message) : Effect.logInfo(status.message);
  return log.pipe(Effect.annotateLogs(status.annotations));
});

const ignoreSendError = (_error: Error | null) => {};

const sendToHost = (host: HostConnection, request: HostRequest) => {
  if (host.gone || !host.child.connected) return;
  host.child.send(request, undefined, undefined, ignoreSendError);
};

// Hold the server's event loop open only while a request or child is outstanding.
const updateRef = (host: HostConnection) => {
  if (host.gone) return;
  if (host.handles.size > 0 || !Deferred.isDoneUnsafe(host.ready)) host.child.channel?.ref();
  else host.child.channel?.unref();
};

const reasonTag = (code: string | undefined): PlatformError.SystemErrorTag => {
  switch (code) {
    case "ENOENT":
      return "NotFound";
    case "EACCES":
    case "EPERM":
      return "PermissionDenied";
    case "EEXIST":
      return "AlreadyExists";
    case "EISDIR":
    case "ENOTDIR":
    case "ELOOP":
      return "BadResource";
    case "EBUSY":
      return "Busy";
    default:
      return "Unknown";
  }
};

const toError = (serialized: SerializedError): Error =>
  Object.assign(new Error(serialized.message), {
    name: serialized.name,
    ...(serialized.code === undefined ? {} : { code: serialized.code }),
    ...(serialized.errno === undefined ? {} : { errno: serialized.errno }),
    ...(serialized.syscall === undefined ? {} : { syscall: serialized.syscall }),
    ...(serialized.path === undefined ? {} : { path: serialized.path }),
    ...(serialized.spawnargs === undefined ? {} : { spawnargs: [...serialized.spawnargs] }),
  });

// Same shape as Effect's Node spawner, so callers that inspect spawn failures see no difference.
const toPlatformError = (method: string, error: SerializedError, display: string) =>
  PlatformError.systemError({
    _tag: reasonTag(error.code),
    module: "ChildProcess",
    method,
    pathOrDescriptor: display,
    syscall: error.syscall,
    cause: toError(error),
  });

const hostGoneError = (method: string, display: string, reason: string) =>
  PlatformError.systemError({
    _tag: "Unknown",
    module: "ChildProcess",
    method,
    pathOrDescriptor: display,
    description: `The process host ${reason}.`,
  });

const unwrap = (value: string | Redacted.Redacted<string>): string =>
  Redacted.isRedacted(value) ? Redacted.value(value) : value;

const forceKillAfterMs = (input: Duration.Input | undefined) =>
  input === undefined ? undefined : Duration.toMillis(input);

const outputQueue = (state: HandleState, stream: HostStreamId) =>
  stream === 1 ? state.stdout : state.stderr;

const failHandle = (state: HandleState, reason: string) => {
  state.onSpawnReply?.({ _tag: "HostGone", reason });
  if (state.pid > 0 && !state.exitObserved) {
    // Nobody can read or reap these children any more.
    try {
      process.kill(state.detached ? -state.pid : state.pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  Queue.failCauseUnsafe(
    state.stdout,
    Cause.fail(hostGoneError("fromReadable(stdout)", state.display, reason)),
  );
  Queue.failCauseUnsafe(
    state.stderr,
    Cause.fail(hostGoneError("fromReadable(stderr)", state.display, reason)),
  );
  Deferred.doneUnsafe(state.exit, Exit.fail(hostGoneError("exitCode", state.display, reason)));
  for (const waiter of state.replies.values()) waiter({ _tag: "HostGone", reason });
  state.replies.clear();
};

const detachHost = (host: HostConnection, reason: string) => {
  host.gone = true;
  clearTimeout(host.startupTimer);
  Deferred.doneUnsafe(host.ready, Exit.succeed(false));
  for (const state of host.handles.values()) failHandle(state, reason);
  host.handles.clear();
  host.child.channel?.unref();
  if (manager.current === host) manager.current = undefined;
};

const hostGone = (host: HostConnection, reason: string) => {
  if (host.gone) return;
  const wasCurrent = manager.current === host;
  detachHost(host, reason);
  try {
    host.child.kill("SIGKILL");
  } catch {
    // Already exited.
  }
  if (!wasCurrent) return;
  const now = Date.now();
  if (now - host.startedAt >= HEALTHY_UPTIME_MS) manager.backoffMs = RESTART_BACKOFF_MIN_MS;
  manager.retryAt = now + manager.backoffMs;
  setStatus({
    key: `down:${host.startedAt}`,
    level: "warn",
    message: "Process host is unavailable; git and gh start directly until it restarts.",
    annotations: { reason, restartInMs: manager.backoffMs },
  });
  manager.backoffMs = Math.min(manager.backoffMs * 2, RESTART_BACKOFF_MAX_MS);
};

const stopHost = (host: HostConnection) => {
  detachHost(host, "stopped");
  // The host kills its children and exits once its IPC channel closes.
  if (host.child.connected) host.child.disconnect();
  setTimeout(() => host.child.kill("SIGKILL"), STOP_GRACE_MS).unref();
};

const onHostEvent = (host: HostConnection, event: HostEvent) => {
  if (host.gone) return;
  if (event.t === "ready") {
    clearTimeout(host.startupTimer);
    Deferred.doneUnsafe(host.ready, Exit.succeed(true));
    updateRef(host);
    setStatus({
      key: `ready:${event.pid}`,
      level: "info",
      message: "Process host is ready; git and gh start from it.",
      annotations: { pid: event.pid },
    });
    return;
  }
  const state = host.handles.get(event.id);
  if (state === undefined) return;
  switch (event.t) {
    case "spawned":
      state.pid = event.pid;
      state.onSpawnReply?.({ _tag: "Spawned" });
      return;
    case "spawnError":
    case "declined":
      host.handles.delete(event.id);
      updateRef(host);
      state.onSpawnReply?.(
        event.t === "declined" ? { _tag: "Declined" } : { _tag: "Failed", error: event.error },
      );
      return;
    case "out":
      Queue.offerUnsafe(
        outputQueue(state, event.stream),
        Buffer.isBuffer(event.data)
          ? event.data
          : Buffer.from(event.data.buffer, event.data.byteOffset, event.data.byteLength),
      );
      return;
    case "end":
      Queue.endUnsafe(outputQueue(state, event.stream));
      return;
    case "streamError":
      Queue.failCauseUnsafe(
        outputQueue(state, event.stream),
        Cause.fail(
          toPlatformError(
            `fromReadable(${event.stream === 1 ? "stdout" : "stderr"})`,
            event.error,
            state.display,
          ),
        ),
      );
      return;
    case "exit":
      state.exitObserved = true;
      Deferred.doneUnsafe(state.exit, Exit.succeed([event.code, event.signal] as const));
      return;
    case "reply": {
      const waiter = state.replies.get(event.seq);
      state.replies.delete(event.seq);
      waiter?.(event.error === undefined ? { _tag: "Ok" } : { _tag: "Failed", error: event.error });
      return;
    }
  }
};

const startHost = (launch: HostLaunch): HostConnection | undefined => {
  let child: NodeChildProcess.ChildProcess;
  try {
    child = NodeChildProcess.spawn(launch.executable, [...launch.args], {
      stdio: ["ignore", "ignore", "inherit", "ipc"],
      serialization: "advanced",
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    });
  } catch (error) {
    manager.retryAt = Date.now() + manager.backoffMs;
    setStatus({
      key: `start-failed:${manager.retryAt}`,
      level: "warn",
      message: "Process host could not start; git and gh start directly.",
      annotations: { reason: String(error) },
    });
    return undefined;
  }
  child.unref();
  const host: HostConnection = {
    child,
    startedAt: Date.now(),
    ready: Deferred.makeUnsafe<boolean>(),
    handles: new Map(),
    startupTimer: undefined,
    gone: false,
  };
  manager.current = host;
  host.startupTimer = setTimeout(
    () => hostGone(host, `did not start within ${STARTUP_LIMIT_MS} ms`),
    STARTUP_LIMIT_MS,
  );
  host.startupTimer.unref();
  child.on("message", (message) => onHostEvent(host, message as HostEvent));
  child.on("error", (error) => hostGone(host, `failed: ${error.message}`));
  child.on("exit", (code, signal) => hostGone(host, `exited with ${signal ?? code}`));
  child.on("disconnect", () => hostGone(host, "closed its IPC channel"));
  updateRef(host);
  return host;
};

const connect: Effect.Effect<Option.Option<HostConnection>> = Effect.suspend(() => {
  let host = manager.current;
  if (host === undefined) {
    if (manager.launch === undefined || Date.now() < manager.retryAt) return Effect.succeedNone;
    host = startHost(manager.launch);
    if (host === undefined) return Effect.succeedNone;
  }
  const connection = host;
  return Deferred.await(connection.ready).pipe(
    Effect.map((ready) =>
      ready && !connection.gone ? Option.some(connection) : Option.none<HostConnection>(),
    ),
  );
});

const hostRequest = (
  state: HandleState,
  build: (seq: number) => HostRequest,
  watchdogMs?: number,
) =>
  Effect.callback<Reply>((resume) => {
    if (state.host.gone) {
      resume(Effect.succeed({ _tag: "HostGone", reason: "exited" }));
      return;
    }
    const seq = state.nextSeq++;
    const timer =
      watchdogMs === undefined
        ? undefined
        : setTimeout(
            () => hostGone(state.host, `did not answer within ${watchdogMs} ms`),
            watchdogMs,
          );
    state.replies.set(seq, (reply) => {
      clearTimeout(timer);
      resume(Effect.succeed(reply));
    });
    sendToHost(state.host, build(seq));
    return Effect.sync(() => {
      clearTimeout(timer);
      state.replies.delete(seq);
    });
  });

const killWatchdogMs = (forceKillAfter: number | undefined) =>
  forceKillAfter === undefined ? undefined : forceKillAfter + HOST_REPLY_LIMIT_MS;

const hasNulCharacter = (command: ChildProcess.StandardCommand) =>
  command.command.includes("\0") ||
  (command.options.cwd?.includes("\0") ?? false) ||
  command.args.some((arg) => unwrap(arg).includes("\0")) ||
  Object.values(command.options.env ?? {}).some(
    (value) => value !== undefined && unwrap(value).includes("\0"),
  );

const isPipe = (value: unknown) => value === undefined || value === "pipe";

/** The host covers what git and gh need; anything else keeps Effect's own error or behaviour. */
const isHostable = (command: ChildProcess.Command): command is ChildProcess.StandardCommand =>
  command._tag === "StandardCommand" &&
  isPipe(command.options.stdin) &&
  isPipe(command.options.stdout) &&
  isPipe(command.options.stderr) &&
  Object.keys(command.options.additionalFds ?? {}).length === 0 &&
  !(
    command.options.shell !== undefined &&
    command.options.shell !== false &&
    command.args.length > 0
  ) &&
  !hasNulCharacter(command);

// Mirrors the Node spawner: an inherited environment is the server's environment at spawn time.
const resolveEnvironment = (options: ChildProcess.CommandOptions): Record<string, string> => {
  const env: Record<string, string> = {};
  if (options.env === undefined || options.extendEnv === true) {
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) env[key] = value;
    }
  }
  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (value === undefined) delete env[key];
    else env[key] = unwrap(value);
  }
  return env;
};

// The Node spawner checks cwd first, so a missing cwd fails as FileSystem.access, not as spawn.
const resolveWorkingDirectory = (cwd: string) =>
  Effect.callback<string, PlatformError.PlatformError>((resume) => {
    NodeFS.access(cwd, NodeFS.constants.F_OK, (error) => {
      resume(
        error === null
          ? Effect.succeed(NodePath.resolve(cwd))
          : Effect.fail(
              PlatformError.systemError({
                _tag: reasonTag(error.code),
                module: "FileSystem",
                method: "access",
                pathOrDescriptor: cwd,
                syscall: error.syscall,
                cause: error,
              }),
            ),
      );
    });
  });

const withRedactedSpawnArgs = (
  error: SerializedError,
  command: ChildProcess.StandardCommand,
): SerializedError =>
  command.args.some(Redacted.isRedacted)
    ? {
        ...error,
        spawnargs: [
          command.command,
          ...command.args.map((arg) => (Redacted.isRedacted(arg) ? "<redacted>" : arg)),
        ],
      }
    : error;

const requestSpawn = Effect.fnUntraced(function* (
  host: HostConnection,
  command: ChildProcess.StandardCommand,
  cwd: string | undefined,
  display: string,
) {
  const state: HandleState = {
    id: manager.nextId++,
    host,
    display,
    detached: command.options.detached ?? true,
    pid: 0,
    referenced: true,
    exitObserved: false,
    exit: Deferred.makeUnsafe<ExitSignal, PlatformError.PlatformError>(),
    stdout: yield* Queue.unbounded<Uint8Array, PlatformError.PlatformError | Cause.Done>(),
    stderr: yield* Queue.unbounded<Uint8Array, PlatformError.PlatformError | Cause.Done>(),
    replies: new Map(),
    nextSeq: 1,
    onSpawnReply: undefined,
  };
  const reply = yield* Effect.callback<SpawnReply>((resume) => {
    if (host.gone) {
      resume(Effect.succeed({ _tag: "Declined" }));
      return;
    }
    const timer = setTimeout(
      () => hostGone(host, `did not answer a spawn request within ${HOST_REPLY_LIMIT_MS} ms`),
      HOST_REPLY_LIMIT_MS,
    );
    state.onSpawnReply = (spawnReply) => {
      clearTimeout(timer);
      state.onSpawnReply = undefined;
      resume(Effect.succeed(spawnReply));
    };
    host.handles.set(state.id, state);
    updateRef(host);
    sendToHost(host, {
      t: "spawn",
      id: state.id,
      notAfter: Date.now() + SPAWN_DEADLINE_MS,
      command: command.command,
      args: command.args.map(unwrap),
      cwd,
      env: resolveEnvironment(command.options),
      shell: command.options.shell,
      detached: state.detached,
      killSignal: command.options.killSignal ?? "SIGTERM",
    });
  });
  return { state, reply };
});

// Mirrors the Node spawner's scope release: it waits for the host to finish the same kill steps.
const releaseHandle = (state: HandleState, command: ChildProcess.StandardCommand) =>
  Effect.suspend(() => {
    const forceKillAfter = forceKillAfterMs(command.options.forceKillAfter);
    return hostRequest(
      state,
      (seq) => ({
        t: "release",
        id: state.id,
        seq,
        referenced: state.referenced,
        signal: command.options.killSignal ?? "SIGTERM",
        forceKillAfterMs: forceKillAfter,
      }),
      killWatchdogMs(forceKillAfter),
    );
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        state.host.handles.delete(state.id);
        updateRef(state.host);
      }),
    ),
    Effect.asVoid,
  );

const makeHostHandle = (state: HandleState): ChildProcessSpawner.ChildProcessHandle => {
  const output = (queue: OutputQueue, stream: HostStreamId) =>
    Stream.fromQueue(queue).pipe(
      Stream.tap((chunk) =>
        Effect.sync(() =>
          sendToHost(state.host, { t: "ack", id: state.id, stream, bytes: chunk.byteLength }),
        ),
      ),
    );
  const stdout = output(state.stdout, 1);
  const stderr = output(state.stderr, 2);
  const stdin: Sink.Sink<void, Uint8Array, never, PlatformError.PlatformError> = Sink.forEach(
    (chunk: Uint8Array) =>
      hostRequest(state, (seq) => ({ t: "stdin", id: state.id, seq, data: chunk })).pipe(
        Effect.flatMap((reply) =>
          reply._tag === "Ok"
            ? Effect.void
            : Effect.fail(
                reply._tag === "Failed"
                  ? toPlatformError("fromWritable(stdin)", reply.error, state.display)
                  : hostGoneError("fromWritable(stdin)", state.display, reply.reason),
              ),
        ),
      ),
  ).pipe(
    Sink.onExit((exit) =>
      Effect.sync(() =>
        sendToHost(state.host, { t: "stdinEnd", id: state.id, destroy: Exit.isFailure(exit) }),
      ),
    ),
  );
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(state.pid),
    exitCode: Effect.flatMap(Deferred.await(state.exit), ([code, signal]) =>
      code !== null
        ? Effect.succeed(ChildProcessSpawner.ExitCode(code))
        : Effect.fail(
            toPlatformError(
              "exitCode",
              {
                name: "Error",
                message: `Process interrupted due to receipt of signal: '${signal}'`,
              },
              state.display,
            ),
          ),
    ),
    isRunning: Effect.map(Deferred.isDone(state.exit), (done) => !done),
    kill: (options) => {
      const forceKillAfter = forceKillAfterMs(options?.forceKillAfter);
      return hostRequest(
        state,
        (seq) => ({
          t: "kill",
          id: state.id,
          seq,
          signal: options?.killSignal ?? "SIGTERM",
          forceKillAfterMs: forceKillAfter,
        }),
        killWatchdogMs(forceKillAfter),
      ).pipe(
        Effect.flatMap((reply) =>
          reply._tag === "Failed"
            ? Effect.fail(toPlatformError("kill", reply.error, state.display))
            : Effect.void,
        ),
      );
    },
    stdin,
    stdout,
    stderr,
    all: Stream.merge(stdout, stderr),
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    // Only release reads this; the host itself never holds the server open.
    unref: Effect.sync(() => {
      state.referenced = false;
      return Effect.sync(() => {
        state.referenced = true;
      });
    }),
  });
};

const spawnThroughHost = Effect.fnUntraced(function* (
  base: ChildProcessSpawner.ChildProcessSpawner["Service"],
  command: ChildProcess.StandardCommand,
) {
  const cwd =
    command.options.cwd === undefined
      ? undefined
      : yield* resolveWorkingDirectory(command.options.cwd);
  const connection = yield* connect;
  yield* reportStatus;
  if (Option.isNone(connection)) return yield* base.spawn(command);
  const host = connection.value;
  const display = CommandLine.display([command.command, ...command.args], { format: "posix" });
  const { state, reply } = yield* Effect.acquireRelease(
    requestSpawn(host, command, cwd, display),
    (spawned) =>
      spawned.reply._tag === "Spawned" ? releaseHandle(spawned.state, command) : Effect.void,
  );
  switch (reply._tag) {
    case "Spawned":
      return makeHostHandle(state);
    case "Declined":
      return yield* base.spawn(command);
    case "Failed":
      return yield* toPlatformError("spawn", withRedactedSpawnArgs(reply.error, command), display);
    case "HostGone":
      return yield* hostGoneError("spawn", display, reply.reason);
  }
});

const resolveLaunch = Effect.gen(function* () {
  if (!(yield* ProcessHostEnabled)) return undefined;
  if ((yield* HostProcess.Platform) !== "linux" || (yield* HostProcess.IsExecutable)) {
    return undefined;
  }
  if ((yield* HostProcess.Environment).T3_PROCESS_HOST === "0") {
    setStatus({
      key: "off",
      level: "info",
      message: "Process host is off (T3_PROCESS_HOST=0); git and gh start directly.",
      annotations: {},
    });
    yield* reportStatus;
    return undefined;
  }
  const fromSource = import.meta.url.endsWith(".ts");
  const entry = NodeURL.fileURLToPath(
    new URL(
      fromSource ? "../process-host.expbkt3.ts" : "./process-host.expbkt3.mjs",
      import.meta.url,
    ),
  );
  if (!NodeFS.existsSync(entry)) {
    setStatus({
      key: "missing",
      level: "warn",
      message: "Process host entry is missing; git and gh start directly.",
      annotations: { entry },
    });
    yield* reportStatus;
    return undefined;
  }
  return {
    executable: yield* HostProcess.ExecutablePath,
    args: [
      ...(fromSource
        ? ["--experimental-strip-types", "--disable-warning=ExperimentalWarning"]
        : []),
      entry,
    ],
  } satisfies HostLaunch;
});

const makeSpawner = Effect.gen(function* () {
  const base = yield* ChildProcessSpawner.ChildProcessSpawner;
  const launch = yield* resolveLaunch;
  if (launch === undefined) return base;
  yield* Effect.acquireRelease(
    Effect.sync(() => {
      manager.refs += 1;
      manager.launch ??= launch;
      clearTimeout(manager.idleStopTimer);
      manager.idleStopTimer = undefined;
    }),
    () =>
      Effect.sync(() => {
        manager.refs -= 1;
        if (manager.refs > 0) return;
        clearTimeout(manager.idleStopTimer);
        manager.idleStopTimer = setTimeout(() => {
          manager.idleStopTimer = undefined;
          if (manager.refs === 0 && manager.current !== undefined) stopHost(manager.current);
        }, IDLE_STOP_MS);
        manager.idleStopTimer.unref();
      }),
  );
  return ChildProcessSpawner.make((command) =>
    isHostable(command) ? spawnThroughHost(base, command) : base.spawn(command),
  );
});

/** The running host's pid, for tests and diagnostics. */
export const currentProcessHostPid = (): number | undefined =>
  manager.current?.gone === false ? manager.current.child.pid : undefined;

/**
 * A spawner that starts commands from the process host and falls back to the spawner below it.
 * Each call builds a separate layer, so every user keeps its own spawner below; the host is shared.
 */
export const layerSpawner = () =>
  Layer.effect(ChildProcessSpawner.ChildProcessSpawner, makeSpawner);

/** A private ProcessRunner on the host: the shared ProcessRunner.layer is memoized with Node's. */
export const layerProcessRunner = () =>
  Layer.effect(ProcessRunner.ProcessRunner, ProcessRunner.make()).pipe(
    Layer.provide(layerSpawner()),
  );
