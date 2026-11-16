// T3-CUSTOM(expbkt3): Agents running on a shared machine cannot tell who they
// are working for. Git identity, `whoami`, and checked-in dotfiles all describe
// the machine, not the person who owns this thread or sent this message, so an
// agent that reads them attributes one contributor's session to another.
//
// The environment-user directory is the only durable record of both facts, so
// provider sessions carry them as additive environment variables. The runtime
// marker is always present: an agent that finds `BK_IDENTITY_RUNTIME` and no
// email knows identity is unavailable, which is a different answer from "this
// is not a T3 Code session" and from guessing.

import { EnvironmentUserId, type UserId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as EnvironmentUsers from "../persistence/EnvironmentUsers.ts";
import type { ProviderSessionExecutionOptions } from "@t3tools/provider-core/server/sessionExecutionOptions.expbkt3";

export const SESSION_IDENTITY_RUNTIME_KEY = "BK_IDENTITY_RUNTIME";
export const SENDER_NAME_KEY = "BK_SENDER_NAME";
export const SENDER_EMAIL_KEY = "BK_SENDER_EMAIL";
export const SENDER_USER_ID_KEY = "BK_SENDER_USER_ID";
export const OWNER_NAME_KEY = "BK_OWNER_NAME";
export const OWNER_EMAIL_KEY = "BK_OWNER_EMAIL";
export const OWNER_USER_ID_KEY = "BK_OWNER_USER_ID";
/** Deprecated alias of `BK_OWNER_EMAIL`, kept for one release while readers move. */
export const SESSION_OWNER_EMAIL_KEY = "BK_SESSION_OWNER_EMAIL";
/** Deprecated alias of `BK_SENDER_EMAIL`, kept for one release while readers move. */
export const MESSAGE_SENDER_EMAIL_KEY = "BK_MESSAGE_SENDER_EMAIL";

/** Names this runtime so an agent can tell T3 Code from a local launcher. */
export const SESSION_IDENTITY_RUNTIME = "t3-code";

export const SESSION_IDENTITY_ENVIRONMENT_KEYS = [
  SESSION_IDENTITY_RUNTIME_KEY,
  SENDER_NAME_KEY,
  SENDER_EMAIL_KEY,
  SENDER_USER_ID_KEY,
  OWNER_NAME_KEY,
  OWNER_EMAIL_KEY,
  OWNER_USER_ID_KEY,
  SESSION_OWNER_EMAIL_KEY,
  MESSAGE_SENDER_EMAIL_KEY,
] as const;

export interface SessionIdentityRequest {
  /** Durable owner of the thread, independent of who is talking right now. */
  readonly ownerUserId: UserId | null;
  /**
   * The user who actually sent the message being answered. Never the owner by
   * fallback: an inferred sender is exactly the misattribution this replaces.
   */
  readonly senderUserId: UserId | null;
}

/** One person as the Clerk-backed environment-user directory records them. */
export interface SessionIdentityPerson {
  readonly userId: string | null;
  readonly name: string | null;
  readonly email: string | null;
}

const normalize = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
};

const personEnvironment = (
  person: SessionIdentityPerson | null | undefined,
  keys: { readonly userId: string; readonly name: string; readonly email: string },
  legacyEmailKey: string,
): NodeJS.ProcessEnv => {
  const userId = normalize(person?.userId);
  const name = normalize(person?.name);
  const email = normalize(person?.email);
  return {
    ...(name === null ? {} : { [keys.name]: name }),
    ...(email === null ? {} : { [keys.email]: email, [legacyEmailKey]: email }),
    ...(userId === null ? {} : { [keys.userId]: userId }),
  };
};

/**
 * Builds the additive environment. Absent values are omitted rather than set
 * empty, so a present `BK_SENDER_EMAIL` always means a real resolved identity.
 */
