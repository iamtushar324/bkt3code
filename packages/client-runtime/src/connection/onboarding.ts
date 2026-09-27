import type { DesktopSshEnvironmentTarget, EnvironmentId } from "@t3tools/contracts";
import { resolveRemotePairingTarget } from "@t3tools/shared/remote";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as HttpClient from "effect/unstable/http/HttpClient";

import { bootstrapRemoteBearerSession } from "../authorization/remote.ts";
import { deriveWsBaseUrl, normalizeHttpBaseUrl } from "../environment/endpoint.ts";
import { fetchRemoteEnvironmentDescriptor } from "../environment/descriptor.ts";
import * as ClientCapabilities from "../platform/capabilities.ts";
import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  BearerConnectionRegistration,
  type ConnectionCatalogEntry,
  type ConnectionCredential,
  SshConnectionProfile,
  SshConnectionRegistration,
} from "./catalog.ts";
import * as ConnectionCredentialStore from "./credentialStore.ts";
import { mapRemoteEnvironmentError } from "./errors.ts";
import {
  BearerConnectionTarget,
  ConnectionBlockedError,
  SshConnectionTarget,
  type ConnectionAttemptError,
} from "./model.ts";
import * as Persistence from "../platform/persistence.ts";
import * as EnvironmentRegistry from "./registry.ts";
import { orchestrationProtocolCompatibilityError } from "./compatibility.ts";

export interface PairingConnectionInput {
  readonly pairingUrl?: string;
  readonly host?: string;
  readonly pairingCode?: string;
}

export interface SshConnectionInput {
  readonly target: DesktopSshEnvironmentTarget;
  readonly label?: string;
}

export interface BearerConnectionUpdateInput {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly httpBaseUrl: string;
}

export class ConnectionOnboarding extends Context.Service<
  ConnectionOnboarding,
  {
    readonly registerPairing: (
      input: PairingConnectionInput,
    ) => Effect.Effect<
      EnvironmentId,
      ConnectionAttemptError | Persistence.ConnectionPersistenceError
    >;
    readonly registerSsh: (
      input: SshConnectionInput,
    ) => Effect.Effect<
      EnvironmentId,
      ConnectionAttemptError | Persistence.ConnectionPersistenceError
    >;
    readonly updateBearer: (
      input: BearerConnectionUpdateInput,
    ) => Effect.Effect<void, ConnectionAttemptError | Persistence.ConnectionPersistenceError>;
  }
>()("@t3tools/client-runtime/connection/onboarding/ConnectionOnboarding") {}

const resolvePairingTarget = Effect.fn("clientRuntime.connection.onboarding.resolvePairingTarget")(
  function* (input: PairingConnectionInput) {
    return yield* Effect.try({
      try: () => resolveRemotePairingTarget(input),
      catch: (cause) =>
        new ConnectionBlockedError({
          reason: "configuration",
          detail: cause instanceof Error ? cause.message : "The pairing details are invalid.",
        }),
    });
  },
);

export const preparePairingRegistration = Effect.fn(
  "clientRuntime.connection.onboarding.preparePairingRegistration",
)(function* (input: PairingConnectionInput) {
  const target = yield* resolvePairingTarget(input);
  const presentation = yield* ClientCapabilities.ClientPresentation;
  const descriptor = yield* fetchRemoteEnvironmentDescriptor({
    httpBaseUrl: target.httpBaseUrl,
  }).pipe(Effect.mapError(mapRemoteEnvironmentError));
  const compatibilityError = orchestrationProtocolCompatibilityError(descriptor);
  if (compatibilityError !== null) return yield* compatibilityError;
  // T3-CUSTOM(expbkt3): BEGIN — pair with the operator's Clerk identity when this
  // client has one. A team-mode environment with `environmentUserIdentityMode:
  // "required"` rejects an unidentified exchange; one set to "optional" would
  // accept it as an unrestricted operator, which is worse. Optional service, so
  // single-user clients and non-web platforms are unaffected.
  const identity = yield* Effect.serviceOption(ClientCapabilities.EnvironmentIdentity);
  const identityToken = Option.isSome(identity)
    ? yield* identity.value.identityToken
    : Option.none<string>();
  // T3-CUSTOM(expbkt3): END
  const access = yield* bootstrapRemoteBearerSession({
    httpBaseUrl: target.httpBaseUrl,
    credential: target.credential,
    scopes: presentation.scopes,
    clientMetadata: presentation.metadata,
    // T3-CUSTOM(expbkt3): BEGIN — bind the operator to the session this pairing creates.
    ...(Option.isSome(identityToken) ? { identityToken: identityToken.value } : {}),
    // T3-CUSTOM(expbkt3): END
  }).pipe(Effect.mapError(mapRemoteEnvironmentError));
  const connectionId = `bearer:${descriptor.environmentId}`;

  return new BearerConnectionRegistration({
    target: new BearerConnectionTarget({
      environmentId: descriptor.environmentId,
      label: descriptor.label,
      connectionId,
    }),
    profile: new BearerConnectionProfile({
      connectionId,
      environmentId: descriptor.environmentId,
      label: descriptor.label,
      httpBaseUrl: target.httpBaseUrl,
      wsBaseUrl: target.wsBaseUrl,
    }),
    credential: new BearerConnectionCredential({
      token: access.access_token,
    }),
  });
});

const registerPairingConnection = Effect.fn(
  "clientRuntime.connection.onboarding.registerPairingConnection",
)(function* (input: PairingConnectionInput) {
  const registration = yield* preparePairingRegistration(input);
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  yield* registry.register(registration);
  return registration.target.environmentId;
});

const isBearerCredential = Schema.is(BearerConnectionCredential);
const isBearerProfile = Schema.is(BearerConnectionProfile);

