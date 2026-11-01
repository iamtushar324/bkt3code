// @effect-diagnostics nodeBuiltinImport:off -- Synthetic fixtures exercise real private descriptors, pinned files and SDK subprocesses.
import { expect, it } from "@effect/vitest";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

const exec = NodeUtil.promisify(NodeChildProcess.execFile);

// BKG-571: Darwin SDK structs and audit-token APIs require a native Mac qualification run.
// oxlint-disable-next-line t3code/no-global-process-runtime -- Compile against the real build host's SDK, not an injected platform.
it.runIf(NodeOS.platform() === "darwin")(
  "binds the real parent and its accepted socket, refusing a different server and replaced FD",
  async () => {
    const state = NodePath.join(NodeOS.homedir(), ".local/state/native-image-source-tests");
    await NodeFSP.mkdir(state, { recursive: true, mode: 0o700 });
    const directory = await NodeFSP.mkdtemp(NodePath.join(state, "peer-"));
    const library = NodePath.join(directory, "peer.dylib");
    const connections = new Set<NodeNet.Socket>();
    const server = NodeNet.createServer((socket) => {
      connections.add(socket);
      socket.once("close", () => connections.delete(socket));
      socket.write("T");
    });
    const other = NodeChildProcess.spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import net from 'node:net';
      const server=net.createServer(s=>s.write('T'));
      server.listen(0,'127.0.0.1',()=>console.log(server.address().port));
    `,
      ],
      { stdio: ["ignore", "pipe", "ignore"], env: { PATH: "/usr/bin:/bin" } },
    );
    const otherClosed = new Promise<void>((resolve) => other.once("close", () => resolve()));
    const otherPort = new Promise<number>((resolve, reject) => {
      other.once("error", reject);
      other.stdout.once("data", (data: Buffer) => {
        const port = Number(data.toString().trim());
        if (Number.isSafeInteger(port) && port > 0 && port < 65536) resolve(port);
        else reject(new Error("Invalid synthetic port"));
      });
    });
    try {
      await exec("/usr/bin/clang", [
        "-dynamiclib",
        "-Wall",
        "-Wextra",
        "-Werror",
        "-O2",
        new URL("./NativeImagePeer.c", import.meta.url).pathname,
        "-lbsm",
        "-o",
        library,
      ]);
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("No synthetic listener");
      const wrongPort = await otherPort;
      const code = `import ctypes, socket, os
lib=ctypes.CDLL(${JSON.stringify(library)})
lib.ni_parent_open.argtypes=[ctypes.c_int,ctypes.c_char_p,ctypes.c_ushort]
lib.ni_parent_open.restype=ctypes.c_void_p
lib.ni_parent_check.argtypes=[ctypes.c_void_p]
lib.ni_parent_check.restype=ctypes.c_int
lib.ni_connection_check.argtypes=[ctypes.c_void_p,ctypes.c_int]
lib.ni_connection_check.restype=ctypes.c_int
lib.ni_parent_close.argtypes=[ctypes.c_void_p]
executable=${JSON.stringify(process.execPath)}.encode()
assert not lib.ni_parent_open(3,b'/incorrect-executable',${address.port})
p=lib.ni_parent_open(3,executable,${address.port})
assert p and lib.ni_parent_check(p)==1
sock=socket.create_connection(('127.0.0.1',${address.port}),timeout=5)
assert sock.recv(1)==b'T'
assert lib.ni_connection_check(p,sock.fileno())==1
wrong=socket.create_connection(('127.0.0.1',${wrongPort}),timeout=5)
assert wrong.recv(1)==b'T'
assert lib.ni_connection_check(p,wrong.fileno())==0
# The same endpoint number alone is insufficient; the server must be the retained parent.
q=lib.ni_parent_open(3,executable,${wrongPort})
assert q and lib.ni_connection_check(q,wrong.fileno())==0
lib.ni_parent_close(q)
sock.close()
assert lib.ni_connection_check(p,sock.fileno())==0
wrong.close()
a,b=socket.socketpair()
os.dup2(a.fileno(),3)
assert lib.ni_parent_check(p)==0
lib.ni_parent_close(p)
a.close();b.close()
print('synthetic-peer-checks-passed')
`;
      const child = NodeChildProcess.spawn("/usr/bin/python3", ["-I", "-S", "-B", "-c", code], {
        stdio: ["ignore", "pipe", "pipe", "pipe"],
        env: { PATH: "/usr/bin:/bin" },
      });
      let output = "";
      let error = "";
      if (child.stdout === null || child.stderr === null)
        throw new Error("Missing synthetic pipes");
      child.stdout.on("data", (data: Buffer) => {
        output += data.toString();
      });
      child.stderr.on("data", (data: Buffer) => {
        error += data.toString();
      });
      const exit = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
      expect(error).toBe("");
      expect(exit).toBe(0);
      expect(output).toBe("synthetic-peer-checks-passed\n");
    } finally {
      other.kill("SIGKILL");
      await otherClosed;
      for (const socket of connections) socket.destroy();
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  },
);
