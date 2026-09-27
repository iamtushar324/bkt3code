// T3-CUSTOM(expbkt3): UserId for operatorUserIdFromSessionState below.
import type { AuthSessionState, EnvironmentId, ServerConfig, UserId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type { HttpClient } from "effect/unstable/http";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { RemoteEnvironmentAuthorization } from "../authorization/service.ts";
import { EnvironmentRegistry } from "../connection/registry.ts";
import type { PreparedConnection } from "../connection/model.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { environmentEndpointUrl } from "../environment/endpoint.ts";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import { safeErrorLogAttributes } from "../errors/safeLog.ts";
import { executeAuthenticatedEnvironmentHttpRequest } from "./environmentHttpAuth.ts";
import { followStreamInEnvironment } from "./runtime.ts";

function initialConfigOption<E>(
  initialConfig: Effect.Effect<ServerConfig, E>,
): Effect.Effect<Option.Option<ServerConfig>> {
  return initialConfig.pipe(
    Effect.asSome,
    Effect.catch((error) =>
      Effect.logWarning("Could not load the initial environment configuration.").pipe(
        Effect.annotateLogs({ ...safeErrorLogAttributes(error) }),
        Effect.as(Option.none<ServerConfig>()),
      ),
    ),
  );
}

// Bounded so a wedged environment cannot pin the permissions check (and with it
// the settings UI) in a loading state for long.
const DEFAULT_SESSION_STATE_TIMEOUT_MS = 6_000;

/**
 * Read the granted scopes of this client's session on one environment via its
 * `/api/auth/session` endpoint, using the connection's authentication method
 * and refreshing relay credentials when needed.
 */
export const fetchEnvironmentSessionState = Effect.fn(
  "clientRuntime.state.fetchEnvironmentSessionState",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly signer: Option.Option<ManagedRelayDpopSigner["Service"]>;
  readonly remoteAuthorization?: Option.Option<RemoteEnvironmentAuthorization["Service"]>;
  readonly timeoutMs?: number;
}) {
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    ...input,
    group: "auth",
    method: "GET",
    url: (httpBaseUrl) => environmentEndpointUrl(httpBaseUrl, "/api/auth/session"),
    timeoutMs: input.timeoutMs ?? DEFAULT_SESSION_STATE_TIMEOUT_MS,
    request: ({ client, headers }) => client.session({ headers }),
    // This endpoint returns 200 with authenticated:false for expired credentials.
    isUnauthorizedResponse: (response) => !response.authenticated,
  });
});

// T3-CUSTOM(expbkt3): BEGIN
/**
 * The org user directory for one environment, via `/api/orchestration/users`.
 *
 * These are `UserId`s — org-level people who can own or be tagged on a thread —
 * and deliberately not the `EnvironmentUserId`s that `users.list` returns; those
 * are per-environment accounts and a different id space entirely. Lives here
 * because this module already carries the prepared-connection and auth-header
 * plumbing an environment HTTP call needs.
 */
export const fetchOrchestrationUsers = Effect.fn("clientRuntime.state.fetchOrchestrationUsers")(
  function* (input: {
    readonly prepared: PreparedConnection;
    readonly signer: Option.Option<ManagedRelayDpopSigner["Service"]>;
    readonly remoteAuthorization?: Option.Option<RemoteEnvironmentAuthorization["Service"]>;
    readonly timeoutMs?: number;
  }) {
    return yield* executeAuthenticatedEnvironmentHttpRequest({
      ...input,
      // T3-CUSTOM(expbkt3): upstream made this helper group-scoped — the caller
      // names the group and `client` is already that group, so the call is
      // `client.users(...)` rather than `client.orchestration.users(...)`.
      group: "orchestration",
      method: "GET",
      url: (httpBaseUrl) => environmentEndpointUrl(httpBaseUrl, "/api/orchestration/users"),
      timeoutMs: input.timeoutMs ?? DEFAULT_SESSION_STATE_TIMEOUT_MS,
      request: ({ client, headers }) => client.users({ headers }),
    });
  },
);
// T3-CUSTOM(expbkt3): END

// T3-CUSTOM(expbkt3): BEGIN
/**
 * The operator id an environment session reports, or null.
 *
 * Null for an unauthenticated gate state, and for a single-user or local
 * environment whose subject is not an operator. Lives here rather than in a
 * client so web and mobile answer "who am I" identically; web's
 * fork/environmentOperatorIdentity re-exports it.
 */
