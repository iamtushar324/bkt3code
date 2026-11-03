import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as HostProcess from "@t3tools/shared/HostProcess";

import * as ProcessRunner from "../processRunner.ts";
import { TEST_HOLD_SPAWNED_ENV } from "./processHostProtocol.expbkt3.ts";
import * as ProcessHostSpawner from "./processHostSpawner.expbkt3.ts";

const hostSupported = HostProcess.Platform.defaultValue() === "linux";

const layerTest = Layer.mergeAll(
  Layer.mergeAll(ProcessHostSpawner.layerProcessRunner(), ProcessHostSpawner.layerSpawner()).pipe(
    Layer.provide(NodeServices.layer),
  ),
  NodeFileSystem.layer,
);

const run = (input: ProcessRunner.ProcessRunInput) =>
  ProcessRunner.ProcessRunner.use((runner) => runner.run(input));

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
};

// A zombie has died already; only its new parent's wait is left.
const isGone = Effect.fn("isGone")(function* (pid: number) {
  const fs = yield* FileSystem.FileSystem;
  const stat = yield* fs.readFileString(`/proc/${pid}/stat`).pipe(Effect.option);
  if (Option.isNone(stat)) return true;
  const state = stat.value.slice(stat.value.lastIndexOf(")") + 2).split(" ")[0];
  return state === "Z" || state === "X";
});

const firstLine = (handle: ChildProcessSpawner.ChildProcessHandle) =>
  handle.stdout.pipe(Stream.decodeText(), Stream.splitLines, Stream.runHead);

const killHost = () => {
  const hostPid = ProcessHostSpawner.currentProcessHostPid();
  assert.isDefined(hostPid);
  if (hostPid !== undefined) process.kill(hostPid, "SIGKILL");
};

// The leader prints the pid of a background child that keeps stdout open after the leader exits.
const leaderWithDescendant = ChildProcess.make("sh", ["-c", "sleep 30 & echo $!"]);

