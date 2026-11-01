// @effect-diagnostics nodeBuiltinImport:off -- Owns inherited descriptors, no-follow file hashes and child lifetime outside the Effect runtime.
/** T3-CUSTOM(expbkt3): Unregistered, fixed-code worker launcher for the trusted Mac account. */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";

import { serveNativeImagePipe } from "./NativeImagePipe.ts";
import { NativeImageRpc, NativeImageRpcClosed } from "./NativeImageRpc.ts";
import type { NativeImageTurnBindings } from "./TurnBinding.ts";

type Port = ReturnType<NativeImageTurnBindings["bind"]>;

export interface NativeImageWorkerPin {
  readonly root: string;
  readonly entry: string;
  readonly files: Readonly<Record<string, string>>;
  readonly python: { readonly path: string; readonly sha256: string };
  readonly application: { readonly path: string; readonly sha256: string };
}

export interface NativeImageWorkerJob {
  readonly run_key: string;
  readonly claim_owner: string;
  readonly claim_epoch: number;
  readonly step_id: string;
  readonly action_id: string;
  readonly item_id: string;
}

// Source preparation does not install a production worker or qualify an executor.
const PRODUCTION_WORKER_PIN: NativeImageWorkerPin | null = null;
const attemptedPorts = new WeakSet<Port>();
const SHA = /^[0-9a-f]{64}$/;
const RELATIVE = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*(?:\/[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)*$/;
const MAX_BUNDLE_BYTES = 100 * 1024 * 1024;
const MAX_EXECUTABLE_BYTES = 512 * 1024 * 1024;

function refused(): never {
  throw new NativeImageRpcClosed();
}

async function ownedPath(file: string, uid: number) {
  if (!NodePath.isAbsolute(file) || (await NodeFSP.realpath(file)) !== file) refused();
  for (let current = file; ; current = NodePath.dirname(current)) {
    const st = await NodeFSP.lstat(current);
    if ((st.uid !== uid && st.uid !== 0) || (st.mode & 0o022) !== 0 || st.isSymbolicLink())
      refused();
    if (current === NodePath.dirname(current)) break;
  }
}

async function checkedHash(file: string, expected: string, uid: number) {
  if (!SHA.test(expected)) refused();
  await ownedPath(file, uid);
  const handle = await NodeFSP.open(file, NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > MAX_EXECUTABLE_BYTES) refused();
    const hash = NodeCrypto.createHash("sha256");
    let bytes = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      bytes += chunk.byteLength;
      if (bytes > MAX_EXECUTABLE_BYTES) refused();
      hash.update(chunk);
    }
    const after = await handle.stat();
    const current = await NodeFSP.lstat(file);
    if (
      hash.digest("hex") !== expected ||
      bytes !== before.size ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      before.ino !== current.ino ||
      before.dev !== current.dev
    )
      refused();
    return bytes;
  } finally {
    await handle.close();
  }
}

async function verify(pin: NativeImageWorkerPin, uid: number) {
  if (
    !RELATIVE.test(pin.entry) ||
    !Object.hasOwn(pin.files, pin.entry) ||
    Object.keys(pin.files).length === 0 ||
    Object.keys(pin.files).length > 256 ||
    pin.application.path !== process.execPath
  )
    refused();
  await ownedPath(pin.root, uid);
  let total = 0;
  const discovered = new Set<string>();
  const walk = async (directory: string, relative: string) => {
    await ownedPath(directory, uid);
    for (const child of await NodeFSP.readdir(directory, { withFileTypes: true })) {
      const name = relative ? `${relative}/${child.name}` : child.name;
      if (!RELATIVE.test(name) || child.isSymbolicLink()) refused();
      const absolute = NodePath.join(directory, child.name);
      if (child.isDirectory()) {
        if (!Object.keys(pin.files).some((file) => file.startsWith(`${name}/`))) refused();
        await walk(absolute, name);
      } else if (child.isFile()) {
        if (!Object.hasOwn(pin.files, name)) refused();
        discovered.add(name);
        total += await checkedHash(absolute, pin.files[name]!, uid);
        if (total > MAX_BUNDLE_BYTES) refused();
      } else refused();
    }
  };
  await walk(pin.root, "");
  if (discovered.size !== Object.keys(pin.files).length) refused();
  await checkedHash(pin.python.path, pin.python.sha256, uid);
  await checkedHash(pin.application.path, pin.application.sha256, uid);
}

