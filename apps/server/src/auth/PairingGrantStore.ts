import {
  AuthAdministrativeScopes,
  AuthStandardClientScopes,
  type AuthEnvironmentScope,
  type AuthPairingLink,
  type ServerAuthBootstrapMethod,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as AuthPairingLinks from "../persistence/AuthPairingLinks.ts";

export interface BootstrapGrant {
  readonly method: ServerAuthBootstrapMethod;
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
  readonly subject: string;
  readonly label?: string;
  readonly proofKeyThumbprint?: string;
  // T3-CUSTOM(expbkt3): BEGIN - the grant may only be redeemed by a caller that
  // presented a verified DPoP proof, and the issued token is bound to that key.
  // Distinct from `proofKeyThumbprint`, which pre-binds to a key already known to
  // the issuer. Optional so seeded (desktop-bootstrap) grants are unaffected.
  readonly requiresProofOfPossession?: boolean;
  /**
   * Minted by a member for one of their own devices. Carries a shorter session
   * life and counts against that member's device cap.
   */
  readonly selfIssued?: boolean;
  // T3-CUSTOM(expbkt3): END
  readonly expiresAt: DateTime.DateTime;
}

export class UnknownBootstrapCredentialError extends Schema.TaggedError<UnknownBootstrapCredentialError>()(
  "UnknownBootstrapCredentialError",
  {},
) {
  override get message(): string {
    return "Unknown bootstrap credential.";
  }
}

export class ExpiredBootstrapCredentialError extends Schema.TaggedError<ExpiredBootstrapCredentialError>()(
  "ExpiredBootstrapCredentialError",
  {},
) {
  override get message(): string {
    return "Bootstrap credential expired.";
  }
}

export class BootstrapCredentialProofKeyMismatchError extends Schema.TaggedError<BootstrapCredentialProofKeyMismatchError>()(
  "BootstrapCredentialProofKeyMismatchError",
  {},
) {
  override get message(): string {
    return "Bootstrap credential proof key mismatch.";
  }
}

// T3-CUSTOM(expbkt3): BEGIN - redemption of a proof-of-possession credential with no
// DPoP proof. Separate from the pre-bound `ProofKeyMismatch` case so the diagnostic
// says which of the two rules was broken.
export class BootstrapCredentialProofOfPossessionRequiredError extends Schema.TaggedError<BootstrapCredentialProofOfPossessionRequiredError>()(
  "BootstrapCredentialProofOfPossessionRequiredError",
  {},
) {
  override get message(): string {
    return "Bootstrap credential must be redeemed with a DPoP proof.";
  }
}
// T3-CUSTOM(expbkt3): END

export class UnavailableBootstrapCredentialError extends Schema.TaggedError<UnavailableBootstrapCredentialError>()(
  "UnavailableBootstrapCredentialError",
  {},
) {
  override get message(): string {
    return "Bootstrap credential is no longer available.";
  }
}

export const BootstrapCredentialInvalidError = Schema.Union([
  UnknownBootstrapCredentialError,
  ExpiredBootstrapCredentialError,
  BootstrapCredentialProofKeyMismatchError,
  // T3-CUSTOM(expbkt3): proof-of-possession rule.
  BootstrapCredentialProofOfPossessionRequiredError,
  UnavailableBootstrapCredentialError,
]);
export type BootstrapCredentialInvalidError = typeof BootstrapCredentialInvalidError.Type;

export class ActivePairingLinksLoadError extends Schema.TaggedError<ActivePairingLinksLoadError>()(
  "ActivePairingLinksLoadError",
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Failed to load active pairing links.";
  }
}

export class PairingLinkRevokeError extends Schema.TaggedError<PairingLinkRevokeError>()(
  "PairingLinkRevokeError",
  {
    pairingLinkId: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to revoke pairing link '${this.pairingLinkId}'.`;
  }
}

export class PairingCredentialIssueError extends Schema.TaggedError<PairingCredentialIssueError>()(
  "PairingCredentialIssueError",
  {
    pairingLinkId: Schema.String,
    subject: Schema.String,
    label: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to issue pairing credential '${this.pairingLinkId}' for '${this.subject}'.`;
  }
}

