/** T3-CUSTOM(expbkt3): Server-owned Toolyard trust and credentials. No browser token renewal. */
import {
  EnvironmentUserId,
  PersonalMcpSettingsError,
  UserId,
  type PersonalMcpIntegration,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import { EnvironmentUserRepository } from "../persistence/EnvironmentUsers.ts";
import { toolyardManagedProfile } from "./ToolyardManagedProfile.ts";
import { ToolyardConnectionCore, ToolyardIntegrationFailure } from "./ToolyardConnectionCore.ts";

export type ToolyardStatus = Awaited<ReturnType<ToolyardConnectionCore["status"]>>;
export type ToolyardConfigureInput = Parameters<ToolyardConnectionCore["configure"]>[1];
const failure = (cause: unknown) =>
  new PersonalMcpSettingsError({
    operation: "toolyard-integration",
    message:
      cause instanceof ToolyardIntegrationFailure ? cause.code : "Toolyard integration failed.",
  });
const call = <A>(f: () => Promise<A>) => Effect.tryPromise({ try: f, catch: failure });
export class ToolyardIntegration extends Context.Service<
  ToolyardIntegration,
  {
    status: (userId: UserId) => Effect.Effect<ToolyardStatus, PersonalMcpSettingsError>;
    configure: (
      userId: UserId,
      input: ToolyardConfigureInput,
    ) => Effect.Effect<ToolyardStatus, PersonalMcpSettingsError>;
    handoff: (
      userId: UserId,
    ) => Effect.Effect<{ url: string; expiresAt: string }, PersonalMcpSettingsError>;
    instanceBinding: Effect.Effect<{
      instanceId: string;
      environmentId: string;
      origin: string;
      callbackOrigin: string;
      enabled: true;
    } | null>;
    registerCallback: (
      userId: UserId,
      input: { destination: string; secret: string; client_receiver_id: string },
    ) => Effect.Effect<{ callback_ref: string; revision: number }, PersonalMcpSettingsError>;
    updateCallback: (
      userId: UserId,
      ref: string,
      input: {
        action: "disable" | "rotate" | "remove";
        secret?: string;
        expected_revision: number;
      },
    ) => Effect.Effect<{ revision: number }, PersonalMcpSettingsError>;
  }
>()("t3/toolyard/ToolyardIntegration") {}
let activeCore: ToolyardConnectionCore | undefined;
export const toolyardIntegrationLayer = Layer.effect(
  ToolyardIntegration,
  Effect.gen(function* () {
    const secrets = yield* ServerSecretStore;
    const environment = yield* ServerEnvironmentIdentity;
    const users = yield* EnvironmentUserRepository;
    const environmentId = yield* environment.getEnvironmentId;
    const secretName = `toolyard-federation-${environmentId}`;
    const core = new ToolyardConnectionCore({
      environmentId,
      read: () =>
        Effect.runPromise(secrets.get(secretName)).then((value) =>
          Option.isSome(value) ? new TextDecoder().decode(value.value) : null,
        ),
      write: (value) => Effect.runPromise(secrets.set(secretName, new TextEncoder().encode(value))),
      verifyUser: async (userId) => {
        const user = await Effect.runPromise(users.get(EnvironmentUserId.make(userId)));
        if (Option.isNone(user) || user.value.status !== "active" || !userId.startsWith("user_"))
          throw new ToolyardIntegrationFailure("verified_active_identity_required", 403);
        return { email: user.value.primaryEmail, admin: user.value.role === "admin" };
      },
    });
    yield* call(() => core.initialize());
    activeCore = core;
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (activeCore === core) activeCore = undefined;
      }),
    );
    yield* call(() => core.reconcileRevocations()).pipe(
      Effect.catch(() => Effect.void),
      Effect.repeat(Schedule.spaced("1 minute")),
      Effect.forkScoped,
    );
    return ToolyardIntegration.of({
      status: (userId) => call(() => core.status(userId)),
      configure: (userId, input) => call(() => core.configure(userId, input)),
      handoff: (userId) => call(() => core.handoff(userId)),
      instanceBinding: Effect.sync(() => {
        const binding = core.binding();
        return binding === null
          ? null
          : { ...binding, origin: core.baseUrl()!, callbackOrigin: binding.origin };
      }),
      registerCallback: (userId, input) =>
        call(async () => {
          const result = await core.registerCallback(userId, input);
          if (typeof result.callback_ref !== "string" || typeof result.revision !== "number")
            throw new ToolyardIntegrationFailure("invalid_callback_response", 502);
          return { callback_ref: result.callback_ref, revision: result.revision };
        }),
      updateCallback: (userId, ref, input) =>
        call(async () => {
          const result = await core.updateCallback(userId, ref, input);
          if (typeof result.revision !== "number")
            throw new ToolyardIntegrationFailure("invalid_callback_response", 502);
          return { revision: result.revision };
        }),
    });
  }),
);
export const activeToolyardStatus = (userId: UserId) =>
  activeCore
    ? call(() => activeCore!.status(userId))
    : Effect.fail(failure(new ToolyardIntegrationFailure("integration_unavailable")));
export const activeToolyardConfigure = (userId: UserId, input: ToolyardConfigureInput) =>
  activeCore
    ? call(() => activeCore!.configure(userId, input))
    : Effect.fail(failure(new ToolyardIntegrationFailure("integration_unavailable")));
export const activeToolyardHandoff = (userId: UserId) =>
  activeCore
    ? call(() => activeCore!.handoff(userId))
    : Effect.fail(failure(new ToolyardIntegrationFailure("integration_unavailable")));
export const managedToolyardIntegration = (
  userId: UserId,
): Effect.Effect<PersonalMcpIntegration | null | undefined, PersonalMcpSettingsError> => {
  if (!activeCore) return Effect.succeed(undefined); // Existing isolated profile tests have no runtime module.
  return call(async () => {
    const status = await activeCore!.status(userId);
    return toolyardManagedProfile(status);
  });
};
export const managedToolyardCredential = (userId: UserId) =>
  activeCore
    ? call(() => activeCore!.credential(userId)).pipe(Effect.map((connection) => connection?.token))
    : Effect.succeed(undefined);
export const retireManagedToolyardCredential = (userId: UserId, token: string) =>
  activeCore ? call(() => activeCore!.retire(userId, token)) : Effect.succeed(false);
export const hasManagedToolyardRuntime = () => activeCore !== undefined;

export const managedToolyardCredentialForUrl = (userId: UserId, url: string) =>
  activeCore
    ? call(() => activeCore!.credentialForUrl(userId, url)).pipe(
        Effect.map((connection) => connection?.token),
      )
    : Effect.succeed(undefined);

export const managedToolyardBaseUrl = () => activeCore?.baseUrl() ?? null;
