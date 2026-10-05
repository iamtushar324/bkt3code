/**
 * T3-CUSTOM(expbkt3): Authenticated MCP reverse proxy that resolves upstream
 * credentials from the user bound to the active ACP generation.
 */
import {
  isToolyardGatewayUrl,
  PersonalMcpIntegrationId,
  TOOLYARD_MCP_INTEGRATION_ID,
  type PersonalMcpAuthMode,
  type ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
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
import { makeUpstreamRejectionTracker, rejectionKey } from "./UpstreamRejectionTracker.ts";
import * as UserMcpProfileStore from "./UserMcpProfileStore.ts";
import {
  hasManagedToolyardRuntime,
  managedToolyardActor,
  managedToolyardCredentialForUrl,
  retireManagedToolyardCredential,
} from "../toolyard/ToolyardIntegration.ts";

const PATH = /^\/mcp\/upstream\/([A-Za-z0-9._-]+)$/;
/**
 * Names the T3 thread a call comes from, for toolyard's audit. Only the proxy
 * sets it, and only toward toolyard; a caller-supplied value is dropped.
 */
const T3_SESSION_ID_HEADER = "x-t3-session-id";
const REQUEST_HEADERS_NOT_FORWARDED = [
  T3_SESSION_ID_HEADER,
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
  readonly threadId: ThreadId;
  readonly integrationId?: string;
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
  if (options.integrationId === TOOLYARD_MCP_INTEGRATION_ID || isToolyardGatewayUrl(options.url)) {
    outgoing = outgoing.pipe(HttpClientRequest.setHeader(T3_SESSION_ID_HEADER, options.threadId));
  }
  return outgoing;
});

/**
 * Whether an upstream answer means the stored credential is dead. Only
 * toolyard's: its agent token is rotated or revoked outside T3 (another T3
 * origin connecting through toolyard's allowlist, the agent rotated or
 * disabled on toolyard's Agents page, two connects stored out of order), and
 * a 401 is how T3 finds out. Retiring it makes the client reconnect on its
 * next load instead of sending a dead bearer forever.
 */
export const shouldRetireUpstreamCredential = (integrationId: string, status: number): boolean =>
  integrationId === TOOLYARD_MCP_INTEGRATION_ID && status === 401;

/**
 * One 401 may be a transient verification error on toolyard's side, so a
 * token is retired only on the second consecutive 401 for that same token
 * within this window; an accepted call in between forgets the first strike.
 */
const RETIRE_AFTER_CONSECUTIVE_REJECTIONS = 2;
const REJECTION_WINDOW_MS = 10 * 60 * 1_000;
const rejections = makeUpstreamRejectionTracker({
  threshold: RETIRE_AFTER_CONSECUTIVE_REJECTIONS,
  windowMs: REJECTION_WINDOW_MS,
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
      managedToolyardActor(invocation.actorUserId) === null ||
      (invocation.actorUserId === null && integrationId !== TOOLYARD_MCP_INTEGRATION_ID)
    ) {
      return unauthorized("A user-bound T3 provider credential is required.");
    }
    const actorUserId = managedToolyardActor(invocation.actorUserId)!;

    const profile = yield* UserMcpProfileStore.getActivePersonalMcpProfile(actorUserId).pipe(
      Effect.catch(() => Effect.succeed(undefined)),
    );
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
    const credential = yield* (
      integrationId === TOOLYARD_MCP_INTEGRATION_ID && hasManagedToolyardRuntime()
        ? managedToolyardCredentialForUrl(actorUserId, integration.url)
        : UserMcpProfileStore.getActiveIntegrationCredential(
            actorUserId,
            PersonalMcpIntegrationId.make(integration.id),
          )
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
      threadId: invocation.threadId,
      integrationId,
    });

    // The agent still gets toolyard's answer as is; this only decides whether
    // T3 keeps trusting the token it just sent. Retiring is compare-and-swap
    // on that exact credential, so a Reconnect that landed meanwhile keeps
    // its new token.
    const noteUpstreamAnswer = Effect.fn("McpUpstreamProxy.noteUpstreamAnswer")(function* (
      status: number,
    ) {
      if (integrationId !== TOOLYARD_MCP_INTEGRATION_ID) return;
      const key = rejectionKey(actorUserId, credential);
      if (!shouldRetireUpstreamCredential(integrationId, status)) {
        if (status < 400) rejections.recordAcceptance(key);
        return;
      }
      const now = yield* Clock.currentTimeMillis;
      if (!rejections.recordRejection(key, now)) {
        yield* Effect.logInfo("personal MCP upstream rejected the credential once", {
          actorUserId,
          integrationId,
        });
        return;
      }
      const retired = yield* (
        hasManagedToolyardRuntime()
          ? retireManagedToolyardCredential(actorUserId, credential)
          : UserMcpProfileStore.retireActiveIntegrationCredential(
              actorUserId,
              PersonalMcpIntegrationId.make(integrationId),
              credential,
            )
      ).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("personal MCP credential could not be retired", {
            cause,
            actorUserId,
            integrationId,
          }).pipe(Effect.as(false)),
        ),
      );
      yield* retired
        ? Effect.logWarning("personal MCP credential retired after repeated upstream 401s", {
            actorUserId,
            integrationId,
          })
        : Effect.logInfo("personal MCP credential was already replaced; nothing retired", {
            actorUserId,
            integrationId,
          });
    });

    const client = yield* HttpClient.HttpClient;
    return yield* client.execute(outgoing).pipe(
      Effect.tap((response) => noteUpstreamAnswer(response.status)),
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
