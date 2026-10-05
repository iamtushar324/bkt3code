/** T3-CUSTOM(expbkt3): Small native stdio entry; only T3 auth reaches this client process. */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as Effect from "effect/Effect";
import { runAcpMcpStdioBridge } from "../mcp/AcpMcpStdioBridge.ts";

export function nativeToolyardEndpoint(serverUrl: string) {
  const url = new URL(serverUrl);
  if (url.username || url.password || url.search || url.hash || !["", "/"].includes(url.pathname))
    throw new Error("Use the server origin without credentials, a query, or a path.");
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
    throw new Error("The server requires HTTPS, except for a loopback server.");
  return `${url.origin}/mcp/toolyard`;
}

/** Reject symlinks and other users' readable files. Never accept a token through argv. */
export async function readNativeT3Token(filename: string) {
  const file = await NodeFSP.open(
    filename,
    NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW,
  );
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.size > 8192 ||
      (stat.mode & 0o077) !== 0 ||
      (process.getuid !== undefined && stat.uid !== process.getuid())
    )
      throw new Error("Use an owner-only T3 token file (chmod 600).");
    const token = (await file.readFile("utf8")).trim();
    if (!token || token.length > 8192 || /\s/u.test(token))
      throw new Error("The T3 token file is invalid.");
    return token;
  } finally {
    await file.close();
  }
}

export async function runNativeToolyardCli(args: readonly string[]) {
  const usage = "Usage: t3 toolyard-mcp-bridge --server-url <origin> --token-file <private-file>\n";
  if (args.length === 1 && args[0] === "--help") {
    process.stdout.write(usage);
    return;
  }
  if (args.length !== 4 || args[0] !== "--server-url" || args[2] !== "--token-file") {
    process.stderr.write(usage);
    process.exitCode = 2;
    return;
  }
  try {
    const endpoint = nativeToolyardEndpoint(args[1]!);
    const token = await readNativeT3Token(args[3]!);
    const fetchImplementation = globalThis.fetch;
    await Effect.runPromise(
      runAcpMcpStdioBridge({
        endpoint,
        authorization: `Bearer ${token}`,
        input: process.stdin,
        output: process.stdout,
        fetchImplementation: (url, init) =>
          fetchImplementation(url, { ...init, redirect: "manual" }),
      }),
    );
  } catch {
    // Do not echo paths, keys, upstream errors, or parsed input into an agent transcript.
    process.stderr.write(
      "Toolyard native access failed. Check the server URL, private T3 token file, and host connection.\n",
    );
    process.exitCode = 2;
  }
}
