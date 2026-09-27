import { EnvironmentId } from "@t3tools/contracts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
/**
 * T3-CUSTOM(expbkt3): proof-of-possession pairing credentials.
 *
 * Two rules are under test, and they only make sense together:
 *
 * - a credential minted with `requireProofOfPossession` lives for 2 hours instead
 *   of 5 minutes, and
 * - it can only be redeemed by a caller that presented a verified DPoP proof, so
 *   the token it yields is bound to that caller's key.
 *
 * The non-regression half matters just as much: every credential minted *without*
 * the flag must keep the exact 5-minute, plain-bearer behaviour bkt3 runs on today.
 */
import * as NodeCrypto from "node:crypto";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { AuthStandardClientScopes, UserId, clerkSubjectForUser } from "@t3tools/contracts";
import { computeDpopJwkThumbprint, type DpopPublicJwk } from "@t3tools/shared/dpop";
import { verifyDpopProof } from "@t3tools/shared/dpop";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import {
  PROOF_OF_POSSESSION_PAIRING_TTL,
  issuePairingCredentialForPrincipal,
} from "./OperatorIdentity.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import * as SessionStore from "./SessionStore.ts";

const OPERATOR_USER_ID = UserId.make("user_2abcDEF");
const OPERATOR = { subject: clerkSubjectForUser(OPERATOR_USER_ID), userId: null } as const;

const environmentAuthLayer = EnvironmentAuth.layer.pipe(
  Layer.provide(SqlitePersistenceMemory),
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-pairing-pop-test-" })),
);

const requestMetadata = { deviceType: "desktop" as const, os: "macOS" };

/** Minutes between now and `expiresAt`, rounded, so TTL assertions read plainly. */
const minutesUntil = (expiresAt: DateTime.Utc, now: DateTime.Utc): number =>
  Math.round((expiresAt.epochMilliseconds - now.epochMilliseconds) / 60_000);

const generateProofKey = () => {
  const { privateKey, publicKey } = NodeCrypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const publicJwk = publicKey.export({ format: "jwk" }) as DpopPublicJwk;
  return { privateKey, publicJwk, thumbprint: computeDpopJwkThumbprint(publicJwk) };
};

const signProof = (input: {
  readonly key: ReturnType<typeof generateProofKey>;
  readonly method: string;
  readonly url: string;
  readonly iat: number;
  readonly jti?: string;
}) => {
  const header = Buffer.from(
    JSON.stringify({ typ: "dpop+jwt", alg: "ES256", jwk: input.key.publicJwk }),
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      htm: input.method,
      htu: input.url,
      jti: input.jti ?? "proof-1",
      iat: input.iat,
    }),
  ).toString("base64url");
  const signature = NodeCrypto.sign("sha256", Buffer.from(`${header}.${payload}`), {
    key: input.key.privateKey,
    dsaEncoding: "ieee-p1363",
  }).toString("base64url");
  return `${header}.${payload}.${signature}`;
};

it.layer(
  Layer.merge(
    NodeServices.layer,
    Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(EnvironmentId.make("fork-auth-test")),
    }),
  ),
)("proof-of-possession pairing credentials", (it) => {
  it.effect("live for two hours instead of five minutes", () =>
    Effect.gen(function* () {
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const now = yield* DateTime.now;

      const deviceBound = yield* issuePairingCredentialForPrincipal({
        serverAuth,
        principal: OPERATOR,
        scopes: AuthStandardClientScopes,
        requireProofOfPossession: true,
      });

      expect(minutesUntil(deviceBound.expiresAt, DateTime.toUtc(now))).toBe(
        Duration.toMinutes(PROOF_OF_POSSESSION_PAIRING_TTL),
      );
      expect(Duration.toMinutes(PROOF_OF_POSSESSION_PAIRING_TTL)).toBe(120);
    }).pipe(Effect.provide(environmentAuthLayer)),
  );

  it.effect("cannot be redeemed as a plain bearer token", () =>
    Effect.gen(function* () {
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const deviceBound = yield* issuePairingCredentialForPrincipal({
        serverAuth,
        principal: OPERATOR,
        scopes: AuthStandardClientScopes,
        requireProofOfPossession: true,
      });

      const error = yield* serverAuth
        .exchangeBootstrapCredentialForAccessToken(
          deviceBound.credential,
          undefined,
          requestMetadata,
        )
        .pipe(Effect.flip);

      expect(error._tag).toBe("ServerAuthInvalidCredentialError");
    }).pipe(Effect.provide(environmentAuthLayer)),
  );

  it.effect("cannot be redeemed as a browser session cookie either", () =>
    Effect.gen(function* () {
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const deviceBound = yield* issuePairingCredentialForPrincipal({
        serverAuth,
        principal: OPERATOR,
        scopes: AuthStandardClientScopes,
        requireProofOfPossession: true,
      });

      const error = yield* serverAuth
        .createBrowserSession(deviceBound.credential, requestMetadata)
        .pipe(Effect.flip);

      expect(error._tag).toBe("ServerAuthInvalidCredentialError");
    }).pipe(Effect.provide(environmentAuthLayer)),
  );

  it.effect("survive a refused redemption, so a thief cannot burn the operator's credential", () =>
    Effect.gen(function* () {
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const deviceBound = yield* issuePairingCredentialForPrincipal({
        serverAuth,
        principal: OPERATOR,
        scopes: AuthStandardClientScopes,
        requireProofOfPossession: true,
      });

      yield* serverAuth
        .exchangeBootstrapCredentialForAccessToken(
          deviceBound.credential,
          undefined,
          requestMetadata,
        )
        .pipe(Effect.flip);

      // The refusal happens before the credential is consumed, so the real device
      // can still pair afterwards.
      const issued = yield* serverAuth.exchangeBootstrapCredentialForAccessToken(
        deviceBound.credential,
        undefined,
        requestMetadata,
        { proofKeyThumbprint: generateProofKey().thumbprint },
      );
      expect(issued.token_type).toBe("DPoP");
    }).pipe(Effect.provide(environmentAuthLayer)),
  );

  it.effect("yield a DPoP-bound token when redeemed with a proof", () =>
    Effect.gen(function* () {
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const key = generateProofKey();
      const deviceBound = yield* issuePairingCredentialForPrincipal({
        serverAuth,
        principal: OPERATOR,
        scopes: AuthStandardClientScopes,
        requireProofOfPossession: true,
      });

      const issued = yield* serverAuth.exchangeBootstrapCredentialForAccessToken(
        deviceBound.credential,
        undefined,
        requestMetadata,
        { proofKeyThumbprint: key.thumbprint },
      );

      expect(issued.token_type).toBe("DPoP");
      expect(issued.issued_token_type).toBe("urn:ietf:params:oauth:token-type:access_token");

      // The operator identity from the previous PR still rides on the credential.
      const sessions = yield* SessionStore.SessionStore;
      const session = yield* sessions.verify(issued.access_token);
      expect(session.subject).toBe(`clerk:${OPERATOR_USER_ID}`);
      expect(session.method).toBe("dpop-access-token");
      expect(session.proofKeyThumbprint).toBe(key.thumbprint);
    }).pipe(Effect.provide(environmentAuthLayer)),
  );
});