export function buildSessionIdentityEnvironment(input: {
  readonly owner?: SessionIdentityPerson | null;
  readonly sender?: SessionIdentityPerson | null;
}): NodeJS.ProcessEnv {
  return {
    [SESSION_IDENTITY_RUNTIME_KEY]: SESSION_IDENTITY_RUNTIME,
    ...personEnvironment(
      input.owner,
      { userId: OWNER_USER_ID_KEY, name: OWNER_NAME_KEY, email: OWNER_EMAIL_KEY },
      SESSION_OWNER_EMAIL_KEY,
    ),
    ...personEnvironment(
      input.sender,
      { userId: SENDER_USER_ID_KEY, name: SENDER_NAME_KEY, email: SENDER_EMAIL_KEY },
      MESSAGE_SENDER_EMAIL_KEY,
    ),
  };
}

/** Marker-only environment: the runtime is known, the people are not. */
export const unresolvedSessionIdentityEnvironment = (): NodeJS.ProcessEnv =>
  buildSessionIdentityEnvironment({});

/**
 * Compares two identity environments for equality. A provider process reads its
 * environment once at spawn, so a changed fingerprint is what makes a running
 * session stale.
 */
export function sessionIdentityFingerprint(environment: NodeJS.ProcessEnv): string {
  return JSON.stringify(SESSION_IDENTITY_ENVIRONMENT_KEYS.map((key) => environment[key] ?? null));
}

/**
 * Folds the identity variables into the environment an adapter spawns with.
 * Source-control values are laid down first so a profile's Git identity still
 * wins over whatever the machine exported, and the identity markers ride along
 * whether or not a profile is in play.
 */
export function withSessionIdentityEnvironment(
  options: ProviderSessionExecutionOptions,
): ProviderSessionExecutionOptions;
export function withSessionIdentityEnvironment(
  options: ProviderSessionExecutionOptions | undefined,
): ProviderSessionExecutionOptions | undefined;
export function withSessionIdentityEnvironment(
  options: ProviderSessionExecutionOptions | undefined,
): ProviderSessionExecutionOptions | undefined {
  const identityEnvironment = options?.identityEnvironment;
  if (options === undefined || identityEnvironment === undefined) {
    return options;
  }
  return {
    ...options,
    environment: { ...options.environment, ...identityEnvironment },
  };
}

export class SessionIdentityEnvironmentService extends Context.Service<
  SessionIdentityEnvironmentService,
  {
    readonly resolve: (input: SessionIdentityRequest) => Effect.Effect<NodeJS.ProcessEnv>;
  }
>()("t3/identity/SessionIdentityEnvironment/SessionIdentityEnvironmentService") {}

export const make = Effect.gen(function* () {
  const repository = yield* EnvironmentUsers.EnvironmentUserRepository;

  // An unreadable directory row must not stop a turn. Identity is metadata for
  // the agent, not an authorization decision — those already ran upstream of
  // this — so every failure degrades to "unknown" while the user id stays known.
  const resolvePerson = (userId: UserId): Effect.Effect<SessionIdentityPerson> =>
    repository.get(EnvironmentUserId.make(String(userId))).pipe(
      Effect.map(
        Option.match({
          onNone: () => ({ userId: String(userId), name: null, email: null }),
          onSome: (user: EnvironmentUsers.EnvironmentUserRecord) => ({
            userId: String(userId),
            name: normalize(user.displayName),
            email: normalize(user.primaryEmail),
          }),
        }),
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("session identity lookup failed", { userId, cause }).pipe(
          Effect.as({ userId: String(userId), name: null, email: null }),
        ),
      ),
    );

  const resolve: SessionIdentityEnvironmentService["Service"]["resolve"] = Effect.fn(
    "SessionIdentityEnvironmentService.resolve",
  )(function* (input) {
    const owner = input.ownerUserId === null ? null : yield* resolvePerson(input.ownerUserId);
    const sender =
      input.senderUserId === null
        ? null
        : String(input.senderUserId) === String(input.ownerUserId)
          ? owner
          : yield* resolvePerson(input.senderUserId);
    return buildSessionIdentityEnvironment({ owner, sender });
  });

  return SessionIdentityEnvironmentService.of({ resolve });
});

export const layer = Layer.effect(SessionIdentityEnvironmentService, make);