function encodeJob(job: NativeImageWorkerJob) {
  const fields = ["run_key", "claim_owner", "claim_epoch", "step_id", "action_id", "item_id"];
  if (
    Object.keys(job).length !== fields.length ||
    !fields.every((name) => Object.hasOwn(job, name)) ||
    !Number.isSafeInteger(job.claim_epoch) ||
    job.claim_epoch < 1 ||
    ![job.run_key, job.claim_owner, job.step_id, job.action_id, job.item_id].every(
      (value) => typeof value === "string",
    ) ||
    !/^fws1:[0-9a-f]{32}$/.test(job.run_key) ||
    !/^[\x21-\x7e]{1,256}$/.test(job.claim_owner) ||
    !/^[\x21-\x7e]{1,200}$/.test(job.step_id) ||
    !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(job.action_id) ||
    !/^turn-item:provider:codex:native-item:call_[0-9a-f]{16,64}$/.test(job.item_id)
  )
    refused();
  return JSON.stringify(job) + "\n";
}

/** A code-owned pin, never a tool parameter or environment setting. The default stays closed. */
export class NativeImageWorkerLauncher {
  readonly #pin: NativeImageWorkerPin;

  constructor(pin: NativeImageWorkerPin) {
    this.#pin = Object.freeze({
      ...pin,
      files: Object.freeze({ ...pin.files }),
      python: Object.freeze({ ...pin.python }),
      application: Object.freeze({ ...pin.application }),
    });
  }

  async run(port: Port, job: NativeImageWorkerJob): Promise<void> {
    try {
      // oxlint-disable-next-line t3code/no-global-process-runtime -- This FD boundary checks the actual kernel before using a Darwin ABI.
      if (NodeOS.platform() !== "darwin" || NodeOS.userInfo().username !== "beknown") refused();
      const facts = port.execution();
      if (facts.uid !== process.getuid?.() || port.signal.aborted) refused();
      const request = encodeJob(job);
      await verify(this.#pin, facts.uid);
      port.execution();
      if (port.signal.aborted || attemptedPorts.has(port)) refused();
      // Dispatch uncertainty belongs to the journal, not a replacement worker on this port.
      attemptedPorts.add(port);

      const rpc = new NativeImageRpc(port);
      const child = (() => {
        try {
          return NodeChildProcess.spawn(
            this.#pin.python.path,
            ["-I", "-S", "-B", NodePath.join(this.#pin.root, this.#pin.entry)],
            {
              cwd: this.#pin.root,
              env: { PATH: "/usr/bin:/bin", HOME: NodeOS.homedir(), LC_ALL: "C" },
              stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
              shell: false,
              detached: false,
            },
          );
        } catch {
          rpc.close();
          return refused();
        }
      })();
      let exited = false;
      let failed = false;
      const closed = new Promise<boolean>((resolve) => {
        child.once("error", () => {
          failed = true;
        });
        child.once("close", (code, signal) => {
          exited = true;
          resolve(!failed && code === 0 && signal === null);
        });
      });
      // Only this child handle is signalled. No PID search, process group, wrapper or retry.
      const stop = () => {
        rpc.close();
        child.stdio[3]?.destroy();
        child.stdio[4]?.destroy();
        if (!exited) child.kill("SIGKILL");
      };
      port.signal.addEventListener("abort", stop, { once: true });
      try {
        const pipe = child.stdio[3];
        const input = child.stdio[4];
        if (
          !(pipe instanceof NodeStream.Duplex) ||
          !(input instanceof NodeStream.Writable) ||
          port.signal.aborted
        )
          refused();
        // Observe both promises immediately: cancellation may reject either side first.
        const serving = serveNativeImagePipe(pipe, rpc).then(
          () => true,
          () => {
            stop();
            return false;
          },
        );
        input.on("error", stop);
        input.end(request);
        const success = await closed;
        // A native dispatch may outlive the killed child. Never wait for it or replay it.
        if (!success || rpc.pending || port.signal.aborted) refused();
        if (!(await serving)) refused();
        port.execution();
        // Exit success is process completion only. The existing journal supplies export proof.
      } finally {
        port.signal.removeEventListener("abort", stop);
        stop();
        await closed;
      }
    } catch {
      throw new NativeImageRpcClosed();
    }
  }
}

export function productionNativeImageWorker(): NativeImageWorkerLauncher {
  if (PRODUCTION_WORKER_PIN === null) refused();
  return new NativeImageWorkerLauncher(PRODUCTION_WORKER_PIN);
}
