/** T3-CUSTOM(expbkt3): Authenticated native MCP transport for one host-owned Toolyard connection. */
import { AuthOrchestrationOperateScope, type EnvironmentUserId, UserId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { EnvironmentAuth } from "../auth/EnvironmentAuth.ts";
import { OrchestrationAccessControl } from "../orchestration-v2/Services/AccessControl.ts";
import { resolveActiveMcpCredential } from "../mcp/McpSessionRegistry.ts";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import {
  managedToolyardCredentialForUrl,
  managedToolyardIntegration,
  ToolyardIntegration,
} from "./ToolyardIntegration.ts";
import {
  makeNativeToolyardProxy,
  type NativeToolyardProxyDependencies,
} from "./ToolyardNativeProxy.ts";

export function makeNativeToolyardAuthenticator(dependencies: {
  readonly resolveMcpCredential: (token: string) => Promise<McpInvocationScope | undefined>;
  readonly authenticateSession: (request: Request) => Promise<{
    readonly subject: string;
    readonly userId: EnvironmentUserId | null;
    readonly sessionId: string;
    readonly scopes: readonly string[];
  }>;
  readonly actorFor: (subject: string, userId: EnvironmentUserId | null) => Option.Option<UserId>;
  readonly isLocalOwner: () => Promise<boolean>;
}) {
  return async (request: Request) => {
    const authorization = request.headers.get("authorization") ?? "";
    const invocation = authorization.startsWith("Bearer ")
      ? await dependencies.resolveMcpCredential(authorization.slice(7))
      : undefined;
    if (invocation) {
      if (invocation.principal !== "external-user" || !invocation.actorUserId) return null;
      return { userId: invocation.actorUserId, sessionId: invocation.providerSessionId };
    }
    const session = await dependencies.authenticateSession(request);
    if (!session.scopes.includes(AuthOrchestrationOperateScope)) return null;
    const actor = dependencies.actorFor(session.subject, session.userId);
    const userId = Option.isSome(actor)
      ? actor.value
      : (await dependencies.isLocalOwner())
        ? UserId.make("local-user")
        : null;
    return userId ? { userId, sessionId: session.sessionId } : null;
  };
}

export const makeNativeToolyardRoute = (dependencies: NativeToolyardProxyDependencies) => {
  const proxy = makeNativeToolyardProxy(dependencies);
  return HttpRouter.add(
    "*",
    "/mcp/toolyard",
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const incoming = yield* HttpServerRequest.toWeb(request);
      return HttpServerResponse.fromWeb(yield* Effect.promise(() => proxy(incoming)));
    }).pipe(
      Effect.catch(() =>
        Effect.succeed(
          HttpServerResponse.jsonUnsafe(
            { error: "native-mcp-unavailable" },
            { status: 503, headers: { "cache-control": "no-store" } },
          ),
        ),
      ),
    ),
  );
};

export const toolyardNativeRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const auth = yield* EnvironmentAuth;
    const access = yield* OrchestrationAccessControl;
    const toolyard = yield* ToolyardIntegration;
    return makeNativeToolyardRoute({
      authenticate: makeNativeToolyardAuthenticator({
        resolveMcpCredential: (token) => Effect.runPromise(resolveActiveMcpCredential(token)),
        authenticateSession: (incoming) =>
          Effect.runPromise(auth.authenticateHttpRequest(HttpServerRequest.fromWeb(incoming))),
        actorFor: access.actorFor,
        isLocalOwner: () => Effect.runPromise(toolyard.isLocalOwner(UserId.make("local-user"))),
      }),
      connection: async (principal) => {
        const userId = UserId.make(principal.userId);
        await Effect.runPromise(toolyard.assertConnectionOwner(userId));
        const integration = await Effect.runPromise(managedToolyardIntegration(userId));
        if (!integration?.enabled || !integration.credentialConfigured) return null;
        const credential = await Effect.runPromise(
          managedToolyardCredentialForUrl(userId, integration.url),
        );
        return credential ? { url: integration.url, credential } : null;
      },
    });
  }),
);
