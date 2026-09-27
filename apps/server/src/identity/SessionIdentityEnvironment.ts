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
import type { ProviderSessionExecutionOptions } from "../provider/Services/ProviderAdapter.ts";

export const SESSION_IDENTITY_RUNTIME_KEY = "BK_IDENTITY_RUNTIME";
export const SESSION_OWNER_EMAIL_KEY = "BK_SESSION_OWNER_EMAIL";
export const MESSAGE_SENDER_EMAIL_KEY = "BK_MESSAGE_SENDER_EMAIL";

/** Names this runtime so an agent can tell T3 Code from a local launcher. */
export const SESSION_IDENTITY_RUNTIME = "t3-code";

export const SESSION_IDENTITY_ENVIRONMENT_KEYS = [
  SESSION_IDENTITY_RUNTIME_KEY,
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

const normalizeEmail = (email: string | null): string | null => {
  const trimmed = email?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
};

/**
 * Builds the additive environment. Absent emails are omitted rather than set
 * empty, so `BK_SESSION_OWNER_EMAIL` in the environment always means a real
 * resolved identity.
 */
export function buildSessionIdentityEnvironment(input: {
  readonly ownerEmail: string | null;
  readonly senderEmail: string | null;
}): NodeJS.ProcessEnv {
  const ownerEmail = normalizeEmail(input.ownerEmail);
  const senderEmail = normalizeEmail(input.senderEmail);
  return {
    [SESSION_IDENTITY_RUNTIME_KEY]: SESSION_IDENTITY_RUNTIME,
    ...(ownerEmail === null ? {} : { [SESSION_OWNER_EMAIL_KEY]: ownerEmail }),
    ...(senderEmail === null ? {} : { [MESSAGE_SENDER_EMAIL_KEY]: senderEmail }),
  };
}

/** Marker-only environment: the runtime is known, the people are not. */
export const unresolvedSessionIdentityEnvironment = (): NodeJS.ProcessEnv =>
  buildSessionIdentityEnvironment({ ownerEmail: null, senderEmail: null });

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
  // this — so every failure degrades to "unknown".
  const resolveEmail = (userId: UserId): Effect.Effect<string | null> =>
    repository.get(EnvironmentUserId.make(String(userId))).pipe(
      Effect.map(
        Option.match({
          onNone: () => null,
          onSome: (user: EnvironmentUsers.EnvironmentUserRecord) =>
            normalizeEmail(user.primaryEmail),
        }),
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("session identity lookup failed", { userId, cause }).pipe(
          Effect.as(null),
        ),
      ),
    );

  const resolve: SessionIdentityEnvironmentService["Service"]["resolve"] = Effect.fn(
    "SessionIdentityEnvironmentService.resolve",
  )(function* (input) {
    const ownerEmail = input.ownerUserId === null ? null : yield* resolveEmail(input.ownerUserId);
    const senderEmail =
      input.senderUserId === null
        ? null
        : String(input.senderUserId) === String(input.ownerUserId)
          ? ownerEmail
          : yield* resolveEmail(input.senderUserId);
    return buildSessionIdentityEnvironment({ ownerEmail, senderEmail });
  });

  return SessionIdentityEnvironmentService.of({ resolve });
});

export const layer = Layer.effect(SessionIdentityEnvironmentService, make);
