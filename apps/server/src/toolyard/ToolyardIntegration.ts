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
import * as Schema from "effect/Schema";
import { ServerConfig } from "../config.ts";
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
const HistoryIdentifier = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));
const HistoryCount = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);
export const ToolyardCallbackInspection = Schema.Struct({
  deliveries: Schema.Array(
    Schema.Struct({
      event_id: HistoryIdentifier,
      inbox_id: HistoryIdentifier,
      status: Schema.Literals(["pending", "delivering", "delivered", "failed"]),
      attempts: HistoryCount,
      terminal_reason: Schema.optional(Schema.String.check(Schema.isMaxLength(512))),
      history: Schema.Array(
        Schema.Struct({
          attempt: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
          at: HistoryCount,
          http_status: Schema.optional(
            Schema.Int.check(Schema.isGreaterThanOrEqualTo(100), Schema.isLessThanOrEqualTo(599)),
          ),
          outcome: Schema.String.check(Schema.isMaxLength(1024)),
        }),
      ).check(Schema.isMaxLength(256)),
    }),
  ).check(Schema.isMaxLength(100)),
});
export type ToolyardCallbackInspection = typeof ToolyardCallbackInspection.Type;
const decodeCallbackInspection = Schema.decodeUnknownEffect(ToolyardCallbackInspection);
const decodePullEvents = Schema.decodeUnknownEffect(
  Schema.Struct({
    events: Schema.Array(
      Schema.Struct({
        event_id: HistoryIdentifier,
        body: Schema.String.check(Schema.isMaxLength(524288)),
        headers: Schema.Struct({
          "webhook-id": HistoryIdentifier,
          "webhook-timestamp": Schema.String.check(Schema.isMaxLength(64)),
          "webhook-signature": Schema.String.check(Schema.isMaxLength(4096)),
        }),
      }),
    ).check(Schema.isMaxLength(10)),
  }),
);
export class ToolyardIntegration extends Context.Service<
  ToolyardIntegration,
  {
    status: (userId: UserId) => Effect.Effect<ToolyardStatus, PersonalMcpSettingsError>;
    configure: (
      userId: UserId,
      input: ToolyardConfigureInput,
    ) => Effect.Effect<ToolyardStatus, PersonalMcpSettingsError>;
    assertConnectionOwner: (userId: UserId) => Effect.Effect<void, PersonalMcpSettingsError>;
    isLocalOwner: (userId: UserId) => Effect.Effect<boolean>;
    callbackBinding: (
      userId: UserId,
    ) => Effect.Effect<
      ReturnType<ToolyardConnectionCore["callbackBinding"]>,
      PersonalMcpSettingsError
    >;
    pullCallback: (
      userId: UserId,
      ref: string,
    ) => Effect.Effect<
      {
        events: readonly {
          event_id: string;
          body: string;
          headers: {
            "webhook-id": string;
            "webhook-timestamp": string;
            "webhook-signature": string;
          };
        }[];
      },
      PersonalMcpSettingsError
    >;
    ackCallback: (
      userId: UserId,
      ref: string,
      eventId: string,
    ) => Effect.Effect<void, PersonalMcpSettingsError>;
    handoff: (
      userId: UserId,
    ) => Effect.Effect<{ url: string; expiresAt: string }, PersonalMcpSettingsError>;
    instanceBinding: Effect.Effect<{
      instanceId: string;
      environmentId: string;
      origin: string;
      callbackOrigin: string;
      trustGeneration?: number;
      enabled: true;
    } | null>;
    registerCallback: (
      userId: UserId,
      input: {
        destination?: string;
        transport?: "push" | "pull";
        secret: string;
        client_receiver_id: string;
        environment_id?: string;
      },
    ) => Effect.Effect<{ callback_ref: string; revision: number }, PersonalMcpSettingsError>;
    inspectCallback: (
      userId: UserId,
      ref: string,
    ) => Effect.Effect<ToolyardCallbackInspection, PersonalMcpSettingsError>;
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
let localOwnerEnabled = false;
/** The authenticated local transport already owns this fixed profile. No Clerk user is fabricated. */
export const managedToolyardActor = (userId: UserId | null) =>
  userId ?? (localOwnerEnabled ? UserId.make("local-user") : null);
let activeCore: ToolyardConnectionCore | undefined;
export const toolyardIntegrationLayer = Layer.effect(
  ToolyardIntegration,
  Effect.gen(function* () {
    const secrets = yield* ServerSecretStore;
    const config = yield* ServerConfig;
    const isLocalOwner = (userId: string) =>
      config.clerkAuth === undefined && userId === "local-user";
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
        if (isLocalOwner(userId)) return { email: null, admin: true };
        const user = await Effect.runPromise(users.get(EnvironmentUserId.make(userId)));
        if (Option.isNone(user) || user.value.status !== "active" || !userId.startsWith("user_"))
          throw new ToolyardIntegrationFailure("verified_active_identity_required", 403);
        return { email: user.value.primaryEmail, admin: user.value.role === "admin" };
      },
    });
    yield* call(() => core.initialize());
    activeCore = core;
    localOwnerEnabled = config.clerkAuth === undefined;
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (activeCore === core) {
          activeCore = undefined;
          localOwnerEnabled = false;
        }
      }),
    );
    yield* call(async () => {
      await core.reconcileRevocations();
      await core.reconcileCredentials();
    }).pipe(
      Effect.catch(() => Effect.void),
      Effect.repeat(Schedule.spaced("1 minute")),
      Effect.forkScoped,
    );
    yield* call(() => core.reconcileHostConnections()).pipe(
      Effect.catch(() => Effect.void),
      Effect.repeat(Schedule.spaced("5 seconds")),
      Effect.forkScoped,
    );
    return ToolyardIntegration.of({
      assertConnectionOwner: (userId) => call(() => core.assertConnectionOwner(userId)),
      isLocalOwner: (userId) => Effect.succeed(isLocalOwner(userId)),
      callbackBinding: (userId) =>
        call(async () => {
          await core.assertConnectionOwner(userId);
          return core.callbackBinding(userId);
        }),
      pullCallback: (userId, ref) =>
        Effect.tryPromise({
          try: (signal) => core.pullCallback(userId, ref, signal),
          catch: failure,
        }).pipe(
          Effect.flatMap(decodePullEvents),
          Effect.mapError(
            () =>
              new PersonalMcpSettingsError({
                operation: "pull-callback",
                message: "callback_pull_unavailable_or_invalid",
              }),
          ),
        ),
      ackCallback: (userId, ref, eventId) => call(() => core.ackCallback(userId, ref, eventId)),
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
      inspectCallback: (userId, ref) =>
        Effect.tryPromise({
          try: (signal) => core.inspectCallback(userId, ref, signal),
          catch: failure,
        }).pipe(
          Effect.flatMap(decodeCallbackInspection),
          Effect.mapError(
            () =>
              new PersonalMcpSettingsError({
                operation: "inspect-callback",
                message: "callback_history_unavailable_or_invalid",
              }),
          ),
        ),
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