export function operatorUserIdFromSessionState(
  sessionState: AuthSessionState | null,
): UserId | null {
  if (sessionState === null || !sessionState.authenticated) {
    return null;
  }
  return sessionState.userId ?? null;
}
// T3-CUSTOM(expbkt3): END

export function createEnvironmentSessionAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | HttpClient.HttpClient | R, E>,
) {
  const initialConfigAtom = Atom.family((environmentId: EnvironmentId) =>
    runtime.atom(
      followStreamInEnvironment(
        environmentId,
        Stream.unwrap(
          EnvironmentSupervisor.pipe(
            Effect.map((supervisor) =>
              SubscriptionRef.changes(supervisor.session).pipe(
                Stream.mapEffect(
                  Option.match({
                    onNone: () => Effect.succeed(Option.none<ServerConfig>()),
                    onSome: (session) => initialConfigOption(session.initialConfig),
                  }),
                ),
              ),
            ),
          ),
        ),
      ),
      { initialValue: Option.none() },
    ),
  );

  // This is only the bootstrap config captured when a transport session is
  // established. Consumers that need current provider/settings state must use
  // createServerEnvironmentAtoms(...).configValueAtom instead.
  const initialConfigValueAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get): ServerConfig | null =>
      Option.getOrNull(
        Option.getOrElse(AsyncResult.value(get(initialConfigAtom(environmentId))), () =>
          Option.none(),
        ),
      ),
    ).pipe(Atom.withLabel(`environment-config-value:${environmentId}`)),
  );

  const preparedConnectionAtom = Atom.family((environmentId: EnvironmentId) =>
    runtime.atom(
      followStreamInEnvironment(
        environmentId,
        Stream.unwrap(
          EnvironmentSupervisor.pipe(
            Effect.map((supervisor) => SubscriptionRef.changes(supervisor.prepared)),
          ),
        ),
      ),
      { initialValue: Option.none<PreparedConnection>() },
    ),
  );

  const preparedConnectionValueAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) =>
      Option.getOrElse(AsyncResult.value(get(preparedConnectionAtom(environmentId))), () =>
        Option.none<PreparedConnection>(),
      ),
    ).pipe(Atom.withLabel(`environment-prepared-connection:${environmentId}`)),
  );

  // Keyed on the prepared connection's identity: a reconnect (new credential,
  // new base URL) swaps the prepared value, which re-runs the fetch, so scope
  // changes from re-pairing are picked up without an explicit refresh.
  const sessionStateAtom = Atom.family((environmentId: EnvironmentId) =>
    runtime
      .atom((get) => {
        const prepared = Option.getOrNull(get(preparedConnectionValueAtom(environmentId)));
        if (prepared === null) {
          return Effect.never;
        }
        return Effect.gen(function* () {
          const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
          const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
          return yield* fetchEnvironmentSessionState({ prepared, signer, remoteAuthorization });
        });
      })
      .pipe(
        Atom.swr({ staleTime: 30_000, revalidateOnMount: true }),
        Atom.setIdleTTL(5 * 60_000),
        Atom.withLabel(`environment-session-state:${environmentId}`),
      ),
  );

  const sessionStateValueAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make(
      (get): AuthSessionState | null =>
        Option.getOrNull(AsyncResult.value(get(sessionStateAtom(environmentId)))) ?? null,
    ).pipe(Atom.withLabel(`environment-session-state-value:${environmentId}`)),
  );

  // T3-CUSTOM(expbkt3): BEGIN — org user directory for thread tagging.
  const orchestrationUsersAtom = Atom.family((environmentId: EnvironmentId) =>
    runtime
      .atom((get) => {
        const prepared = Option.getOrNull(get(preparedConnectionValueAtom(environmentId)));
        if (prepared === null) {
          return Effect.never;
        }
        return Effect.gen(function* () {
          const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
          const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
          return yield* fetchOrchestrationUsers({ prepared, signer, remoteAuthorization });
        });
      })
      .pipe(
        Atom.swr({ staleTime: 60_000, revalidateOnMount: true }),
        Atom.setIdleTTL(5 * 60_000),
        Atom.withLabel(`environment-orchestration-users:${environmentId}`),
      ),
  );
  // T3-CUSTOM(expbkt3): END

  return {
    initialConfigAtom,
    initialConfigValueAtom,
    preparedConnectionAtom,
    preparedConnectionValueAtom,
    sessionStateAtom,
    sessionStateValueAtom,
    // T3-CUSTOM(expbkt3): org user directory.
    orchestrationUsersAtom,
  };
}
