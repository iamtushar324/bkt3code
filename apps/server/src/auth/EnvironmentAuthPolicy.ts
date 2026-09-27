import type { ServerAuthDescriptor } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { isRemoteReachableHost, resolveSessionCookieName } from "./utils.ts";

export class EnvironmentAuthPolicy extends Context.Service<
  EnvironmentAuthPolicy,
  {
    readonly getDescriptor: () => Effect.Effect<ServerAuthDescriptor>;
  }
>()("t3/auth/EnvironmentAuthPolicy") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const serverEnvironment = yield* ServerEnvironment.ServerEnvironmentIdentity;
  const isRemoteReachable = isRemoteReachableHost(config.host);

  const policy =
    config.mode === "desktop"
      ? isRemoteReachable
        ? "remote-reachable"
        : "desktop-managed-local"
      : isRemoteReachable
        ? "remote-reachable"
        : "loopback-browser";

  const bootstrapMethods: ServerAuthDescriptor["bootstrapMethods"] =
    policy === "desktop-managed-local"
      ? ["desktop-bootstrap"]
      : config.mode === "desktop" && policy === "remote-reachable"
        ? ["desktop-bootstrap", "one-time-token"]
        : ["one-time-token"];

  // T3-CUSTOM(expbkt3): BEGIN — team mode advertises itself with the `clerk`
  // descriptor alone, so the SPA can detect it and render Clerk sign-in without
  // build-time coupling.
  //
  // Deliberately NOT a new `bootstrapMethods` entry. That field is a closed
  // literal union in stock T3 Code, and a fork-only `clerk-session` value made
  // the whole `server.getConfig` reply undecodable for App Store clients: they
  // paired, opened the socket, read the config, and hung up. Keeping the fork's
  // signal in an additive optional field means unknown-key-tolerant clients
  // ignore it instead of disconnecting.
  const clerkConfig = config.clerkAuth;
  const clerk: ServerAuthDescriptor["clerk"] =
    clerkConfig?.publishableKey !== undefined
      ? {
          publishableKey: clerkConfig.publishableKey,
          organizationId: clerkConfig.organizationId ?? null,
        }
      : undefined;
  // T3-CUSTOM(expbkt3): END

  const descriptor: ServerAuthDescriptor = {
    policy,
    bootstrapMethods,
    sessionMethods: ["browser-session-cookie", "bearer-access-token", "dpop-access-token"],
    sessionCookieName: resolveSessionCookieName({
      mode: config.mode,
      port: config.port,
      host: config.host,
      instanceKey: config.stateDir,
      environmentId: yield* serverEnvironment.getEnvironmentId,
      development: config.devUrl !== undefined,
    }),
    ...(clerk !== undefined ? { clerk } : {}),
  };

  return EnvironmentAuthPolicy.of({
    getDescriptor: () =>
      Effect.succeed(descriptor).pipe(Effect.withSpan("EnvironmentAuthPolicy.getDescriptor")),
  });
});

export const layer = Layer.effect(EnvironmentAuthPolicy, make);
