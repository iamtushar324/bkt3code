/**
 * T3-CUSTOM(expbkt3): Linear status from the bridge, not from each viewer.
 *
 * TLB already receives a Linear `Issue` data-change webhook for every issue in
 * the workspace and projects it into a table, so it can answer "what state is
 * TEC-1295 in" without calling Linear at all. Reading it from there replaces a
 * per-viewer Bifrost round trip with one service-authenticated batch request,
 * and — because the bridge's credential belongs to the server rather than the
 * person looking — it is the only path that works for a viewer who has no
 * Bifrost integration of their own. That viewer previously saw "unavailable"
 * on every row.
 *
 * Unconfigured is a supported state: with no service token the bridge is
 * skipped entirely and the Bifrost path behaves exactly as it did before.
 */
import type { LinearIssueStatusSummary } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

/** The bridge's public origin. Its read API is service-authenticated, not per-user. */
export const LINEAR_STATUS_BRIDGE_URL = "https://bkt3automations.dev.beknown.live" as const;

const BridgeIssue = Schema.Struct({
  identifier: Schema.String,
  url: Schema.NullOr(Schema.String),
  status: Schema.NullOr(Schema.String),
  statusType: Schema.NullOr(Schema.String),
  updatedAt: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
});
const BridgeAnswer = Schema.Struct({ issues: Schema.Array(BridgeIssue) });

export interface LinearStatusBridge {
  /**
   * Status for each identifier the bridge knows. Identifiers it has never seen
   * are simply absent from the result — "not known here" is not an error, and
   * the caller decides whether to ask Linear directly instead.
   */
  readonly lookup: (
    identifiers: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyMap<string, LinearIssueStatusSummary>>;
}

/** Reads the token the deploy provisions; absent means "no bridge configured". */
export const linearStatusBridgeToken = (): string | undefined => {
  const token = process.env["BRIDGE_SERVICE_TOKEN"]?.trim();
  return token === undefined || token.length === 0 ? undefined : token;
};

export const makeLinearStatusBridge = (input: {
  readonly httpClient: HttpClient.HttpClient;
  readonly token: string;
  readonly baseUrl?: string;
}): LinearStatusBridge => ({
  lookup: (identifiers) =>
    Effect.gen(function* () {
      if (identifiers.length === 0) return new Map<string, LinearIssueStatusSummary>();
      const base = input.baseUrl ?? LINEAR_STATUS_BRIDGE_URL;
      const request = HttpClientRequest.get(
        `${base}/api/v1/issues?identifiers=${encodeURIComponent(identifiers.join(","))}`,
      ).pipe(HttpClientRequest.setHeader("authorization", `Bearer ${input.token}`));
      const response = yield* input.httpClient.execute(request);
      if (response.status < 200 || response.status >= 300) {
        return new Map<string, LinearIssueStatusSummary>();
      }
      const body = yield* HttpClientResponse.schemaBodyJson(BridgeAnswer)(response);
      const known = new Map<string, LinearIssueStatusSummary>();
      for (const issue of body.issues) {
        // status null with no error is the bridge saying it has never seen the
        // issue. Recording it would pin an empty row until the entry expires.
        if (issue.status === null && issue.error === null) continue;
        known.set(issue.identifier, issue);
      }
      return known;
    }).pipe(
      // The bridge being down must never be worse than not having it: fall
      // through to the per-viewer path rather than failing the whole read.
      Effect.timeout("5 seconds"),
      Effect.catchCause(() => Effect.succeed(new Map<string, LinearIssueStatusSummary>())),
    ),
});
