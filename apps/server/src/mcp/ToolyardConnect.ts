/**
 * T3-CUSTOM(expbkt3): Connects the built-in toolyard integration.
 *
 * The browser hands over a fresh Clerk session token; toolyard verifies it
 * against the Clerk instance both apps share and answers with the person's
 * toolyard agent token, which goes straight into the secret store under the
 * `toolyard` integration. Neither token is logged, traced or returned: the
 * client only learns whether it worked, as whom, and otherwise which code
 * toolyard gave. toolyard rotates the agent token on every successful call, so
 * the web app calls this only while T3 holds no token (or on an explicit
 * reconnect).
 *
 * Endpoint contract: `POST <toolyard origin>/v1/connect/t3`, JSON body exactly
 * `{"token": "<clerk jwt>"}`, no cookies. 200 → `{token, email, agent_id,
 * user_id}`; otherwise `{error: code}` with 400 bad_request, 401
 * invalid_token, 403 not_org_member | user_disabled | agent_disabled, 404
 * connect_disabled, 405, 429 rate_limited, 500 internal_error, 503
 * clerk_unavailable.
 */
import {
  PersonalMcpIntegrationId,
  type PersonalMcpToolyardConnectResult,
  TOOLYARD_MCP_INTEGRATION_ID,
  type ToolyardConnectErrorCode,
  toolyardConnectUrl,
  type UserId,
} from "@t3tools/contracts";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import type * as UserMcpProfileStore from "./UserMcpProfileStore.ts";

const DEFAULT_TIMEOUT: Duration.Input = "10 seconds";

type Exchange =
  | { readonly _tag: "response"; readonly status: number; readonly body: unknown }
  | { readonly _tag: "unreachable" }
  | { readonly _tag: "timeout" };

const readString = (body: unknown, key: string): string | undefined => {
  if (typeof body !== "object" || body === null || !(key in body)) return undefined;
  const value = (body as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
};

const failure = (error: ToolyardConnectErrorCode | string): PersonalMcpToolyardConnectResult => ({
  connected: false,
  error,
});

export interface ConnectToolyardInput {
  readonly userId: UserId;
  /** Consumed once; never stored, logged or echoed. */
  readonly clerkToken: string;
  readonly profiles: Pick<
    UserMcpProfileStore.UserMcpProfileStore["Service"],
    "setIntegrationCredential"
  >;
  readonly httpClient: HttpClient.HttpClient;
  /** Overrides for tests. */
  readonly connectUrl?: string;
  readonly timeout?: Duration.Input;
}

export const connectToolyard = Effect.fn("ToolyardConnect.connect")(function* (
  input: ConnectToolyardInput,
) {
  // toolyard answers 415 to anything but JSON and 400 to any extra field, so
  // the body is exactly `{"token"}` and the content type is set explicitly.
  const request = HttpClientRequest.post(input.connectUrl ?? toolyardConnectUrl()).pipe(
    HttpClientRequest.acceptJson,
    HttpClientRequest.setHeader("content-type", "application/json"),
    HttpClientRequest.bodyJsonUnsafe({ token: input.clerkToken }),
  );
  const exchange: Exchange = yield* input.httpClient.execute(request).pipe(
    Effect.flatMap((response) =>
      response.json.pipe(
        Effect.orElseSucceed((): unknown => undefined),
        Effect.map((body): Exchange => ({ _tag: "response", status: response.status, body })),
      ),
    ),
    Effect.catch(() => Effect.succeed<Exchange>({ _tag: "unreachable" })),
    Effect.timeoutOption(input.timeout ?? DEFAULT_TIMEOUT),
    Effect.map(Option.getOrElse((): Exchange => ({ _tag: "timeout" }))),
  );

  if (exchange._tag !== "response") {
    yield* Effect.logWarning("toolyard connect did not answer", {
      userId: input.userId,
      reason: exchange._tag,
    });
    return failure(exchange._tag);
  }

  if (exchange.status === 200) {
    const token = readString(exchange.body, "token");
    const email = readString(exchange.body, "email") ?? "";
    if (token === undefined) {
      yield* Effect.logWarning("toolyard connect answered 200 without a token", {
        userId: input.userId,
      });
      return failure("unexpected_response");
    }
    const stored = yield* input.profiles
      .setIntegrationCredential(
        input.userId,
        PersonalMcpIntegrationId.make(TOOLYARD_MCP_INTEGRATION_ID),
        token,
        { email },
      )
      .pipe(
        Effect.as(true),
        Effect.catch((cause) =>
          Effect.logWarning("toolyard token could not be stored", {
            userId: input.userId,
            operation: cause.operation,
          }).pipe(Effect.as(false)),
        ),
      );
    if (!stored) return failure("store_failed");
    yield* Effect.logInfo("toolyard connected", {
      userId: input.userId,
      agentId: readString(exchange.body, "agent_id") ?? null,
    });
    return { connected: true, email } satisfies PersonalMcpToolyardConnectResult;
  }

  const code = readString(exchange.body, "error") ?? "unexpected_response";
  yield* Effect.logInfo("toolyard connect refused", {
    userId: input.userId,
    status: exchange.status,
    code,
  });
  return failure(code);
});
