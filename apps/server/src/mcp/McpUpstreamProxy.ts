/**
 * T3-CUSTOM(expbkt3): Authenticated MCP reverse proxy that resolves upstream
 * credentials from the user bound to the active ACP generation.
 */
import { PersonalMcpIntegrationId, type PersonalMcpAuthMode } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import {
  Headers,
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";

import * as McpSessionRegistry from "./McpSessionRegistry.ts";
import * as UserMcpProfileStore from "./UserMcpProfileStore.ts";

const PATH = /^\/mcp\/upstream\/([A-Za-z0-9._-]+)$/;
const REQUEST_HEADERS_NOT_FORWARDED = [
  "authorization",
  "cookie",
  "host",
  "proxy-authorization",
  "connection",
  "content-length",
  "transfer-encoding",
  "upgrade",
] as const;
const RESPONSE_HEADERS_NOT_FORWARDED = new Set([
  "connection",
  "content-length",
  "set-cookie",
  "transfer-encoding",
  "upgrade",
]);

function responseHeaders(headers: Readonly<Record<string, string | undefined>>) {
  const output: Record<string, string> = { "cache-control": "no-store" };
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && !RESPONSE_HEADERS_NOT_FORWARDED.has(name.toLowerCase())) {
      output[name] = value;
    }
  }
  return output;
}

function unauthorized(message: string) {
  return HttpServerResponse.jsonUnsafe(
    { error: "invalid_personal_mcp_credential", message },
    { status: 401, headers: { "cache-control": "no-store" } },
  );
}

interface ForwardedRequestOptions {
  readonly url: string;
  readonly authMode: PersonalMcpAuthMode;
  readonly customHeaderName: string;
  readonly credential: string;
}

const makeForwardedRequest = Effect.fn("McpUpstreamProxy.makeForwardedRequest")(function* (
  incoming: Request,
  options: ForwardedRequestOptions,
) {
  const outgoingBase = HttpClientRequest.fromWeb(incoming).pipe(
    HttpClientRequest.setUrl(options.url),
  );
  let outgoing = HttpClientRequest.makeWith(
    outgoingBase.method,
    outgoingBase.url,
    outgoingBase.urlParams,
    outgoingBase.hash,
    Headers.removeMany(outgoingBase.headers, REQUEST_HEADERS_NOT_FORWARDED),
    outgoingBase.body,
  );
  if (incoming.body !== null) {
    const body = new Uint8Array(yield* Effect.promise(() => incoming.arrayBuffer()));
    outgoing = outgoing.pipe(
      HttpClientRequest.bodyUint8Array(body, incoming.headers.get("content-type") ?? undefined),
    );
  }
  switch (options.authMode) {
    case "bearer":
      outgoing = outgoing.pipe(
        HttpClientRequest.setHeader("authorization", `Bearer ${options.credential}`),
      );
      break;
    case "x-bf-vk":
      outgoing = outgoing.pipe(HttpClientRequest.setHeader("x-bf-vk", options.credential));
      break;
    case "x-api-key":
      outgoing = outgoing.pipe(HttpClientRequest.setHeader("x-api-key", options.credential));
      break;
    case "custom-header":
      outgoing = outgoing.pipe(
        HttpClientRequest.setHeader(options.customHeaderName, options.credential),
      );
      break;
  }
  return outgoing;
});

export const mcpUpstreamProxyRouteLayer = HttpRouter.add(
  "*",
  "/mcp/upstream/*",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) return HttpServerResponse.text("Bad Request", { status: 400 });
    const integrationId = url.value.pathname.match(PATH)?.[1];
    if (!integrationId) return HttpServerResponse.text("Not Found", { status: 404 });

    const rawToken = request.headers.authorization?.startsWith("Bearer ")
      ? request.headers.authorization.slice("Bearer ".length).trim()
      : "";
    const invocation = yield* McpSessionRegistry.resolveActiveMcpCredential(rawToken);
    if (
      !invocation ||
      invocation.principal !== "provider-session" ||
      invocation.actorUserId === null
    ) {
      return unauthorized("A user-bound T3 provider credential is required.");
    }

    const profile = yield* UserMcpProfileStore.getActivePersonalMcpProfile(
      invocation.actorUserId,
    ).pipe(Effect.catch(() => Effect.succeed(undefined)));
    const integration = profile?.integrations.find(
      (candidate) =>
        candidate.id === integrationId &&
        candidate.enabled &&
        candidate.credentialConfigured &&
        (candidate.providerInstanceIds.length === 0 ||
          candidate.providerInstanceIds.includes(invocation.providerInstanceId)),
    );
    if (!integration) {
      return HttpServerResponse.jsonUnsafe(
        { error: "personal_mcp_integration_unavailable", integrationId },
        { status: 403, headers: { "cache-control": "no-store" } },
      );
    }
    const credential = yield* UserMcpProfileStore.getActiveIntegrationCredential(
      invocation.actorUserId,
      PersonalMcpIntegrationId.make(integration.id),
    ).pipe(Effect.catch(() => Effect.succeed(undefined)));
    if (!credential) {
      return HttpServerResponse.jsonUnsafe(
        { error: "personal_mcp_credential_missing", integrationId },
        { status: 403, headers: { "cache-control": "no-store" } },
      );
    }

    const incoming = yield* HttpServerRequest.toWeb(request);
    if (request.method !== "GET" && integration.allowedTools.length > 0) {
      const payload = yield* Effect.promise(() =>
        incoming
          .clone()
          .json()
          .catch(() => null),
      );
      const toolName =
        payload &&
        typeof payload === "object" &&
        "method" in payload &&
        payload.method === "tools/call" &&
        "params" in payload &&
        payload.params &&
        typeof payload.params === "object" &&
        "name" in payload.params &&
        typeof payload.params.name === "string"
          ? payload.params.name
          : null;
      const requestId =
        payload !== null && typeof payload === "object" && "id" in payload ? payload.id : null;
      if (toolName !== null && !integration.allowedTools.includes(toolName)) {
        return HttpServerResponse.jsonUnsafe(
          {
            jsonrpc: "2.0",
            id: requestId,
            error: { code: -32601, message: `Tool '${toolName}' is not allowed for this user.` },
          },
          { status: 200, headers: { "cache-control": "no-store" } },
        );
      }
    }

    const outgoing = yield* makeForwardedRequest(incoming, {
      url: integration.url,
      authMode: integration.authMode,
      customHeaderName: integration.customHeaderName,
      credential,
    });

    const client = yield* HttpClient.HttpClient;
    return yield* client.execute(outgoing).pipe(
      Effect.map((response) =>
        HttpServerResponse.stream(response.stream, {
          status: response.status,
          headers: responseHeaders(response.headers),
        }),
      ),
      Effect.tap(() =>
        Effect.logInfo("personal MCP request proxied", {
          actorUserId: invocation.actorUserId,
          providerSessionId: invocation.providerSessionId,
          providerInstanceId: invocation.providerInstanceId,
          integrationId,
        }),
      ),
      Effect.catch((cause) =>
        Effect.logWarning("personal MCP upstream request failed", {
          cause,
          actorUserId: invocation.actorUserId,
          providerSessionId: invocation.providerSessionId,
          integrationId,
        }).pipe(
          Effect.as(
            HttpServerResponse.jsonUnsafe(
              { error: "personal_mcp_upstream_failed", integrationId },
              { status: 502, headers: { "cache-control": "no-store" } },
            ),
          ),
        ),
      ),
    );
  }),
);

/** Exposed for tests. */
export const __testing = {
  makeForwardedRequest,
};