describe("process host spawner", () => {
  it.live("returns output and exit code", () =>
    Effect.gen(function* () {
      const result = yield* run({ command: "git", args: ["--version"] });
      assert.strictEqual(result.code, 0);
      assert.match(result.stdout, /^git version /);
      if (hostSupported) assert.isDefined(ProcessHostSpawner.currentProcessHostPid());
    }).pipe(Effect.provide(layerTest)),
  );

  it.live("reports a non-zero exit code", () =>
    Effect.gen(function* () {
      const result = yield* run({ command: "sh", args: ["-c", "echo failed >&2; exit 3"] });
      assert.strictEqual(result.code, 3);
      assert.strictEqual(result.stderr, "failed\n");
    }).pipe(Effect.provide(layerTest)),
  );

  it.live("writes stdin to the child", () =>
    Effect.gen(function* () {
      const result = yield* run({ command: "cat", args: [], stdin: "first\nsecond\n" });
      assert.strictEqual(result.code, 0);
      assert.strictEqual(result.stdout, "first\nsecond\n");
    }).pipe(Effect.provide(layerTest)),
  );

  it.live("delivers output larger than the credit window complete and in order", () =>
    Effect.gen(function* () {
      const count = 400_000;
      const expected = Array.from({ length: count }, (_, index) => `${index + 1}\n`).join("");
      const result = yield* run({
        command: "seq",
        args: ["1", String(count)],
        maxOutputBytes: 16 * 1024 * 1024,
      });
      assert.strictEqual(result.code, 0);
      assert.isAbove(result.stdout.length, 2 * 1024 * 1024);
      assert.strictEqual(result.stdout, expected);
    }).pipe(Effect.provide(layerTest)),
  );

  it.live("fails a missing command the way the Node spawner does", () =>
    Effect.gen(function* () {
      const error = yield* run({ command: "t3-process-host-missing-command", args: [] }).pipe(
        Effect.flip,
      );
      assert.strictEqual(error._tag, "ProcessSpawnError");
      const cause = error._tag === "ProcessSpawnError" ? error.cause : undefined;
      assert.isTrue(PlatformError.isPlatformError(cause));
      if (!PlatformError.isPlatformError(cause)) return;
      assert.strictEqual(cause.reason._tag, "NotFound");
      assert.strictEqual(cause.reason.module, "ChildProcess");
      assert.strictEqual(cause.reason.method, "spawn");
    }).pipe(Effect.provide(layerTest)),
  );

  it.live("passes environment overrides to the child", () =>
    Effect.gen(function* () {
      const result = yield* run({
        command: "sh",
        args: ["-c", 'printf %s "$T3_PROCESS_HOST_TEST_VALUE"'],
        env: { T3_PROCESS_HOST_TEST_VALUE: "from the test" },
      });
      assert.strictEqual(result.code, 0);
      assert.strictEqual(result.stdout, "from the test");
    }).pipe(Effect.provide(layerTest)),
  );

  it.live("kills a running child when its scope closes", () =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const pid = yield* spawner.spawn(ChildProcess.make("sleep", ["30"])).pipe(
        Effect.map((handle) => Number(handle.pid)),
        Effect.scoped,
      );
      assert.isAbove(pid, 0);
      assert.isFalse(isAlive(pid));
    }).pipe(Effect.provide(layerTest)),
  );

  it.live.skipIf(!hostSupported)(
    "ends what an exited leader left running when its scope closes",
    () =>
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const descendant = yield* Effect.gen(function* () {
          const handle = yield* spawner.spawn(leaderWithDescendant);
          const line = yield* firstLine(handle);
          assert.strictEqual(yield* handle.exitCode, 0);
          return Number(Option.getOrThrow(line));
        }).pipe(Effect.scoped);
        assert.isAbove(descendant, 0);
        assert.isTrue(yield* isGone(descendant));
      }).pipe(Effect.provide(layerTest)),
  );

  it.live.skipIf(!hostSupported)(
    "kills what an exited leader left running when its host dies",
    () =>
      Effect.gen(function* () {
        ProcessHostSpawner.resetProcessHostRestartDelay();
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const handle = yield* spawner.spawn(leaderWithDescendant);
        const descendant = Number(Option.getOrThrow(yield* firstLine(handle)));
        assert.strictEqual(yield* handle.exitCode, 0);
        killHost();

        // The descendant holds stdout open, so only the host's cleanup ends this stream.
        yield* handle.stdout.pipe(Stream.runDrain, Effect.flip);
        assert.isAbove(descendant, 0);
        assert.isTrue(yield* isGone(descendant));
      }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.live.skipIf(!hostSupported)(
    "kills the children of a host that dies before it reports their spawn",
    () =>
      Effect.gen(function* () {
        ProcessHostSpawner.resetProcessHostRestartDelay();
        const fs = yield* FileSystem.FileSystem;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-process-host-" });
        const fifo = `${directory}/pids`;
        assert.strictEqual((yield* run({ command: "mkfifo", args: [fifo] })).code, 0);
        const spawning = yield* spawner
          .spawn(
            ChildProcess.make("sh", ["-c", 'sleep 30 & echo "$$ $!" > "$1"; wait', "sh", fifo], {
              env: { [TEST_HOLD_SPAWNED_ENV]: "1" },
              extendEnv: true,
            }),
          )
          .pipe(Effect.scoped, Effect.forkChild);
        // Opening the FIFO waits for the child to write its own pid and its background child's.
        const pids = (yield* fs.readFileString(fifo)).trim().split(" ").map(Number);
        assert.strictEqual(pids.length, 2);
        killHost();

        // The spawn fails only after the host's cleanup has run.
        assert.isTrue(Exit.isFailure(yield* Fiber.await(spawning)));
        for (const pid of pids) assert.isTrue(yield* isGone(pid));
      }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.live.skipIf(!hostSupported)(
    "finishes kill and release only after a dead host's cleanup has killed the child",
    () =>
      Effect.gen(function* () {
        ProcessHostSpawner.resetProcessHostRestartDelay();
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const scope = yield* Scope.make();
        const handle = yield* spawner
          .spawn(ChildProcess.make("sleep", ["30"]))
          .pipe(Scope.provide(scope));
        const pid = Number(handle.pid);
        const hold = ProcessHostSpawner.holdNextProcessHostCleanup();
        killHost();
        yield* Effect.promise(() => hold.reached);

        // The host is gone and its cleanup is held, so the child still runs.
        assert.isTrue(isAlive(pid));
        const killing = yield* handle.kill().pipe(Effect.forkChild({ startImmediately: true }));
        const releasing = yield* Scope.close(scope, Exit.void).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        assert.isUndefined(killing.pollUnsafe());
        assert.isUndefined(releasing.pollUnsafe());

        hold.release();
        yield* Fiber.join(killing);
        yield* Fiber.join(releasing);
        assert.isTrue(yield* isGone(pid));
      }).pipe(Effect.provide(layerTest)),
  );

  it.live.skipIf(!hostSupported)(
    "fails children of a killed host and starts the next command without it",
    () =>
      Effect.gen(function* () {
        ProcessHostSpawner.resetProcessHostRestartDelay();
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const handle = yield* spawner.spawn(ChildProcess.make("sleep", ["30"]));
        const hostPid = ProcessHostSpawner.currentProcessHostPid();
        assert.isDefined(hostPid);
        if (hostPid === undefined) return;
        process.kill(hostPid, "SIGKILL");

        const exitError = yield* handle.exitCode.pipe(Effect.flip);
        assert.strictEqual(exitError.reason.module, "ChildProcess");
        assert.notStrictEqual(ProcessHostSpawner.currentProcessHostPid(), hostPid);

        const result = yield* run({ command: "sh", args: ["-c", "echo after"] });
        assert.strictEqual(result.code, 0);
        assert.strictEqual(result.stdout, "after\n");
      }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );
});
