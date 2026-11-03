import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as HostProcess from "@t3tools/shared/HostProcess";

import * as ProcessRunner from "../processRunner.ts";
import * as ProcessHostSpawner from "./processHostSpawner.expbkt3.ts";

const hostSupported = HostProcess.Platform.defaultValue() === "linux";

const layerTest = Layer.mergeAll(
  ProcessHostSpawner.layerProcessRunner(),
  ProcessHostSpawner.layerSpawner(),
).pipe(Layer.provide(NodeServices.layer));

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
    "fails children of a killed host and starts the next command without it",
    () =>
      Effect.gen(function* () {
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
