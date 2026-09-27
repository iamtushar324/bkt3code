// T3-CUSTOM(expbkt3): fork-owned. `ForgejoCli.layer` declares its dependencies
// (FileSystem, HttpClient, VcsProcess) rather than providing them, because every
// upstream consumer composes it inside a graph that already has them.
//
// The fork's CLI does not. `bin.ts` imports `server.ts` for the `serve` command,
// which pulls in SourceControlRepositoryService -> SourceControlProviderRegistry
// -> ForgejoSourceControlProvider, so the whole CLI's effect requires ForgejoCli.
// Upstream's CLI never reaches that service, so its CliRuntimeLayer carries none
// of this.
//
// Keeping the wiring here means the upstream-owned entrypoints need exactly one
// import and one layer entry, instead of growing three dependency imports each.
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/unstable/http";

import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as ForgejoCli from "./ForgejoCli.ts";

/** `ForgejoCli` with its own dependencies satisfied, for graphs that lack them. */
// `NodeServices` sits in its own `provide` step rather than inside the `mergeAll`:
// merged layers are built in parallel, so `VcsProcess` would not see the
// `ChildProcessSpawner` that `NodeServices` supplies.
export const ForgejoCliSelfContainedLive = ForgejoCli.layer.pipe(
  Layer.provide(Layer.mergeAll(FetchHttpClient.layer, VcsProcess.layer)),
  Layer.provide(NodeServices.layer),
);
