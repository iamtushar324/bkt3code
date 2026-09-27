import { EnvironmentId } from "@t3tools/contracts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
/**
 * T3-CUSTOM(expbkt3): members pairing their own devices.
 *
 * The point of the feature is to remove an administrator from the loop without
 * removing the boundary they were enforcing, so the tests come in pairs: what a
 * member can now do, and what they still cannot.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthAccessReadScope,
  AuthAccessWriteScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthRelayWriteScope,
  AuthStandardClientScopes,
  EnvironmentAuthenticatedPrincipal,
  type AuthClientSession,
  type AuthEnvironmentScope,
  type AuthPairingLink,
  type AuthSessionId,
  UserId,
  clerkSubjectForUser,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import { issuePairingCredentialForPrincipal } from "./OperatorIdentity.ts";
import {
  PAIRED_SESSION_TTL,
  SELF_SERVICE_PAIRING_LIMIT,
  canIssueSelfServicePairing,
  countSelfServicePairings,
  isSelfServiceScopeAllowed,
  ownClientSessions,
  ownPairingLinks,
  pairedSessionTtlFields,
  selfServicePairingScopes,
} from "./SelfServicePairing.ts";
import { requireEnvironmentScopeOrOwnIdentity } from "./http.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";

const MEMBER_ID = UserId.make("user_member");
const OTHER_ID = UserId.make("user_other");
const MEMBER = { subject: clerkSubjectForUser(MEMBER_ID), userId: null } as const;
const ANONYMOUS = { subject: "one-time-token", userId: null } as const;

const environmentAuthLayer = EnvironmentAuth.layer.pipe(
  Layer.provide(SqlitePersistenceMemory),
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-self-pairing-test-" })),
);

const requestMetadata = { deviceType: "desktop" as const, os: "macOS" };

const scopeSet = (...scopes: ReadonlyArray<AuthEnvironmentScope>) =>
  new Set<AuthEnvironmentScope>(scopes);

const pairingLink = (subject: string, id: string): AuthPairingLink =>
  ({ id, subject }) as unknown as AuthPairingLink;

const clientSession = (
  subject: string,
  method: AuthClientSession["method"],
  sessionId = "session",
): AuthClientSession => ({ subject, method, sessionId }) as unknown as AuthClientSession;

const principalWith = (
  scopes: ReadonlySet<AuthEnvironmentScope>,
  subject: string,
): EnvironmentAuthenticatedPrincipal["Service"] =>
  ({
    sessionId: "session-1" as AuthSessionId,
    userId: null,
    subject,
    method: "browser-session-cookie",
    scopes,
  }) as unknown as EnvironmentAuthenticatedPrincipal["Service"];

describe("what a member may delegate to their own device", () => {
  it("narrows scopes to the standard client set", () => {
    // Even a session that somehow holds administrative scopes cannot pass them on.
    expect(
      selfServicePairingScopes(scopeSet(...AuthStandardClientScopes, AuthAccessWriteScope)),
    ).toEqual([...AuthStandardClientScopes]);
    expect(selfServicePairingScopes(scopeSet(...AuthStandardClientScopes))).not.toContain(
      AuthAccessReadScope,
    );
    expect(selfServicePairingScopes(scopeSet(...AuthStandardClientScopes))).not.toContain(
      AuthRelayWriteScope,
    );
  });

  it("cannot exceed the caller's own scopes", () => {
    const readOnlyMember = scopeSet(AuthOrchestrationReadScope);
    expect(selfServicePairingScopes(readOnlyMember)).toEqual([AuthOrchestrationReadScope]);
    expect(isSelfServiceScopeAllowed([AuthOrchestrationReadScope], readOnlyMember)).toBe(true);
    expect(isSelfServiceScopeAllowed([AuthOrchestrationOperateScope], readOnlyMember)).toBe(false);
  });

  it("refuses elevated scopes outright", () => {
    const member = scopeSet(...AuthStandardClientScopes, AuthAccessWriteScope);
    expect(isSelfServiceScopeAllowed([AuthAccessWriteScope], member)).toBe(false);
    expect(isSelfServiceScopeAllowed([AuthAccessReadScope], member)).toBe(false);
    expect(isSelfServiceScopeAllowed([AuthRelayWriteScope], member)).toBe(false);
  });
});

describe("the device cap", () => {
  const subject = clerkSubjectForUser(MEMBER_ID);

  it("counts pending credentials and paired devices together", () => {
    expect(
      countSelfServicePairings({
        userId: MEMBER_ID,
        pairingLinks: [pairingLink(subject, "a"), pairingLink(subject, "b")],
        clientSessions: [
          clientSession(subject, "bearer-access-token"),
          clientSession(subject, "dpop-access-token"),
        ],
      }),
    ).toBe(4);
  });

  it("ignores other members entirely", () => {
    const otherSubject = clerkSubjectForUser(OTHER_ID);
    expect(
      countSelfServicePairings({
        userId: MEMBER_ID,
        pairingLinks: [pairingLink(otherSubject, "a")],
        clientSessions: [clientSession(otherSubject, "bearer-access-token")],
      }),
    ).toBe(0);
  });

  it("ignores browser sign-ins, which are not pairings", () => {
    // A member signing in with Clerk in three browsers must not exhaust the cap
    // they need for their laptop.
    expect(
      countSelfServicePairings({
        userId: MEMBER_ID,
        pairingLinks: [],
        clientSessions: [
          clientSession(subject, "browser-session-cookie", "s1"),
          clientSession(subject, "browser-session-cookie", "s2"),
          clientSession(subject, "browser-session-cookie", "s3"),
        ],
      }),
    ).toBe(0);
  });

  it("blocks at five and not before", () => {
    const atCap = {
      userId: MEMBER_ID,
      pairingLinks: Array.from({ length: SELF_SERVICE_PAIRING_LIMIT }, (_, index) =>
        pairingLink(subject, `link-${index}`),
      ),
      clientSessions: [],
    };
    expect(SELF_SERVICE_PAIRING_LIMIT).toBe(5);
    expect(canIssueSelfServicePairing(atCap)).toBe(false);
    expect(
      canIssueSelfServicePairing({ ...atCap, pairingLinks: atCap.pairingLinks.slice(1) }),
    ).toBe(true);
  });
});

describe("a member sees only their own devices", () => {
  const subject = clerkSubjectForUser(MEMBER_ID);
  const otherSubject = clerkSubjectForUser(OTHER_ID);

  it("filters pairing links and client sessions by subject", () => {
    expect(
      ownPairingLinks([pairingLink(subject, "mine"), pairingLink(otherSubject, "theirs")], MEMBER),
    ).toEqual([pairingLink(subject, "mine")]);
    expect(
      ownClientSessions(
        [
          clientSession(subject, "bearer-access-token", "mine"),
          clientSession(otherSubject, "bearer-access-token", "theirs"),
        ],
        MEMBER,
      ).map((session) => session.sessionId),
    ).toEqual(["mine"]);
  });

  it("shows a session with no identity nothing at all", () => {
    expect(ownPairingLinks([pairingLink(subject, "mine")], ANONYMOUS)).toEqual([]);
    expect(ownClientSessions([clientSession(subject, "bearer-access-token")], ANONYMOUS)).toEqual(
      [],
    );
  });
});

describe("who the self-service path admits", () => {
  const run = (principal: EnvironmentAuthenticatedPrincipal["Service"]) =>
    requireEnvironmentScopeOrOwnIdentity(AuthAccessWriteScope).pipe(
      Effect.provideService(EnvironmentAuthenticatedPrincipal, principal),
    );

  it.effect("routes an access:write holder down the administrative path", () =>
    run(
      principalWith(
        scopeSet(...AuthStandardClientScopes, AuthAccessWriteScope),
        clerkSubjectForUser(MEMBER_ID),
      ),
    ).pipe(Effect.map((result) => expect(result.administrative).toBe(true))),
  );

  it.effect("admits a member with an identity but no access:write", () =>
    run(principalWith(scopeSet(...AuthStandardClientScopes), clerkSubjectForUser(MEMBER_ID))).pipe(
      Effect.map((result) => expect(result.administrative).toBe(false)),
    ),
  );

  it.effect("still refuses a session with neither — a plain bootstrap client", () =>
    run(principalWith(scopeSet(...AuthStandardClientScopes), "one-time-token")).pipe(
      Effect.flip,
      Effect.map((error) => expect(error._tag).toBe("EnvironmentScopeRequiredError")),
    ),
  );
});

it.layer(
  Layer.merge(
    NodeServices.layer,
    Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(EnvironmentId.make("fork-auth-test")),
    }),
  ),
)("sessions redeemed from a member's own credential", (it) => {
  const secondsIn = (duration: Duration.Duration) => Math.round(Duration.toSeconds(duration));

  it.effect("do not expire, whoever minted the credential", () =>
    Effect.gen(function* () {
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;

      const selfIssued = yield* issuePairingCredentialForPrincipal({
        serverAuth,
        principal: MEMBER,
        scopes: AuthStandardClientScopes,
        selfIssued: true,
      });
      const memberSession = yield* serverAuth.exchangeBootstrapCredentialForAccessToken(
        selfIssued.credential,
        undefined,
        requestMetadata,
      );
      expect(memberSession.expires_in).toBeCloseTo(secondsIn(PAIRED_SESSION_TTL), -1);
      expect(secondsIn(PAIRED_SESSION_TTL)).toBe(36_500 * 24 * 60 * 60);

      // An administrator-minted credential gets the same lifetime.
      const administrative = yield* issuePairingCredentialForPrincipal({
        serverAuth,
        principal: MEMBER,
        scopes: AuthStandardClientScopes,
      });
      const adminSession = yield* serverAuth.exchangeBootstrapCredentialForAccessToken(
        administrative.credential,
        undefined,
        requestMetadata,
      );
      expect(adminSession.expires_in).toBeCloseTo(secondsIn(PAIRED_SESSION_TTL), -1);
    }).pipe(Effect.provide(environmentAuthLayer)),
  );

  it.effect("do not expire for a device-bound credential either", () =>
    Effect.gen(function* () {
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const deviceBound = yield* issuePairingCredentialForPrincipal({
        serverAuth,
        principal: MEMBER,
        scopes: AuthStandardClientScopes,
        requireProofOfPossession: true,
        selfIssued: true,
      });

      const issued = yield* serverAuth.exchangeBootstrapCredentialForAccessToken(
        deviceBound.credential,
        undefined,
        requestMetadata,
        { proofKeyThumbprint: "thumbprint-a" },
      );

      // Deliberately overrides the one-hour DPoP default: nothing refreshes the token,
      // so an hour would mean re-pairing the desktop every hour.
      expect(issued.token_type).toBe("DPoP");
      expect(issued.expires_in).toBeCloseTo(secondsIn(PAIRED_SESSION_TTL), -1);
    }).pipe(Effect.provide(environmentAuthLayer)),
  );

  it.effect("carry the member as their subject, with the scopes they asked for", () =>
    Effect.gen(function* () {
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const selfIssued = yield* issuePairingCredentialForPrincipal({
        serverAuth,
        principal: MEMBER,
        scopes: selfServicePairingScopes(scopeSet(...AuthStandardClientScopes)),
        selfIssued: true,
      });

      const links = yield* serverAuth.listPairingLinks();
      const link = links.find((candidate) => candidate.id === selfIssued.id);
      expect(link?.subject).toBe(`clerk:${MEMBER_ID}`);
      expect(link?.scopes).toEqual([...AuthStandardClientScopes]);
    }).pipe(Effect.provide(environmentAuthLayer)),
  );

  it.effect("keep the ordinary five-minute window when not device-bound", () =>
    Effect.gen(function* () {
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const now = yield* DateTime.now;
      const selfIssued = yield* issuePairingCredentialForPrincipal({
        serverAuth,
        principal: MEMBER,
        scopes: AuthStandardClientScopes,
        selfIssued: true,
      });

      const minutes = Math.round(
        (selfIssued.expiresAt.epochMilliseconds - DateTime.toUtc(now).epochMilliseconds) / 60_000,
      );
      expect(minutes).toBe(5);
    }).pipe(Effect.provide(environmentAuthLayer)),
  );
});

describe("pairedSessionTtlFields", () => {
  it("gives every pairing the never-expiring lifetime", () => {
    for (const grant of [{ selfIssued: false }, {}, { selfIssued: true }]) {
      expect(pairedSessionTtlFields(grant)).toEqual({ ttl: PAIRED_SESSION_TTL });
    }
  });
});
