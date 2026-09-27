/**
 * T3-CUSTOM(expbkt3): Client commands for archived-session worktree reclaim.
 *
 * Three RPCs, all deliberately unscheduled and serialized by the server rather
 * than the client: a scan walks the filesystem and a reclaim deletes from it,
 * so firing several concurrently would only compete for the same disk. The
 * panel drives these one at a time from an explicit click.
 */
import { WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/unstable/reactivity";

import { createEnvironmentRpcCommand } from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";

export function createSessionArchiveEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    scan: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:session-archive:scan",
      tag: WS_METHODS.sessionArchiveScan,
    }),
    exportHistory: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:session-archive:export",
      tag: WS_METHODS.sessionArchiveExport,
    }),
    reclaim: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:session-archive:reclaim",
      tag: WS_METHODS.sessionArchiveReclaim,
    }),
    // T3-CUSTOM(expbkt3): on-demand handoff digest for a live or archived thread.
    exportContext: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:session-archive:export-context",
      tag: WS_METHODS.threadContextExport,
    }),
  };
}
