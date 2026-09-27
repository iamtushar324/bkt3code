import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentCacheStore } from "../platform/persistence.ts";

export function createUserManagementEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | EnvironmentCacheStore | R, E>,
) {
  const scheduler = createAtomCommandScheduler();
  const serialByEnvironment = {
    mode: "serial" as const,
    key: ({ environmentId }: { readonly environmentId: string }) => environmentId,
  };
  return {
    directory: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:users:directory",
      tag: WS_METHODS.usersList,
    }),
    update: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:users:update",
      tag: WS_METHODS.usersUpdate,
      scheduler,
      concurrency: serialByEnvironment,
    }),
    revokeSessions: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:users:revoke-sessions",
      tag: WS_METHODS.usersRevokeSessions,
      scheduler,
      concurrency: serialByEnvironment,
    }),
    setSourceControlProfile: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:users:source-control-profile:set",
      tag: WS_METHODS.usersSourceControlProfileSet,
      scheduler,
      concurrency: serialByEnvironment,
    }),
  };
}
