/**
 * T3-CUSTOM(expbkt3): who may approve an outside MCP agent, and what it becomes.
 * An anonymous pairing code must not approve an agent when identity is required,
 * and only an approval holding `access:write` makes an unbound operator.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthAdministrativeScopes,
  AuthStandardClientScopes,
  clerkSubjectForUser,
  type EnvironmentUserIdentityMode,
  UserId,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpServerRequest from "effect/http/HttpServerRequest";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { oauthClientForkFields } from "../mcp/clientAccess.expbkt3.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import * as McpOAuth from "./McpOAuth.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import { deriveAuthClientMetadata } from "./utils.ts";

const ORIGIN = "https://box.example.ts.net";
const REDIRECT = "http://localhost/callback";
const ALICE = UserId.make("user_clerk_alice");

const layerFor = (identityMode: EnvironmentUserIdentityMode) => {
  const layerConfig = ServerConfig.layerTest(process.cwd(), {
    prefix: "t3-mcp-approval-policy-test-",
  });
  const layerAuth = EnvironmentAuth.layer.pipe(
    Layer.provide(Sqlite.layerMemory),
    Layer.provideMerge(ServerSecretStore.layer),
    Layer.provideMerge(ServerEnvironment.layerIdentity),
    Layer.provide(layerConfig),
  );
  return McpOAuth.layer.pipe(
    Layer.provideMerge(layerAuth),
    Layer.provide(ServerSettings.layerTest({ environmentUserIdentityMode: identityMode })),
    Layer.provide(layerConfig),
    Layer.provideMerge(NodeServices.layer),
  );
};

const request = (headers: Record<string, string> = {}) =>
  HttpServerRequest.fromWeb(new Request(`${ORIGIN}/oauth/mcp/decision`, { headers }));

const authorization: McpOAuth.AuthorizationRequest = {
  client: { clientId: "client-approval-policy", name: "Test agent", redirectUris: [REDIRECT] },
  redirectUri: REDIRECT,
  codeChallenge: "c".repeat(43),
  state: undefined,
  resource: `${ORIGIN}/mcp`,
  issuer: ORIGIN,
};

const approveWithCode = (code: string) =>
  McpOAuth.McpOAuth.pipe(
    Effect.flatMap((oauth) =>
      oauth.approve({
        request: request(),
        authorization,
        decision: { _tag: "pairing-code", access: "auto", code },
      }),
    ),
  );

/** The client an approval code makes: its team user, operator flag, and fork principal. */
const clientFromCode = (code: string) =>
  Effect.gen(function* () {
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const approval = yield* auth.consumeMcpApprovalCode(code, "auto");
    const issued = yield* auth.issueMcpClientSession({
      label: "Test agent",
      access: "auto",
      client: deriveAuthClientMetadata({ request: request() }),
      userId: approval.userId,
      operator: approval.operator,
    });
    const client = yield* auth.authenticateMcpClient(
      request({ authorization: `Bearer ${issued.token}` }),
    );
    return oauthClientForkFields({
      access: client.access,
      userId: client.userId === null ? null : UserId.make(client.userId),
      operator: client.operator,
    });
  });

it.effect("refuses an anonymous pairing code when identity is required", () =>
  Effect.gen(function* () {
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const pairing = yield* auth.issuePairingCredential({ scopes: [...AuthAdministrativeScopes] });
    const refused = yield* Effect.flip(approveWithCode(pairing.credential));
    expect(refused).toMatchObject({
      _tag: "ServerAuthMcpApprovalCodeError",
      reason: "not_a_pairing_code",
    });
  }).pipe(Effect.provide(layerFor("required"))),
);

it.effect("approves a code minted for a team user when identity is required", () =>
  Effect.gen(function* () {
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const pairing = yield* auth.createPairingLink({
      scopes: [...AuthStandardClientScopes],
      subject: clerkSubjectForUser(ALICE),
    });
    const redirect = yield* approveWithCode(pairing.credential);
    expect(new URL(redirect).searchParams.get("code")).toBeTruthy();
  }).pipe(Effect.provide(layerFor("required"))),
);

it.effect("makes an anonymous standard-scope approval an unbound non-operator", () =>
  Effect.gen(function* () {
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const pairing = yield* auth.issuePairingCredential({ scopes: [...AuthStandardClientScopes] });
    expect(yield* clientFromCode(pairing.credential)).toMatchObject({
      principal: "external-user",
      actorUserId: null,
    });
  }).pipe(Effect.provide(layerFor("optional"))),
);

it.effect("makes an anonymous approval holding access:write an operator", () =>
  Effect.gen(function* () {
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const pairing = yield* auth.issuePairingCredential({ scopes: [...AuthAdministrativeScopes] });
    expect(yield* clientFromCode(pairing.credential)).toMatchObject({
      principal: "external-operator",
      actorUserId: null,
    });
  }).pipe(Effect.provide(layerFor("optional"))),
);

it.effect("binds a team user's approval to that user, even with access:write", () =>
  Effect.gen(function* () {
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const pairing = yield* auth.createPairingLink({
      scopes: [...AuthAdministrativeScopes],
      subject: clerkSubjectForUser(ALICE),
    });
    expect(yield* clientFromCode(pairing.credential)).toMatchObject({
      principal: "external-user",
      actorUserId: ALICE,
    });
  }).pipe(Effect.provide(layerFor("optional"))),
);
