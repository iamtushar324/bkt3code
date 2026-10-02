/**
 * T3-CUSTOM(expbkt3): the `personalMcp.connectToolyard` RPC.
 *
 * The Clerk token goes to toolyard once and nowhere else: not into the result,
 * not into a log line. The toolyard token goes into the store and nowhere else.
 * toolyard's refusals come back as plain codes, never as RPC failures.
 */
import { describe, expect, it } from "@effect/vitest";
import {
  emptyPersonalMcpProfile,
  type EnvironmentAuthorizationError,
  type PersonalMcpIntegrationId,
  PersonalMcpSettingsError,
  type PersonalMcpToolyardConnectResult,
  toolyardConnectUrl,
  UserId,
  WS_FORK_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import {
  HttpClient,
  HttpClientError,
  type HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";

import { makeForkWsHandlers, type ForkWsHandlerDeps } from "../wsForkHandlers.ts";
import { connectToolyard } from "./ToolyardConnect.ts";
import type { IntegrationConnection } from "./UserMcpProfileStore.ts";

const userId = UserId.make("user_2abc");
const clerkToken = "eyJhbGciOiJSUzI1NiJ9.clerk-session-jwt.signature";
const toolyardToken = "ty_agent_token_secret";

interface SeenRequest {
  readonly url: string;
  readonly method: string;
  readonly contentType: string | undefined;
  readonly cookie: string | undefined;
  /** The raw bytes toolyard would receive; the contract is exact about them. */
  readonly body: string | undefined;
}

const bodyText = (request: HttpClientRequest.HttpClientRequest): string | undefined => {
  const body = request.body;
  if (body._tag === "Uint8Array") return body.text ?? new TextDecoder().decode(body.body);
  return undefined;
};

const record = (request: HttpClientRequest.HttpClientRequest, seen: SeenRequest[]) => {
  seen.push({
    url: request.url,
    method: request.method,
    contentType: request.headers["content-type"],
    cookie: request.headers.cookie,
    body: bodyText(request),
  });
};

/** toolyard's answer, as the JSON (or plain text) it would send. */
const httpAnswering = (
  status: number,
  body: string,
  seen: SeenRequest[] = [],
  contentType = "application/json",
) =>
  HttpClient.make((request) => {
    record(request, seen);
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(body, {
          status,
          headers: { "content-type": contentType, "cache-control": "no-store" },
        }),
      ),
    );
  });

const httpUnreachable = HttpClient.make((request) =>
  Effect.fail(
    new HttpClientError.HttpClientError({
      reason: new HttpClientError.TransportError({ request, description: "connect ECONNREFUSED" }),
    }),
  ),
);

interface Write {
  readonly userId: string;
  readonly integrationId: string;
  readonly credential: string;
  readonly connection: IntegrationConnection | undefined;
}

const makeProfiles = (failWith?: PersonalMcpSettingsError) => {
  const writes: Write[] = [];
  const profiles = {
    setIntegrationCredential: (
      forUser: UserId,
      integrationId: PersonalMcpIntegrationId,
      credential: string,
      connection?: IntegrationConnection,
    ) =>
      failWith
        ? Effect.fail(failWith)
        : Effect.sync(() => {
            writes.push({ userId: forUser, integrationId, credential, connection });
            return emptyPersonalMcpProfile(forUser, "2026-10-02T00:00:00.000Z");
          }),
  };
  return { profiles, writes };
};

const makeHandlers = (
  httpClient: HttpClient.HttpClient,
  profiles: ReturnType<typeof makeProfiles>["profiles"],
) => {
  const deps = {
    personalMcpUserId: userId,
    // Only the one method the connect flow uses is faked.
    personalMcpProfiles: profiles as unknown as ForkWsHandlerDeps["personalMcpProfiles"],
    httpClient,
    observeRpcEffect: (_method, effect) => effect,
  } satisfies Partial<ForkWsHandlerDeps>;
  return makeForkWsHandlers(deps as unknown as ForkWsHandlerDeps);
};

/** The connect flow itself never fails; only the authorization wrapper can. */
const connect = (
  httpClient: HttpClient.HttpClient,
  profiles: ReturnType<typeof makeProfiles>["profiles"],
): Effect.Effect<PersonalMcpToolyardConnectResult, EnvironmentAuthorizationError> =>
  makeHandlers(httpClient, profiles)[WS_FORK_METHODS.personalMcpConnectToolyard]({ clerkToken });

const captureLogs = (lines: string[]) =>
  Logger.layer(
    [
      Logger.map(Logger.formatJson, (line) => {
        lines.push(line);
      }),
    ],
    { mergeWithExisting: false },
  );

