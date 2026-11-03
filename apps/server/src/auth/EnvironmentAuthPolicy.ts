import {
  AuthEnvironmentMaintainScope,
  type ServerAuthDescriptor,
  type ServerAuthPolicy,
} from "@t3tools/contracts";
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

/** The auth policy a server started with `config` runs under. */
export function resolveServerAuthPolicy(
  config: Pick<ServerConfig.ServerConfig["Service"], "mode" | "host">,
): ServerAuthPolicy {
  if (isRemoteReachableHost(config.host)) return "remote-reachable";
  return config.mode === "desktop" ? "desktop-managed-local" : "loopback-browser";
}

/** @public */
export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const serverEnvironment = yield* ServerEnvironment.ServerEnvironmentIdentity;
  const policy = resolveServerAuthPolicy(config);

  const bootstrapMethods: ServerAuthDescriptor["bootstrapMethods"] =
    policy === "desktop-managed-local"
      ? ["desktop-bootstrap"]
      : config.mode === "desktop" && policy === "remote-reachable"
        ? ["desktop-bootstrap", "one-time-token"]
        : ["one-time-token"];

  // T3-CUSTOM(expbkt3): BEGIN — team mode advertises itself with the `clerk` descriptor alone,
  // so the SPA can render Clerk sign-in. Never a `bootstrapMethods` entry: that closed union
  // made `server.getConfig` undecodable for App Store clients, which then disconnected; an
  // additive optional field is ignored instead.
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
    serverUpdateScope: AuthEnvironmentMaintainScope,
    sessionCookieName: resolveSessionCookieName({
      mode: config.mode,
      port: config.port,
      host: config.host,
      instanceKey: config.stateDir,
      environmentId: yield* serverEnvironment.getEnvironmentId,
      development: config.devUrl !== undefined,
    }),
    ...(clerk !== undefined ? { clerk } : {}), // T3-CUSTOM(expbkt3): team mode — surface the clerk descriptor built above.
  };

  return EnvironmentAuthPolicy.of({
    getDescriptor: Effect.fn("EnvironmentAuthPolicy.getDescriptor")(function () {
      return Effect.succeed(descriptor);
    }),
  });
});

export const layer = Layer.effect(EnvironmentAuthPolicy, make);