export class PairingCredentialRandomGenerationError extends Schema.TaggedError<PairingCredentialRandomGenerationError>()(
  "PairingCredentialRandomGenerationError",
  {
    operation: Schema.Literals(["generate-id", "generate-token"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to generate pairing credential data during '${this.operation}'.`;
  }
}

export class BootstrapCredentialConsumeError extends Schema.TaggedError<BootstrapCredentialConsumeError>()(
  "BootstrapCredentialConsumeError",
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Failed to consume bootstrap credential.";
  }
}

export class BootstrapCredentialConsumeAvailableError extends Schema.TaggedError<BootstrapCredentialConsumeAvailableError>()(
  "BootstrapCredentialConsumeAvailableError",
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Failed to atomically consume an available bootstrap credential.";
  }
}

export class BootstrapCredentialLookupError extends Schema.TaggedError<BootstrapCredentialLookupError>()(
  "BootstrapCredentialLookupError",
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Failed to look up bootstrap credential state.";
  }
}

export const BootstrapCredentialInternalError = Schema.Union([
  ActivePairingLinksLoadError,
  PairingLinkRevokeError,
  PairingCredentialIssueError,
  PairingCredentialRandomGenerationError,
  BootstrapCredentialConsumeError,
  BootstrapCredentialConsumeAvailableError,
  BootstrapCredentialLookupError,
]);
export type BootstrapCredentialInternalError = typeof BootstrapCredentialInternalError.Type;
export const isBootstrapCredentialInternalError = Schema.is(BootstrapCredentialInternalError);

export const BootstrapCredentialError = Schema.Union([
  BootstrapCredentialInvalidError,
  BootstrapCredentialInternalError,
]);
export type BootstrapCredentialError = typeof BootstrapCredentialError.Type;

export interface IssuedBootstrapCredential {
  readonly id: string;
  readonly credential: string;
  readonly label?: string;
  readonly proofKeyThumbprint?: string;
  readonly expiresAt: DateTime.Utc;
}

export type BootstrapCredentialChange =
  | {
      readonly type: "pairingLinkUpserted";
      readonly pairingLink: AuthPairingLink;
    }
  | {
      readonly type: "pairingLinkRemoved";
      readonly id: string;
    };

export class PairingGrantStore extends Context.Service<
  PairingGrantStore,
  {
    readonly issueOneTimeToken: (input?: {
      readonly ttl?: Duration.Duration;
      readonly scopes?: ReadonlyArray<AuthEnvironmentScope>;
      readonly subject?: string;
      readonly label?: string;
      readonly proofKeyThumbprint?: string;
      // T3-CUSTOM(expbkt3): BEGIN - see BootstrapGrant.
      readonly requiresProofOfPossession?: boolean;
      readonly selfIssued?: boolean;
      // T3-CUSTOM(expbkt3): END
      /**
       * "startup" marks the credential the server mints for itself at boot,
       * which gets the long dev TTL when a dev URL is configured.
       */
      readonly purpose?: "startup";
    }) => Effect.Effect<IssuedBootstrapCredential, BootstrapCredentialInternalError>;
    readonly listActive: () => Effect.Effect<
      ReadonlyArray<AuthPairingLink>,
      BootstrapCredentialInternalError
    >;
    readonly streamChanges: Stream.Stream<BootstrapCredentialChange>;
    readonly revoke: (id: string) => Effect.Effect<boolean, BootstrapCredentialInternalError>;
    readonly consume: (
      credential: string,
      input?: {
        readonly proofKeyThumbprint?: string;
      },
    ) => Effect.Effect<BootstrapGrant, BootstrapCredentialError>;
    // T3-CUSTOM(expbkt3): BEGIN - read a redeemable grant's subject without consuming
    // it, so `/oauth/token` can decide whether an absent `identity_token` is actually
    // missing before it burns the credential. Returns `null` for anything that is not
    // currently redeemable, which the caller treats exactly as "no identity".
    readonly peekSubject: (
      credential: string,
    ) => Effect.Effect<string | null, BootstrapCredentialInternalError>;
    // T3-CUSTOM(expbkt3): END
  }
>()("t3/auth/PairingGrantStore") {}

interface StoredBootstrapGrant extends BootstrapGrant {
  readonly remainingUses: number | "unbounded";
}

type ConsumeResult =
  | {
      readonly _tag: "error";
      readonly reason: "not-found" | "expired";
      readonly error: BootstrapCredentialError;
    }
  | {
      readonly _tag: "success";
      readonly grant: BootstrapGrant;
    };

const DEFAULT_ONE_TIME_TOKEN_TTL_MINUTES = Duration.minutes(5);
// The desktop-bootstrap grant rides on a trusted IPC channel (fd3 or
// stdin) at backend launch, so it doesn't have to be short-lived the
// way a user-facing pairing link does. Letting it live for the
// lifetime of the backend process (24h is more than long enough for
// practical desktop use, and well under "forever" in case the seed
// gets logged anywhere by accident) means a page reload past the 5-min
// window can still recover by re-bootstrapping rather than locking
// the user out of the backend.
const DESKTOP_BOOTSTRAP_TTL_HOURS = Duration.hours(24);
// A dev server's startup token is read off a log by whoever (or whatever) is
// driving the session, often minutes later — after a `node --watch` restart, a
// detour into another task, or a hand-off to the person actually doing the
// testing. Five minutes turns that into a restart-the-server loop for no
// security benefit: the token only unlocks a local dev backend, and its holder
// could read the log anyway. Same reasoning (and duration) as the desktop
// bootstrap grant above. Only applies when a dev URL is configured; user-issued
// pairing links and real servers keep the 5-minute default.
const DEV_STARTUP_TTL_HOURS = Duration.hours(24);
const PAIRING_TOKEN_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const PAIRING_TOKEN_LENGTH = 12;
const PAIRING_TOKEN_REJECTION_LIMIT =
  Math.floor(256 / PAIRING_TOKEN_ALPHABET.length) * PAIRING_TOKEN_ALPHABET.length;

export const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const config = yield* ServerConfig.ServerConfig;
  const pairingLinks = yield* AuthPairingLinks.AuthPairingLinkRepository;
  const seededGrantsRef = yield* Ref.make(new Map<string, StoredBootstrapGrant>());
  const changesPubSub = yield* PubSub.unbounded<BootstrapCredentialChange>();
  const generatePairingToken = Effect.gen(function* () {
    let credential = "";
    while (credential.length < PAIRING_TOKEN_LENGTH) {
      const bytes = yield* crypto
        .randomBytes(PAIRING_TOKEN_LENGTH)
        .pipe(
          Effect.mapError(
            (cause) =>
              new PairingCredentialRandomGenerationError({ operation: "generate-token", cause }),
          ),
        );
      for (const byte of bytes) {
        if (byte >= PAIRING_TOKEN_REJECTION_LIMIT) {
          continue;
        }
        credential += PAIRING_TOKEN_ALPHABET[byte % PAIRING_TOKEN_ALPHABET.length]!;
        if (credential.length === PAIRING_TOKEN_LENGTH) {
          return credential;
        }
      }
    }
    return credential;
  });

  const seedGrant = (credential: string, grant: StoredBootstrapGrant) =>
    Ref.update(seededGrantsRef, (current) => {
      const next = new Map(current);
      next.set(credential, grant);
      return next;
    });

  const emitUpsert = (pairingLink: AuthPairingLink) =>
    PubSub.publish(changesPubSub, {
      type: "pairingLinkUpserted",
      pairingLink,
    }).pipe(Effect.asVoid);

  const emitRemoved = (id: string) =>
    PubSub.publish(changesPubSub, {
      type: "pairingLinkRemoved",
      id,
    }).pipe(Effect.asVoid);

  if (config.desktopBootstrapToken) {
    const now = yield* DateTime.now;
    yield* seedGrant(config.desktopBootstrapToken, {
      method: "desktop-bootstrap",
      scopes: AuthAdministrativeScopes,
      subject: "desktop-bootstrap",
      expiresAt: DateTime.add(now, {
        milliseconds: Duration.toMillis(DESKTOP_BOOTSTRAP_TTL_HOURS),
      }),
      // Unbounded uses so the renderer can re-exchange the seed for a
      // fresh bearer session after a page reload (or after the prior
      // bearer expires). The seed itself stays inside the desktop
      // process and the rendered page, both of which the user already
      // implicitly trusts.
      remainingUses: "unbounded",
    });
  }

  const listActive: PairingGrantStore["Service"]["listActive"] = Effect.fn(
    "PairingGrantStore.listActive",
  )(
    function* () {
      const now = yield* DateTime.now;
      const rows = yield* pairingLinks.listActive({ now });

      return rows.map((row) =>
        row.label
          ? ({
              id: row.id,
              scopes: row.scopes,
              subject: row.subject,
              label: row.label,
              createdAt: row.createdAt,
              expiresAt: row.expiresAt,
            } satisfies AuthPairingLink)
          : ({
              id: row.id,
              scopes: row.scopes,
              subject: row.subject,
              createdAt: row.createdAt,
              expiresAt: row.expiresAt,
            } satisfies AuthPairingLink),
      );
    },
    Effect.mapError((cause) => new ActivePairingLinksLoadError({ cause })),
  );

  const revoke: PairingGrantStore["Service"]["revoke"] = Effect.fn("PairingGrantStore.revoke")(
    function* (id) {
      const revokedAt = yield* DateTime.now;
      const revoked = yield* pairingLinks
        .revoke({
          id,
          revokedAt,
        })
        .pipe(Effect.mapError((cause) => new PairingLinkRevokeError({ pairingLinkId: id, cause })));
      if (revoked) {
        yield* emitRemoved(id);
      }
      return revoked;
    },
  );

  const issueOneTimeToken: PairingGrantStore["Service"]["issueOneTimeToken"] = Effect.fn(
    "PairingGrantStore.issueOneTimeToken",
  )(function* (input) {
    const id = yield* crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) => new PairingCredentialRandomGenerationError({ operation: "generate-id", cause }),
      ),
    );
    const credential = yield* generatePairingToken;
    const isDevStartupToken = config.devUrl !== undefined && input?.purpose === "startup";
    const ttl =
      input?.ttl ??
      (isDevStartupToken ? DEV_STARTUP_TTL_HOURS : DEFAULT_ONE_TIME_TOKEN_TTL_MINUTES);
    const now = yield* DateTime.now;
    const expiresAt = DateTime.add(now, { milliseconds: Duration.toMillis(ttl) });
    const issued: IssuedBootstrapCredential = {
      id,
      credential,
      ...(input?.label ? { label: input.label } : {}),
      ...(input?.proofKeyThumbprint ? { proofKeyThumbprint: input.proofKeyThumbprint } : {}),
      expiresAt,
    };
    const subject = input?.subject ?? "one-time-token";
    yield* pairingLinks
      .create({
        id,
        credential,
        method: "one-time-token",
        scopes: input?.scopes ?? AuthStandardClientScopes,
        subject,
        label: input?.label ?? null,
        proofKeyThumbprint: input?.proofKeyThumbprint ?? null,
        // T3-CUSTOM(expbkt3): BEGIN - both default off, so every existing caller
        // writes exactly the row it writes today.
        requiresProofOfPossession: input?.requiresProofOfPossession === true,
        selfIssued: input?.selfIssued === true,
        // T3-CUSTOM(expbkt3): END
        createdAt: now,
        expiresAt: expiresAt,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new PairingCredentialIssueError({
              pairingLinkId: id,
              subject,
              ...(input?.label ? { label: input.label } : {}),
              cause,
            }),
        ),
      );
    yield* emitUpsert({
      id,
      scopes: input?.scopes ?? AuthStandardClientScopes,
      subject: input?.subject ?? "one-time-token",
      ...(input?.label ? { label: input.label } : {}),
      createdAt: now,
      expiresAt,
    });
    return issued;
  });

  const consume: PairingGrantStore["Service"]["consume"] = Effect.fn("PairingGrantStore.consume")(
    function* (credential, input) {
      const now = yield* DateTime.now;
      const seededResult: ConsumeResult = yield* Ref.modify(
        seededGrantsRef,
        (current): readonly [ConsumeResult, Map<string, StoredBootstrapGrant>] => {
          const grant = current.get(credential);
          if (!grant) {
            return [
              {
                _tag: "error",
                reason: "not-found",
                error: new UnknownBootstrapCredentialError({}),
              },
              current,
            ];
          }

          const next = new Map(current);
          if (DateTime.isGreaterThanOrEqualTo(now, grant.expiresAt)) {
            next.delete(credential);
            return [
              {
                _tag: "error",
                reason: "expired",
                error: new ExpiredBootstrapCredentialError({}),
              },
              next,
            ];
          }

          if (grant.proofKeyThumbprint && grant.proofKeyThumbprint !== input?.proofKeyThumbprint) {
            return [
              {
                _tag: "error",
                reason: "not-found",
                error: new BootstrapCredentialProofKeyMismatchError({}),
              },
              next,
            ];
          }

          const remainingUses = grant.remainingUses;
          if (typeof remainingUses === "number") {
            if (remainingUses <= 1) {
              next.delete(credential);
            } else {
              next.set(credential, {
                ...grant,
                remainingUses: remainingUses - 1,
              });
            }
          }

          return [
            {
              _tag: "success",
              grant: {
                method: grant.method,
                scopes: grant.scopes,
                subject: grant.subject,
                ...(grant.label ? { label: grant.label } : {}),
                ...(grant.proofKeyThumbprint
                  ? { proofKeyThumbprint: grant.proofKeyThumbprint }
                  : {}),
                expiresAt: grant.expiresAt,
              } satisfies BootstrapGrant,
            },
            next,
          ];
        },
      );

      if (seededResult._tag === "success") {
        return seededResult.grant;
      }
      if (seededResult.reason !== "not-found") {
        return yield* seededResult.error;
      }

      const consumed = yield* pairingLinks
        .consumeAvailable({
          credential,
          proofKeyThumbprint: input?.proofKeyThumbprint ?? null,
          consumedAt: now,
          now,
        })
        .pipe(Effect.mapError((cause) => new BootstrapCredentialConsumeAvailableError({ cause })));

      if (Option.isSome(consumed)) {
        yield* emitRemoved(consumed.value.id);
        return {
          method: consumed.value.method,
          scopes: consumed.value.scopes,
          subject: consumed.value.subject,
          ...(consumed.value.label ? { label: consumed.value.label } : {}),
          ...(consumed.value.proofKeyThumbprint
            ? { proofKeyThumbprint: consumed.value.proofKeyThumbprint }
            : {}),
          // T3-CUSTOM(expbkt3): BEGIN - carried so callers can assert the rule a second
          // time, and so redemption knows to shorten the session it issues.
          requiresProofOfPossession: consumed.value.requiresProofOfPossession,
          selfIssued: consumed.value.selfIssued,
          // T3-CUSTOM(expbkt3): END
          expiresAt: consumed.value.expiresAt,
        } satisfies BootstrapGrant;
      }

      const matching = yield* pairingLinks
        .getByCredential({ credential })
        .pipe(Effect.mapError((cause) => new BootstrapCredentialLookupError({ cause })));
      if (Option.isNone(matching)) {
        return yield* new UnknownBootstrapCredentialError({});
      }

      if (matching.value.revokedAt !== null) {
        return yield* new UnavailableBootstrapCredentialError({});
      }

      if (matching.value.consumedAt !== null) {
        return yield* new UnknownBootstrapCredentialError({});
      }

      if (DateTime.isGreaterThanOrEqualTo(now, matching.value.expiresAt)) {
        return yield* new ExpiredBootstrapCredentialError({});
      }

      if (
        matching.value.proofKeyThumbprint !== null &&
        matching.value.proofKeyThumbprint !== input?.proofKeyThumbprint
      ) {
        return yield* new BootstrapCredentialProofKeyMismatchError({});
      }

      // T3-CUSTOM(expbkt3): BEGIN - the link is otherwise redeemable, so the only
      // remaining reason `consumeAvailable` declined it is the proof-of-possession
      // gate. The credential is deliberately still unconsumed.
      if (matching.value.requiresProofOfPossession && !input?.proofKeyThumbprint) {
        return yield* new BootstrapCredentialProofOfPossessionRequiredError({});
      }
      // T3-CUSTOM(expbkt3): END

      return yield* new UnavailableBootstrapCredentialError({});
    },
  );

  // T3-CUSTOM(expbkt3): BEGIN - see the service declaration. Deliberately mirrors the
  // availability rules `consume` applies (unrevoked, unconsumed, unexpired) rather than
  // reporting a subject for a grant that could not be redeemed anyway.
  const peekSubject: PairingGrantStore["Service"]["peekSubject"] = Effect.fn(
    "PairingGrantStore.peekSubject",
  )(function* (credential) {
    const now = yield* DateTime.now;
    const seeded = (yield* Ref.get(seededGrantsRef)).get(credential);
    if (seeded) {
      return DateTime.isGreaterThanOrEqualTo(now, seeded.expiresAt) ? null : seeded.subject;
    }
    const matching = yield* pairingLinks
      .getByCredential({ credential })
      .pipe(Effect.mapError((cause) => new BootstrapCredentialLookupError({ cause })));
    if (Option.isNone(matching)) {
      return null;
    }
    const link = matching.value;
    if (link.revokedAt !== null || link.consumedAt !== null) {
      return null;
    }
    return DateTime.isGreaterThanOrEqualTo(now, link.expiresAt) ? null : link.subject;
  });
  // T3-CUSTOM(expbkt3): END

  return PairingGrantStore.of({
    issueOneTimeToken,
    listActive,
    get streamChanges() {
      return Stream.fromPubSub(changesPubSub);
    },
    revoke,
    consume,
    // T3-CUSTOM(expbkt3): non-consuming subject read for the token exchange.
    peekSubject,
  });
});

export const layer = Layer.effect(PairingGrantStore, make).pipe(
  Layer.provideMerge(AuthPairingLinks.layer),
);