describe("a token bound to one key rejects proofs from another", () => {
  it("is what makes the longer window safe", () => {
    const bound = generateProofKey();
    const attacker = generateProofKey();
    // A fixed instant: the proof carries its own `iat`, and verification only
    // checks it against the value passed in here.
    const nowEpochSeconds = 1_800_000_000;
    const url = "https://bkt3.dev.beknown.live/api/auth/session";

    const legitimate = verifyDpopProof({
      proof: signProof({ key: bound, method: "GET", url, iat: nowEpochSeconds }),
      method: "GET",
      url,
      nowEpochSeconds,
      expectedThumbprint: bound.thumbprint,
    });
    expect(legitimate.ok).toBe(true);

    // Same stolen access token, a proof the attacker can legitimately sign with
    // their own key — and it still fails, because the session is pinned to the
    // thumbprint the pairing exchange recorded.
    const replayed = verifyDpopProof({
      proof: signProof({ key: attacker, method: "GET", url, iat: nowEpochSeconds }),
      method: "GET",
      url,
      nowEpochSeconds,
      expectedThumbprint: bound.thumbprint,
    });
    expect(replayed.ok).toBe(false);
  });
});

it.layer(
  Layer.merge(
    NodeServices.layer,
    Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(EnvironmentId.make("fork-auth-test")),
    }),
  ),
)("ordinary pairing credentials are untouched", (it) => {
  it.effect("keep the five-minute window and redeem as a plain bearer token", () =>
    Effect.gen(function* () {
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const now = yield* DateTime.now;

      const ordinary = yield* serverAuth.issuePairingCredential();
      expect(minutesUntil(ordinary.expiresAt, DateTime.toUtc(now))).toBe(5);

      const issued = yield* serverAuth.exchangeBootstrapCredentialForAccessToken(
        ordinary.credential,
        undefined,
        requestMetadata,
      );
      expect(issued.token_type).toBe("Bearer");
    }).pipe(Effect.provide(environmentAuthLayer)),
  );

  it.effect("keep the five-minute window when the operator mints one without the flag", () =>
    Effect.gen(function* () {
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const now = yield* DateTime.now;

      const identityBearing = yield* issuePairingCredentialForPrincipal({
        serverAuth,
        principal: OPERATOR,
        scopes: AuthStandardClientScopes,
      });

      expect(minutesUntil(identityBearing.expiresAt, DateTime.toUtc(now))).toBe(5);

      // The PR #92 behaviour is unchanged: identity still flows on the plain path.
      const issued = yield* serverAuth.exchangeBootstrapCredentialForAccessToken(
        identityBearing.credential,
        undefined,
        requestMetadata,
      );
      expect(issued.token_type).toBe("Bearer");

      const sessions = yield* SessionStore.SessionStore;
      const session = yield* sessions.verify(issued.access_token);
      expect(session.subject).toBe(`clerk:${OPERATOR_USER_ID}`);
    }).pipe(Effect.provide(environmentAuthLayer)),
  );

  it.effect("still redeem as a browser session cookie", () =>
    Effect.gen(function* () {
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const ordinary = yield* serverAuth.issuePairingCredential();

      const exchanged = yield* serverAuth.createBrowserSession(
        ordinary.credential,
        requestMetadata,
      );
      expect(exchanged.response.authenticated).toBe(true);
      expect(exchanged.response.sessionMethod).toBe("browser-session-cookie");
    }).pipe(Effect.provide(environmentAuthLayer)),
  );
});
