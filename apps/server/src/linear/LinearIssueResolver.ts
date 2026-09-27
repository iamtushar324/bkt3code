/**
 * T3-CUSTOM(expbkt3): Resolve compact Linear status through the signed-in
 * user's Bifrost integration. Credentials stay server-side and response bodies
 * are never logged because Linear issue descriptions may contain customer data.
 */
import {
  BIFROST_MCP_INTEGRATION_ID,
  BIFROST_MCP_URL,
  PersonalMcpIntegrationId,
  type LinearIssueStatusResult,
  type LinearIssueStatusSummary,
  type UserId,
} from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import type * as UserMcpProfileStore from "../mcp/UserMcpProfileStore.ts";
import type { LinearIssueStatusCache } from "./LinearIssueStatusCache.ts";
import type { LinearStatusBridge } from "./LinearStatusBridge.ts";

const LINEAR_IDENTIFIER_PATTERN = /^[A-Z][A-Z0-9]*-\d+$/u;
const MAX_ISSUES_PER_REQUEST = 25;

/**
 * Bifrost answers one issue per round trip, so a full window is this many waves
 * deep. At two it was thirteen waves — long enough that a cold read outlived the
 * sidebar's own refresh interval and was cancelled before it could finish, which
 * is how the status cache ended up with reads that never completed. Keeping the
 * whole window inside that interval is what stops that happening at all, and it
 * costs Bifrost nothing: the cache means the server reads each issue once per
 * window however many people are looking.
 */
const BIFROST_CONCURRENCY = 8;
const BIFROST_ISSUE_TIMEOUT = "12 seconds";

class LinearIssueResolverError extends Data.TaggedError("LinearIssueResolverError")<{
  readonly message: string;
}> {}

const ToolCallResponse = Schema.Struct({
  result: Schema.Struct({
    content: Schema.Array(
      Schema.Struct({
        type: Schema.String,
        text: Schema.optional(Schema.String),
      }),
    ),
  }),
});

const ToolIssue = Schema.Struct({
  id: Schema.String,
  status: Schema.String,
  statusType: Schema.optional(Schema.String),
  url: Schema.String,
  updatedAt: Schema.optional(Schema.String),
});
const ToolIssueJson = Schema.fromJsonString(ToolIssue);

const unavailable = (identifier: string, error: string): LinearIssueStatusSummary => ({
  identifier,
  url: null,
  status: null,
  statusType: null,
  updatedAt: null,
  error,
});

export const parseLinearToolResult = Effect.fn("LinearIssueResolver.parseToolResult")(function* (
  content: string,
) {
  const marker = "Return value: ";
  const markerIndex = content.lastIndexOf(marker);
  if (markerIndex < 0) {
    return yield* new LinearIssueResolverError({ message: "Bifrost returned no Linear result." });
  }
  const start = markerIndex + marker.length;
  const environmentIndex = content.indexOf("\n\nEnvironment:", start);
  const json = content.slice(start, environmentIndex < 0 ? undefined : environmentIndex).trim();
  return yield* Schema.decodeUnknownEffect(ToolIssueJson)(json).pipe(
    Effect.mapError(
      () => new LinearIssueResolverError({ message: "Bifrost returned an invalid Linear result." }),
    ),
  );
});

const resolveOne = Effect.fn("LinearIssueResolver.resolveOne")(function* (
  httpClient: HttpClient.HttpClient,
  credential: string,
  identifier: string,
) {
  const code = [
    `issue = LinearForUsers.get_issue(id="${identifier}")`,
    'result = {"id": issue.get("id"), "status": issue.get("status"), "statusType": issue.get("statusType"), "url": issue.get("url"), "updatedAt": issue.get("updatedAt")}',
  ].join("\n");
  const request = HttpClientRequest.post(BIFROST_MCP_URL).pipe(
    HttpClientRequest.setHeader("accept", "application/json, text/event-stream"),
    HttpClientRequest.setHeader("x-bf-vk", credential),
    HttpClientRequest.bodyJsonUnsafe({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "executeToolCode", arguments: { code } },
    }),
  );
  const response = yield* httpClient.execute(request);
  if (response.status < 200 || response.status >= 300) {
    return yield* new LinearIssueResolverError({
      message: `Bifrost returned HTTP ${response.status}.`,
    });
  }
  const body = yield* HttpClientResponse.schemaBodyJson(ToolCallResponse)(response);
  const content = body.result.content.find(
    (entry): entry is typeof entry & { readonly text: string } =>
      entry.type === "text" && entry.text !== undefined,
  )?.text;
  if (content === undefined) {
    return yield* new LinearIssueResolverError({ message: "Bifrost returned no text result." });
  }
  const issue = yield* parseLinearToolResult(content);
  return {
    identifier: issue.id.toUpperCase(),
    url: issue.url,
    status: issue.status,
    statusType: issue.statusType ?? null,
    updatedAt: issue.updatedAt ?? null,
    error: null,
  } satisfies LinearIssueStatusSummary;
});

