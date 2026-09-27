import {
  type AuthClientPresentationMetadata,
  type AuthEnvironmentScope,
  type DesktopSshEnvironmentBootstrap,
  type DesktopSshEnvironmentTarget,
  EnvironmentId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";

import type { ConnectionAttemptError } from "../connection/model.ts";

export interface PreparedSshEnvironment {
  readonly bootstrap: DesktopSshEnvironmentBootstrap;
  readonly bearerToken: string;
}

export interface ProvisionedSshEnvironment extends PreparedSshEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}

/** Stable for one signed-in session, including same-account token refreshes. */
export interface CloudSessionIdentity {
  readonly accountId: string;
}

export class CloudSession extends Context.Service<
  CloudSession,
  {
    readonly identity: Effect.Effect<Option.Option<CloudSessionIdentity>>;
    readonly clerkToken: Effect.Effect<string, ConnectionAttemptError>;
  }
>()("@t3tools/client-runtime/platform/capabilities/CloudSession") {}

export class RelayDeviceIdentity extends Context.Service<
  RelayDeviceIdentity,
  {
    readonly deviceId: Effect.Effect<Option.Option<string>, ConnectionAttemptError>;
  }
>()("@t3tools/client-runtime/platform/capabilities/RelayDeviceIdentity") {}

export class ClientPresentation extends Context.Service<
  ClientPresentation,
  {
    readonly metadata: AuthClientPresentationMetadata;
    readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
  }
>()("@t3tools/client-runtime/platform/capabilities/ClientPresentation") {}
// T3-CUSTOM(expbkt3): BEGIN — team-mode Clerk identity for remote pairing.
/**
 * The operator's own Clerk session token, when this client runs in team mode.
 *
 * Distinct from {@link CloudSession}, whose token belongs to the T3 Connect relay
 * and is issued by a different Clerk instance. A remote environment running the
 * fork verifies this one against its own Clerk secret, so pairing can bind the
 * operator to the session it creates.
 *
 * Read it with `Effect.serviceOption` — clients outside team mode never provide it.
 */
export class EnvironmentIdentity extends Context.Service<
  EnvironmentIdentity,
  {
    readonly identityToken: Effect.Effect<Option.Option<string>>;
  }
>()("@t3tools/client-runtime/platform/capabilities/EnvironmentIdentity") {}

// T3-CUSTOM(expbkt3): END
// T3-CUSTOM(expbkt3): BEGIN - a managed BK build's primary environment is a central
// server paired with a proof-of-possession credential, so its token is DPoP-bound: it
// is presented as `DPoP <token>` with a proof signed per request rather than as a
// static bearer header. `createProof` is supplied by the client that owns the device
// key; the runtime never sees the key itself.
export interface PrimaryDpopAuthorization {
  readonly accessToken: string;
  readonly expiresAtEpochMs: number;
  /**
   * Issues the websocket ticket and returns the socket URL. Supplied by the
   * client rather than resolved here, so the connection resolver keeps its
   * existing service requirements and never has to hold the device key.
   */
  readonly resolveSocketUrl: (input: {
    readonly wsBaseUrl: string;
  }) => Effect.Effect<string, ConnectionAttemptError>;
}
// T3-CUSTOM(expbkt3): END

export class PrimaryEnvironmentAuth extends Context.Service<
  PrimaryEnvironmentAuth,
  {
    readonly bearerToken: Effect.Effect<Option.Option<string>, ConnectionAttemptError>;
    // T3-CUSTOM(expbkt3): `Option.none()` in every build except a managed BK one, which
    // keeps the bearer path below byte-identical everywhere else.
    readonly dpopAuthorization: Effect.Effect<
      Option.Option<PrimaryDpopAuthorization>,
      ConnectionAttemptError
    >;
  }
>()("@t3tools/client-runtime/platform/capabilities/PrimaryEnvironmentAuth") {}

export class SshEnvironmentGateway extends Context.Service<
  SshEnvironmentGateway,
  {
    readonly provision: (
      target: DesktopSshEnvironmentTarget,
    ) => Effect.Effect<ProvisionedSshEnvironment, ConnectionAttemptError>;
    readonly prepare: (input: {
      readonly connectionId: string;
      readonly expectedEnvironmentId: EnvironmentId;
      readonly target: DesktopSshEnvironmentTarget;
    }) => Effect.Effect<PreparedSshEnvironment, ConnectionAttemptError>;
    readonly disconnect: (
      target: DesktopSshEnvironmentTarget,
    ) => Effect.Effect<void, ConnectionAttemptError>;
  }
>()("@t3tools/client-runtime/platform/capabilities/SshEnvironmentGateway") {}