describe("personalMcp.connectToolyard", () => {
  it("derives the connect endpoint from the MCP URL's origin", () => {
    expect(toolyardConnectUrl()).toBe("https://toolyard.dev.beknown.live/v1/connect/t3");
    expect(toolyardConnectUrl("https://toolyard.example/mcp")).toBe(
      "https://toolyard.example/v1/connect/t3",
    );
  });

  it.effect(
    "posts the Clerk token once, stores the toolyard token, returns only who connected",
    () =>
      Effect.gen(function* () {
        const seen: SeenRequest[] = [];
        const lines: string[] = [];
        const { profiles, writes } = makeProfiles();
        const result = yield* connect(
          httpAnswering(
            200,
            `{"token":"${toolyardToken}","email":"tushar@beknown.work","agent_id":"ag_123","user_id":"u_456"}`,
            seen,
          ),
          profiles,
        ).pipe(Effect.provide(captureLogs(lines)));

        expect(result).toEqual({ connected: true, email: "tushar@beknown.work" });

        // Exactly `{"token"}` as JSON, no cookie: anything else toolyard rejects.
        expect(seen).toEqual([
          {
            url: toolyardConnectUrl(),
            method: "POST",
            contentType: "application/json",
            cookie: undefined,
            body: `{"token":"${clerkToken}"}`,
          },
        ]);

        expect(writes).toEqual([
          {
            userId,
            integrationId: "toolyard",
            credential: toolyardToken,
            connection: { email: "tushar@beknown.work" },
          },
        ]);

        const everything = [...Object.values(result).map(String), ...lines].join("\n");
        expect(everything).not.toContain(clerkToken);
        expect(everything).not.toContain(toolyardToken);
        expect(lines.some((line) => line.includes("toolyard connected"))).toBe(true);
      }),
  );

  it.effect.each([
    [400, "bad_request"],
    [401, "invalid_token"],
    [403, "not_org_member"],
    [403, "user_disabled"],
    [403, "agent_disabled"],
    [404, "connect_disabled"],
    [429, "rate_limited"],
    [500, "internal_error"],
    [503, "clerk_unavailable"],
  ] as const)("returns toolyard's %i %s as a code and stores nothing", ([status, code]) =>
    Effect.gen(function* () {
      const lines: string[] = [];
      const { profiles, writes } = makeProfiles();
      const result = yield* connect(httpAnswering(status, `{"error":"${code}"}`), profiles).pipe(
        Effect.provide(captureLogs(lines)),
      );
      expect(result).toEqual({ connected: false, error: code });
      expect(writes).toEqual([]);
      expect(lines.join("\n")).not.toContain(clerkToken);
    }),
  );

  it.effect("reads an answer without a JSON error code as unexpected", () =>
    Effect.gen(function* () {
      const { profiles, writes } = makeProfiles();
      const result = yield* connect(
        httpAnswering(405, "Method Not Allowed", [], "text/plain"),
        profiles,
      );
      expect(result).toEqual({ connected: false, error: "unexpected_response" });
      expect(writes).toEqual([]);
    }),
  );

  it.effect("does not treat a 200 without a token as connected", () =>
    Effect.gen(function* () {
      const { profiles, writes } = makeProfiles();
      const result = yield* connect(
        httpAnswering(200, '{"email":"tushar@beknown.work","agent_id":"ag_123"}'),
        profiles,
      );
      expect(result).toEqual({ connected: false, error: "unexpected_response" });
      expect(writes).toEqual([]);
    }),
  );

  it.effect("reports an unreachable toolyard without failing the RPC", () =>
    Effect.gen(function* () {
      const { profiles, writes } = makeProfiles();
      const result = yield* connect(httpUnreachable, profiles);
      expect(result).toEqual({ connected: false, error: "unreachable" });
      expect(writes).toEqual([]);
    }),
  );

  it.effect("reports a store failure as a code and keeps both tokens out of the log", () =>
    Effect.gen(function* () {
      const lines: string[] = [];
      const { profiles } = makeProfiles(
        new PersonalMcpSettingsError({
          operation: "write-integration-secret",
          message: "disk full",
        }),
      );
      const result = yield* connect(
        httpAnswering(200, `{"token":"${toolyardToken}","email":"tushar@beknown.work"}`),
        profiles,
      ).pipe(Effect.provide(captureLogs(lines)));
      expect(result).toEqual({ connected: false, error: "store_failed" });
      const log = lines.join("\n");
      expect(log).toContain("toolyard token could not be stored");
      expect(log).not.toContain(clerkToken);
      expect(log).not.toContain(toolyardToken);
    }),
  );

  // Live clock: the timeout is the thing under test.
  it.live("gives up on a toolyard that never answers", () =>
    Effect.gen(function* () {
      const { profiles, writes } = makeProfiles();
      const result = yield* connectToolyard({
        userId,
        clerkToken,
        profiles,
        httpClient: HttpClient.make(() => Effect.never),
        timeout: "20 millis",
      });
      expect(result).toEqual({ connected: false, error: "timeout" });
      expect(writes).toEqual([]);
    }),
  );
});
