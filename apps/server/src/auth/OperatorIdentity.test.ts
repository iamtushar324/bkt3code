import { EnvironmentId } from "@t3tools/contracts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthCreatePairingCredentialInput,
  AuthStandardClientScopes,
  UserId,
  clerkSubjectForUser,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import {
  ANONYMOUS_PAIRING_SUBJECT,
  issuePairingCredentialForPrincipal,
  operatorSessionStateFields,
  operatorUserIdForPrincipal,
  pairingSubjectForPrincipal,
} from "./OperatorIdentity.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import * as SessionStore from "./SessionStore.ts";

const OPERATOR_USER_ID = UserId.make("user_2abcDEF");

const environmentAuthLayer = EnvironmentAuth.layer.pipe(
  Layer.provide(SqlitePersistenceMemory),
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-operator-identity-test-" })),
);

const makeCookieRequest = (
  cookieName: string,
  sessionToken: string,
): Parameters<EnvironmentAuth.EnvironmentAuth["Service"]["getSessionState"]>[0] =>
  ({
    cookies: { [cookieName]: sessionToken },
    headers: {},
  }) as unknown as Parameters<EnvironmentAuth.EnvironmentAuth["Service"]["getSessionState"]>[0];

const requestMetadata = {
  deviceType: "desktop" as const,
  os: "macOS",
};

describe("operator identity derivation", () => {
  it("reads the operator from a Clerk subject", () => {
    expect(
      operatorUserIdForPrincipal({ subject: clerkSubjectForUser(OPERATOR_USER_ID), userId: null }),
    ).toBe(OPERATOR_USER_ID);
  });

  it("prefers a durable user binding over the subject", () => {
    expect(
      operatorUserIdForPrincipal({
        subject: "one-time-token",
        userId: "user_bound" as never,
      }),
    ).toBe("user_bound");
  });

  it("has no operator for a non-Clerk subject", () => {
    expect(operatorUserIdForPrincipal({ subject: "one-time-token", userId: null })).toBeNull();
    expect(operatorUserIdForPrincipal({ subject: "cloud-connect", userId: null })).toBeNull();
  });

  it("stamps the operator on a pairing subject, and falls back otherwise", () => {
    expect(
      pairingSubjectForPrincipal({ subject: clerkSubjectForUser(OPERATOR_USER_ID), userId: null }),
    ).toBe(`clerk:${OPERATOR_USER_ID}`);
    expect(pairingSubjectForPrincipal({ subject: "one-time-token", userId: null })).toBe(
      ANONYMOUS_PAIRING_SUBJECT,
    );
  });

  it("reports the operator on session state only when there is one", () => {
    expect(
      operatorSessionStateFields({
        subject: clerkSubjectForUser(OPERATOR_USER_ID),
        userId: null,
      }),
    ).toEqual({ userId: OPERATOR_USER_ID });
    expect(operatorSessionStateFields({ subject: "one-time-token", userId: null })).toEqual({});
  });
});

describe("pairing credential payload", () => {
  it("cannot carry a subject", () => {
    // The whole point of deriving the subject server-side: a client must never be
    // able to mint a credential that impersonates a teammate.
    // `requireProofOfPossession` only ever *restricts* redemption, so it is safe to
    // accept from a client. A subject would not be, and still is not accepted.
    expect(Object.keys(AuthCreatePairingCredentialInput.fields)).toEqual([
      "label",
      "scopes",
      "requireProofOfPossession",
    ]);
    expect(Object.keys(AuthCreatePairingCredentialInput.fields)).not.toContain("subject");

    const payload: AuthCreatePairingCredentialInput = {
      label: "Tushar's MacBook",
      // @ts-expect-error - `subject` is deliberately absent from the public payload.
      subject: clerkSubjectForUser(OPERATOR_USER_ID),
    };
    expect(payload.label).toBe("Tushar's MacBook");
  });
});

it.layer(
  Layer.merge(
    NodeServices.layer,
    Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(EnvironmentId.make("fork-auth-test")),
    }),
  ),
)("issuePairingCredentialForPrincipal", (it) => {
  it.effect("carries the authenticated operator through to the paired session", () =>
    Effect.gen(function* () {
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const sessions = yield* SessionStore.SessionStore;

      const pairingCredential = yield* issuePairingCredentialForPrincipal({
        serverAuth,
        principal: { subject: clerkSubjectForUser(OPERATOR_USER_ID), userId: null },
        scopes: AuthStandardClientScopes,
        label: "BK desktop",
      });

      const exchanged = yield* serverAuth.createBrowserSession(
        pairingCredential.credential,
        requestMetadata,
      );
      const request = makeCookieRequest(sessions.cookieName, exchanged.sessionToken);
      const verified = yield* serverAuth.authenticateHttpRequest(request);

      expect(verified.subject).toBe(`clerk:${OPERATOR_USER_ID}`);

      // ...and the client can read that identity back off its own session.
      const sessionState = yield* serverAuth.getSessionState(request);
      expect(sessionState.authenticated).toBe(true);
      expect(sessionState.userId).toBe(OPERATOR_USER_ID);
    }).pipe(Effect.provide(environmentAuthLayer)),
  );

  it.effect("keeps the anonymous subject for a non-Clerk caller", () =>
    Effect.gen(function* () {
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const sessions = yield* SessionStore.SessionStore;

      const pairingCredential = yield* issuePairingCredentialForPrincipal({
        serverAuth,
        principal: { subject: "one-time-token", userId: null },
        scopes: AuthStandardClientScopes,
      });

      const exchanged = yield* serverAuth.createBrowserSession(
        pairingCredential.credential,
        requestMetadata,
      );
      const request = makeCookieRequest(sessions.cookieName, exchanged.sessionToken);

      expect((yield* serverAuth.authenticateHttpRequest(request)).subject).toBe("one-time-token");
      expect((yield* serverAuth.getSessionState(request)).userId).toBeUndefined();
    }).pipe(Effect.provide(environmentAuthLayer)),
  );
});