const updateBearerConnection = Effect.fn(
  "clientRuntime.connection.onboarding.updateBearerConnection",
)(function* (input: BearerConnectionUpdateInput) {
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  const credentials = yield* ConnectionCredentialStore.ConnectionCredentialStore;
  const entry = (yield* SubscriptionRef.get(registry.entries)).get(input.environmentId);
  const credential =
    entry?.target._tag === "BearerConnectionTarget"
      ? yield* credentials.get(entry.target.connectionId)
      : Option.none();
  const registration = yield* prepareBearerConnectionUpdate({
    input,
    entry: Option.fromUndefinedOr(entry),
    credential,
  });
  yield* registry.register(registration);
});

export const prepareBearerConnectionUpdate = Effect.fn(
  "clientRuntime.connection.onboarding.prepareBearerConnectionUpdate",
)(function* (options: {
  readonly input: BearerConnectionUpdateInput;
  readonly entry: Option.Option<ConnectionCatalogEntry>;
  readonly credential: Option.Option<ConnectionCredential>;
}) {
  const entry = Option.getOrNull(options.entry);
  if (
    entry === undefined ||
    entry === null ||
    entry.target._tag !== "BearerConnectionTarget" ||
    Option.isNone(entry.profile) ||
    !isBearerProfile(entry.profile.value)
  ) {
    return yield* new ConnectionBlockedError({
      reason: "configuration",
      detail: "Only saved bearer environments can be edited.",
    });
  }

  const credential = options.credential;
  if (Option.isNone(credential) || !isBearerCredential(credential.value)) {
    return yield* new ConnectionBlockedError({
      reason: "authentication",
      detail: "The saved bearer credential is unavailable.",
    });
  }

  const label = options.input.label.trim();
  if (label === "") {
    return yield* new ConnectionBlockedError({
      reason: "configuration",
      detail: "Environment label cannot be empty.",
    });
  }
  const httpBaseUrl = yield* Effect.try({
    try: () => normalizeHttpBaseUrl(options.input.httpBaseUrl),
    catch: (cause) =>
      new ConnectionBlockedError({
        reason: "configuration",
        detail: cause instanceof Error ? cause.message : "The environment URL is invalid.",
      }),
  });
  const connectionId = entry.target.connectionId;
  return new BearerConnectionRegistration({
    target: new BearerConnectionTarget({
      environmentId: options.input.environmentId,
      label,
      connectionId,
    }),
    profile: new BearerConnectionProfile({
      connectionId,
      environmentId: options.input.environmentId,
      label,
      httpBaseUrl,
      wsBaseUrl: deriveWsBaseUrl(httpBaseUrl),
    }),
    credential: credential.value,
  });
});

export const prepareSshRegistration = Effect.fn(
  "clientRuntime.connection.onboarding.prepareSshRegistration",
)(function* (input: SshConnectionInput) {
  const gateway = yield* ClientCapabilities.SshEnvironmentGateway;
  const provisioned = yield* gateway.provision(input.target);
  const connectionId = `ssh:${provisioned.environmentId}`;
  const label = input.label?.trim() || provisioned.label || provisioned.bootstrap.target.alias;

  return new SshConnectionRegistration({
    target: new SshConnectionTarget({
      environmentId: provisioned.environmentId,
      label,
      connectionId,
    }),
    profile: new SshConnectionProfile({
      connectionId,
      environmentId: provisioned.environmentId,
      label,
      target: provisioned.bootstrap.target,
    }),
  });
});

const registerSshConnection = Effect.fn(
  "clientRuntime.connection.onboarding.registerSshConnection",
)(function* (input: SshConnectionInput) {
  const registration = yield* prepareSshRegistration(input);
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  yield* registry.register(registration);
  return registration.target.environmentId;
});

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  const presentation = yield* ClientCapabilities.ClientPresentation;
  const httpClient = yield* HttpClient.HttpClient;
  const ssh = yield* ClientCapabilities.SshEnvironmentGateway;
  const credentials = yield* ConnectionCredentialStore.ConnectionCredentialStore;
  // T3-CUSTOM(expbkt3): BEGIN — capture the optional identity capability the same way the
  // other services here are captured, so pairing presents the operator regardless
  // of which runtime invokes `registerPairing`.
  const environmentIdentity = yield* Effect.serviceOption(ClientCapabilities.EnvironmentIdentity);
  // T3-CUSTOM(expbkt3): END

  return ConnectionOnboarding.of({
    registerPairing: (input) =>
      registerPairingConnection(input).pipe(
        Effect.provideService(EnvironmentRegistry.EnvironmentRegistry, registry),
        Effect.provideService(ClientCapabilities.ClientPresentation, presentation),
        Effect.provideService(HttpClient.HttpClient, httpClient),
        // T3-CUSTOM(expbkt3): BEGIN — forward the identity capability when this client has one.
        (effect) =>
          Option.isSome(environmentIdentity)
            ? effect.pipe(
                Effect.provideService(
                  ClientCapabilities.EnvironmentIdentity,
                  environmentIdentity.value,
                ),
              )
            : effect,
        // T3-CUSTOM(expbkt3): END
      ),
    registerSsh: (input) =>
      registerSshConnection(input).pipe(
        Effect.provideService(EnvironmentRegistry.EnvironmentRegistry, registry),
        Effect.provideService(ClientCapabilities.SshEnvironmentGateway, ssh),
      ),
    updateBearer: (input) =>
      updateBearerConnection(input).pipe(
        Effect.provideService(EnvironmentRegistry.EnvironmentRegistry, registry),
        Effect.provideService(ConnectionCredentialStore.ConnectionCredentialStore, credentials),
      ),
  });
});

export const layer = Layer.effect(ConnectionOnboarding, make);
