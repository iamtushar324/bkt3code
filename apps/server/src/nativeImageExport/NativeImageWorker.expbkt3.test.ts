// @effect-diagnostics nodeBuiltinImport:off -- Synthetic fixtures exercise real private descriptors, pinned files and SDK subprocesses.
import { expect, it } from "@effect/vitest";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { NativeImageRpcClosed } from "./NativeImageRpc.ts";
import { NativeImageWorkerLauncher, productionNativeImageWorker } from "./NativeImageWorker.ts";
import { NativeImageTurnBindings } from "./TurnBinding.ts";

const thread = "6825b7cc-4b34-48c0-9713-42b95cb866c3";
const item = "turn-item:provider:codex:native-item:call_0123456789abcdef";
const job = {
  run_key: "synthetic-week",
  claim_owner: "synthetic-owner",
  claim_epoch: 1,
  step_id: "synthetic-step",
  action_id: "synthetic-action",
  item_id: item,
};

const hash = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");

async function fixture(code: string, dispatch?: () => Promise<unknown>) {
  const parent = NodePath.join(NodeOS.homedir(), ".local/state/native-image-source-tests");
  await NodeFSP.mkdir(parent, { recursive: true, mode: 0o700 });
  const root = await NodeFSP.mkdtemp(NodePath.join(parent, "worker-"));
  await NodeFSP.chmod(root, 0o700);
  const entry = "worker.py";
  await NodeFSP.writeFile(NodePath.join(root, entry), code, { mode: 0o600 });
  const pin = {
    root,
    entry,
    files: { [entry]: hash(Buffer.from(code)) },
    python: { path: "/usr/bin/python3", sha256: hash(await NodeFSP.readFile("/usr/bin/python3")) },
    application: { path: process.execPath, sha256: hash(await NodeFSP.readFile(process.execPath)) },
  };
  const bindings = new NativeImageTurnBindings();
  const lease = bindings.open({
    threadId: thread,
    runId: `run:thread:${thread}:ordinal:1`,
    providerInstanceId: "codex",
    credentialId: "credential",
    runtimeSessionId: "runtime",
    runtimeIdentity: {},
  });
  const port = bindings.bind(
    {
      principal: "provider-session",
      thread: { threadId: thread, providerInstanceId: "codex", providerSessionId: "credential" },
    },
    {
      platform: "darwin",
      user: "beknown",
      hostname: NodeOS.hostname(),
      uid: process.getuid!(),
      origin: "http://127.0.0.1:13773",
    },
    item,
    dispatch ??
      (async () => {
        throw new Error("No native tool is expected");
      }),
  );
  return {
    root,
    pin,
    port,
    lease,
    clean: () => NodeFSP.rm(root, { recursive: true, force: true }),
  };
}

const worker = `import os, socket, json
job = json.loads(os.fdopen(4).read(16385))
stream = socket.socket(fileno=3)
stream.sendall((json.dumps({"schema":"fiverr-native-rpc-ipc.v1","id":1,"method":"execution"})+"\\n").encode())
response = json.loads(stream.makefile('rb').readline(65536))
assert response['ok'] and response['result']['thread_id'] == '${thread}'
stream.close()
`;

it("keeps the production worker registration closed", () => {
  expect(() => productionNativeImageWorker()).toThrow(NativeImageRpcClosed);
});

// BKG-571: this integration exercises Darwin's actual inherited Unix socket; Linux CI cannot qualify it.
// oxlint-disable-next-line t3code/no-global-process-runtime -- Select the real host for native subprocess integration.
const mac = it.runIf(NodeOS.platform() === "darwin");

mac("runs one pinned isolated Python entry over private FD3 and FD4", async () => {
  const f = await fixture(worker);
  try {
    await new NativeImageWorkerLauncher(f.pin).run(f.port, job);
    expect(f.port.signal.aborted).toBe(false);
    expect(await NodeFSP.readFile(NodePath.join(f.root, "worker.py"), "utf8")).toBe(worker);
    await expect(new NativeImageWorkerLauncher(f.pin).run(f.port, job)).rejects.toThrow(
      NativeImageRpcClosed,
    );
  } finally {
    await f.clean();
  }
});

mac.each(["changed", "extra", "NodeFSP.symlink", "writable", "missing", "interpreter"])(
  "refuses a %s source bundle before the worker starts",
  async (change) => {
    const f = await fixture(worker);
    try {
      if (change === "changed")
        await NodeFSP.writeFile(NodePath.join(f.root, "worker.py"), worker + "# changed\n");
      if (change === "extra")
        await NodeFSP.writeFile(NodePath.join(f.root, "extra.py"), "raise Exception()\n");
      if (change === "NodeFSP.symlink")
        await NodeFSP.symlink("worker.py", NodePath.join(f.root, "alias.py"));
      if (change === "writable") await NodeFSP.chmod(NodePath.join(f.root, "worker.py"), 0o622);
      if (change === "missing") await NodeFSP.rm(NodePath.join(f.root, "worker.py"));
      const pin =
        change === "interpreter"
          ? { ...f.pin, python: { ...f.pin.python, sha256: "0".repeat(64) } }
          : f.pin;
      await expect(new NativeImageWorkerLauncher(pin).run(f.port, job)).rejects.toThrow(
        NativeImageRpcClosed,
      );
    } finally {
      await f.clean();
    }
  },
);

mac("refuses a revoked turn before launching a child", async () => {
  const f = await fixture(worker);
  try {
    f.lease.close();
    await expect(new NativeImageWorkerLauncher(f.pin).run(f.port, job)).rejects.toThrow(
      NativeImageRpcClosed,
    );
  } finally {
    await f.clean();
  }
});

mac(
  "kills its own child on revocation without waiting for an uncertain native dispatch",
  async () => {
    const called = Promise.withResolvers<void>();
    const reply = Promise.withResolvers<unknown>();
    const code = `import os,socket,json
job=json.loads(os.fdopen(4).read(16385))
s=socket.socket(fileno=3)
request={"schema":"fiverr-native-rpc-ipc.v1","id":1,"method":"call","tool":"t3_ui_orchestration_get_turn_item","input":{"threadId":"${thread}","itemId":"${item}"}}
s.sendall((json.dumps(request)+"\\n").encode())
s.recv(65536)
`;
    let calls = 0;
    const f = await fixture(code, async () => {
      calls++;
      called.resolve();
      return reply.promise;
    });
    try {
      const running = new NativeImageWorkerLauncher(f.pin).run(f.port, job);
      await called.promise;
      f.lease.close();
      await expect(running).rejects.toThrow(NativeImageRpcClosed);
      expect(calls).toBe(1);
    } finally {
      reply.resolve({ private: "must never escape" });
      await f.clean();
    }
  },
);

mac("suppresses private child diagnostics and does not restart a failed worker", async () => {
  const secret = "synthetic-private-diagnostic";
  const f = await fixture(`raise RuntimeError('${secret}')\n`);
  try {
    const error = await new NativeImageWorkerLauncher(f.pin)
      .run(f.port, job)
      .catch((value: unknown) => value);
    expect(error).toBeInstanceOf(NativeImageRpcClosed);
    expect((error as Error).stack).not.toContain(secret);
    expect((error as Error).cause).toBeUndefined();
  } finally {
    await f.clean();
  }
});