export const resolveLinearIssueStatuses = Effect.fn("LinearIssueResolver.resolveStatuses")(
  function* (input: {
    readonly userId: UserId;
    readonly identifiers: ReadonlyArray<string>;
    readonly profiles: UserMcpProfileStore.UserMcpProfileStore["Service"];
    readonly httpClient: HttpClient.HttpClient;
    /** Omitted in tests that want every call to reach the upstream read. */
    readonly cache?: LinearIssueStatusCache | undefined;
    /** Absent when no bridge service token is configured; Bifrost then answers alone. */
    readonly bridge?: LinearStatusBridge | undefined;
  }) {
    const identifiers = [
      ...new Set(input.identifiers.map((identifier) => identifier.trim().toUpperCase())),
    ].slice(0, MAX_ISSUES_PER_REQUEST);
    const validIdentifiers = identifiers.filter((identifier) =>
      LINEAR_IDENTIFIER_PATTERN.test(identifier),
    );
    const invalid = identifiers
      .filter((identifier) => !LINEAR_IDENTIFIER_PATTERN.test(identifier))
      .map((identifier) => unavailable(identifier, "Invalid Linear issue identifier."));
    if (validIdentifiers.length === 0) return { issues: invalid } satisfies LinearIssueStatusResult;

    // The bridge answers first. Its credential belongs to the server, so it is
    // the only path that works for a viewer with no Bifrost integration — and
    // it costs Linear nothing, because the bridge is answering from a webhook
    // projection it already maintains.
    const bridge = input.bridge;

    // Bifrost stays as the fallback for anything the bridge has not seen, and
    // it is per-viewer, so the credential is only needed on that path.
    const credential = yield* Effect.gen(function* () {
      const configured = yield* input.profiles.get(input.userId).pipe(
        Effect.map((profile) =>
          profile.integrations.some(
            (item) =>
              item.id === BIFROST_MCP_INTEGRATION_ID && item.enabled && item.credentialConfigured,
          ),
        ),
        Effect.orElseSucceed(() => false),
      );
      return configured
        ? yield* input.profiles
            .getIntegrationCredential(
              input.userId,
              PersonalMcpIntegrationId.make(BIFROST_MCP_INTEGRATION_ID),
            )
            .pipe(Effect.orElseSucceed(() => undefined))
        : undefined;
    });

    if (bridge === undefined && credential === undefined) {
      return {
        issues: [
          ...invalid,
          ...validIdentifiers.map((identifier) =>
            unavailable(identifier, "Configure and enable Bifrost to read Linear status."),
          ),
        ],
      } satisfies LinearIssueStatusResult;
    }

    // The cache is what makes a per-minute sidebar refresh affordable: issue
    // status is the same for every viewer, so N clients collapse to one read.
    const fetchMissing = Effect.fn("LinearIssueResolver.fetchMissing")(function* (
      missing: ReadonlyArray<string>,
    ) {
      const known = bridge === undefined ? undefined : yield* bridge.lookup(missing);
      const unresolved = missing.filter((identifier) => known?.has(identifier) !== true);
      const fromBifrost =
        unresolved.length === 0
          ? []
          : credential === undefined
            ? unresolved.map((identifier) =>
                unavailable(identifier, "Configure and enable Bifrost to read Linear status."),
              )
            : yield* Effect.forEach(
                unresolved,
                (identifier) =>
                  resolveOne(input.httpClient, credential, identifier).pipe(
                    Effect.timeout(BIFROST_ISSUE_TIMEOUT),
                    Effect.catchCause(() =>
                      Effect.succeed(
                        unavailable(identifier, "Linear status is temporarily unavailable."),
                      ),
                    ),
                  ),
                { concurrency: BIFROST_CONCURRENCY },
              );
      const byIdentifier = new Map(fromBifrost.map((summary) => [summary.identifier, summary]));
      return missing.map((identifier) => known?.get(identifier) ?? byIdentifier.get(identifier)!);
    });

    const resolved =
      input.cache === undefined
        ? yield* fetchMissing(validIdentifiers)
        : yield* input.cache.resolve(validIdentifiers, fetchMissing);
    return { issues: [...invalid, ...resolved] } satisfies LinearIssueStatusResult;
  },
);
