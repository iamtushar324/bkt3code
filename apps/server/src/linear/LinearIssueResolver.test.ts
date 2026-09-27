// T3-CUSTOM(expbkt3): Bifrost result parsing coverage without network access.
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { BIFROST_MCP_INTEGRATION_ID, UserId } from "@t3tools/contracts";
import type { HttpClient } from "effect/unstable/http";

import { parseLinearToolResult, resolveLinearIssueStatuses } from "./LinearIssueResolver.ts";
import { makeLinearIssueStatusCache } from "./LinearIssueStatusCache.ts";
import type { LinearStatusBridge } from "./LinearStatusBridge.ts";

it.effect("parses only the reduced Linear return value", () =>
  Effect.gen(function* () {
    const issue = yield* parseLinearToolResult(
      'Print output: [TOOL] omitted\nReturn value: {"id":"TEC-811","status":"Today\'s ToDo","statusType":"unstarted","url":"https://linear.app/beknown/issue/TEC-811","updatedAt":"2026-08-03T10:00:00.000Z"}\n\nEnvironment: code mode',
    );
    expect(issue).toEqual({
      id: "TEC-811",
      status: "Today's ToDo",
      statusType: "unstarted",
      url: "https://linear.app/beknown/issue/TEC-811",
      updatedAt: "2026-08-03T10:00:00.000Z",
    });
  }),
);

it.effect("rejects a response without a reduced return value", () =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(parseLinearToolResult("Print output only"));
    expect(exit._tag).toBe("Failure");
  }),
);

// T3-CUSTOM(expbkt3): BEGIN — the cache seam in front of Bifrost.
const userId = UserId.make("user-cache-test");

/** A credentialed profile, so the resolver reaches the fetch path at all. */
const profiles = {
  get: () =>
    Effect.succeed({
      integrations: [{ id: BIFROST_MCP_INTEGRATION_ID, enabled: true, credentialConfigured: true }],
    }),
  getIntegrationCredential: () => Effect.succeed("virtual-key"),
} as unknown as Parameters<typeof resolveLinearIssueStatuses>[0]["profiles"];

/** Any outbound read is a failure of the thing under test. */
const forbiddenHttpClient = {
  execute: () => Effect.die(new Error("the resolver went to Bifrost for a cached issue")),
} as unknown as HttpClient.HttpClient;

it.effect("serves a warm identifier without going to Bifrost", () =>
  Effect.gen(function* () {
    const cache = yield* makeLinearIssueStatusCache();
    yield* cache.resolve(["TEC-811"], (missing) =>
      Effect.succeed(
        missing.map((identifier) => ({
          identifier,
          url: "https://linear.app/beknown/issue/TEC-811",
          status: "Implementing",
          statusType: "started",
          updatedAt: "2026-09-16T00:00:00.000Z",
          error: null,
        })),
      ),
    );

    const result = yield* resolveLinearIssueStatuses({
      userId,
      identifiers: ["TEC-811"],
      profiles,
      httpClient: forbiddenHttpClient,
      cache,
    });

    expect(result.issues).toEqual([
      {
        identifier: "TEC-811",
        url: "https://linear.app/beknown/issue/TEC-811",
        status: "Implementing",
        statusType: "started",
        updatedAt: "2026-09-16T00:00:00.000Z",
        error: null,
      },
    ]);
  }),
);

it.effect("still rejects a malformed identifier before any cache lookup", () =>
  Effect.gen(function* () {
    const cache = yield* makeLinearIssueStatusCache();
    const result = yield* resolveLinearIssueStatuses({
      userId,
      identifiers: ["not-an-identifier"],
      profiles,
      httpClient: forbiddenHttpClient,
      cache,
    });

    expect(result.issues[0]?.error).toBe("Invalid Linear issue identifier.");
  }),
);
// T3-CUSTOM(expbkt3): END

// T3-CUSTOM(expbkt3): BEGIN — bridge-first precedence.
const bridgeKnowing = (
  known: Record<string, string>,
  seen?: { identifiers: Array<ReadonlyArray<string>> },
): LinearStatusBridge => ({
  lookup: (identifiers) =>
    Effect.sync(() => {
      seen?.identifiers.push(identifiers);
      return new Map(
        Object.entries(known)
          .filter(([identifier]) => identifiers.includes(identifier))
          .map(([identifier, status]) => [
            identifier,
            {
              identifier,
              url: `https://linear.app/beknown/issue/${identifier}`,
              status,
              statusType: "started",
              updatedAt: "2026-09-16T00:00:00.000Z",
              error: null,
            },
          ]),
      );
    }),
});

/** A profile with no Bifrost integration at all — the case that read "unavailable". */
const profilesWithoutBifrost = {
  get: () => Effect.succeed({ integrations: [] }),
  getIntegrationCredential: () => Effect.die(new Error("no credential exists")),
} as unknown as Parameters<typeof resolveLinearIssueStatuses>[0]["profiles"];

it.effect("answers a viewer with no Bifrost credential from the bridge", () =>
  Effect.gen(function* () {
    const result = yield* resolveLinearIssueStatuses({
      userId,
      identifiers: ["TEC-1295"],
      profiles: profilesWithoutBifrost,
      httpClient: forbiddenHttpClient,
      bridge: bridgeKnowing({ "TEC-1295": "Done" }),
    });

    // Previously this viewer saw "unavailable" on every row.
    expect(result.issues[0]?.status).toBe("Done");
    expect(result.issues[0]?.error).toBeNull();
  }),
);

it.effect("does not ask Bifrost for an issue the bridge already answered", () =>
  Effect.gen(function* () {
    const result = yield* resolveLinearIssueStatuses({
      userId,
      identifiers: ["TEC-1295"],
      profiles,
      // A credentialed viewer still must not trigger a Bifrost read.
      httpClient: forbiddenHttpClient,
      bridge: bridgeKnowing({ "TEC-1295": "Done" }),
    });

    expect(result.issues[0]?.status).toBe("Done");
  }),
);

it.effect("falls back to Bifrost only for identifiers the bridge has not seen", () =>
  Effect.gen(function* () {
    const seen = { identifiers: [] as Array<ReadonlyArray<string>> };
    const result = yield* resolveLinearIssueStatuses({
      userId,
      identifiers: ["TEC-1295", "TEC-9999"],
      profiles,
      // No credential path is exercised because this viewer has one, but the
      // stub http client dies, so the unknown identifier degrades rather than
      // resolving — which is exactly the fallback being attempted.
      httpClient: forbiddenHttpClient,
      bridge: bridgeKnowing({ "TEC-1295": "Done" }, seen),
    });

    expect(seen.identifiers).toEqual([["TEC-1295", "TEC-9999"]]);
    expect(result.issues.find((i) => i.identifier === "TEC-1295")?.status).toBe("Done");
    expect(result.issues.find((i) => i.identifier === "TEC-9999")?.error).not.toBeNull();
  }),
);

it.effect("tells an uncredentialed viewer what to fix when no bridge is configured", () =>
  Effect.gen(function* () {
    const result = yield* resolveLinearIssueStatuses({
      userId,
      identifiers: ["TEC-1295"],
      profiles: profilesWithoutBifrost,
      httpClient: forbiddenHttpClient,
    });

    expect(result.issues[0]?.error).toBe("Configure and enable Bifrost to read Linear status.");
  }),
);
// T3-CUSTOM(expbkt3): END
