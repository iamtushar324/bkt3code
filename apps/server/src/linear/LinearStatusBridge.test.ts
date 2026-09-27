// T3-CUSTOM(expbkt3): the bridge read, including every way it is allowed to fail.
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import { makeLinearStatusBridge } from "./LinearStatusBridge.ts";

/** The repo forbids raw JSON.stringify; this is the codebase's own encoder. */
const encodeJsonText = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const answering = (
  body: unknown,
  status = 200,
  recorded?: { urls: Array<string> },
): HttpClient.HttpClient =>
  HttpClient.make((request) =>
    Effect.sync(() => {
      recorded?.urls.push(request.url);
      return HttpClientResponse.fromWeb(
        request,
        new Response(encodeJsonText(body), {
          status,
          headers: { "content-type": "application/json" },
        }),
      );
    }),
  );

const issue = (identifier: string, status: string | null, error: string | null = null) => ({
  identifier,
  url: status === null ? null : `https://linear.app/beknown/issue/${identifier}`,
  status,
  statusType: status === null ? null : "started",
  updatedAt: status === null ? null : "2026-09-16T00:00:00.000Z",
  error,
});

describe("LinearStatusBridge", () => {
  it.effect("returns what the bridge knows, keyed by identifier", () =>
    Effect.gen(function* () {
      const recorded = { urls: [] as Array<string> };
      const bridge = makeLinearStatusBridge({
        httpClient: answering({ issues: [issue("TEC-1295", "Done")] }, 200, recorded),
        token: "service-token",
        baseUrl: "https://bridge.test",
      });

      const known = yield* bridge.lookup(["TEC-1295"]);

      expect(known.get("TEC-1295")?.status).toBe("Done");
      expect(recorded.urls[0]).toBe("https://bridge.test/api/v1/issues?identifiers=TEC-1295");
    }),
  );

  it.effect("treats a status-less entry as 'never seen', not as an answer", () =>
    Effect.gen(function* () {
      const bridge = makeLinearStatusBridge({
        httpClient: answering({ issues: [issue("TEC-9999", null)] }),
        token: "service-token",
      });

      // Recording it would pin an empty row and suppress the Bifrost fallback.
      expect((yield* bridge.lookup(["TEC-9999"])).has("TEC-9999")).toBe(false);
    }),
  );

  it.effect("keeps an errored entry, which is the bridge saying something went wrong", () =>
    Effect.gen(function* () {
      const bridge = makeLinearStatusBridge({
        httpClient: answering({ issues: [issue("TEC-1", null, "projection rebuilding")] }),
        token: "service-token",
      });

      expect((yield* bridge.lookup(["TEC-1"])).get("TEC-1")?.error).toBe("projection rebuilding");
    }),
  );

  it.effect("falls through quietly when the bridge refuses the token", () =>
    Effect.gen(function* () {
      const bridge = makeLinearStatusBridge({
        httpClient: answering({ error: "unauthorized" }, 401),
        token: "wrong-token",
      });

      // An empty map sends every identifier to the fallback rather than failing.
      expect((yield* bridge.lookup(["TEC-1"])).size).toBe(0);
    }),
  );

  it.effect("falls through quietly when the bridge is unreachable", () =>
    Effect.gen(function* () {
      const bridge = makeLinearStatusBridge({
        httpClient: HttpClient.make(() => Effect.die(new Error("connection refused"))),
        token: "service-token",
      });

      expect((yield* bridge.lookup(["TEC-1"])).size).toBe(0);
    }),
  );

  it.effect("asks for nothing when there is nothing to ask about", () =>
    Effect.gen(function* () {
      const recorded = { urls: [] as Array<string> };
      const bridge = makeLinearStatusBridge({
        httpClient: answering({ issues: [] }, 200, recorded),
        token: "service-token",
      });

      expect((yield* bridge.lookup([])).size).toBe(0);
      expect(recorded.urls).toEqual([]);
    }),
  );
});
