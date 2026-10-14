// T3-CUSTOM(expbkt3): bkt3 server analytics helpers (TEC-1631).
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  ALLOWED_ANALYTICS_PROPERTY_KEYS,
  FORBIDDEN_ANALYTICS_PROPERTY_KEYS,
  filterAnalyticsProperties,
} from "./analyticsProperties.ts";
import { uuidFromSha256Hex } from "./analyticsIdentity.ts";
import * as AnalyticsService from "./AnalyticsService.ts";
import {
  clientConnectionMode,
  recordLinearLinked,
  webhookStatusFromHttp,
  withMcpToolAnalytics,
} from "./serverEvents.ts";

interface Recorded {
  readonly event: string;
  readonly properties: Readonly<Record<string, unknown>> | undefined;
  readonly options: AnalyticsService.AnalyticsRecordOptions | undefined;
}

const recordingAnalytics = (recorded: Array<Recorded>) =>
  AnalyticsService.AnalyticsService.of({
    record: (event, properties, options) =>
      Effect.sync(() => {
        recorded.push({ event, properties, options });
      }),
    flush: Effect.void,
  });

class ToolBroke extends Schema.TaggedError<ToolBroke>()("ToolBroke", {
  detail: Schema.String,
}) {}

it("never allows a free-text key", () => {
  for (const key of FORBIDDEN_ANALYTICS_PROPERTY_KEYS) {
    assert.isFalse(ALLOWED_ANALYTICS_PROPERTY_KEYS.has(key), key);
  }
});

it("allows the session-activity keys other recorders depend on", () => {
  for (const key of ["threadId", "waitKind", "durationMs", "snoozed", "ownerUserId"]) {
    assert.isTrue(ALLOWED_ANALYTICS_PROPERTY_KEYS.has(key), key);
  }
});

it("splits properties into kept values and dropped key names", () => {
  const { kept, dropped } = filterAnalyticsProperties({
    threadId: "t-1",
    title: "a title",
    message: "hello",
  });
  assert.deepEqual(kept, { threadId: "t-1" });
  assert.deepEqual([...dropped].toSorted(), ["message", "title"]);
});

it("derives a version 8 uuid from a sha-256 hex digest", () => {
  const hex = "ab".repeat(32);
  assert.equal(uuidFromSha256Hex(hex), "abababab-abab-8bab-abab-abababababab");
  assert.equal(uuidFromSha256Hex(hex), uuidFromSha256Hex(hex.toUpperCase()));
});

it("classifies how a client reached the server", () => {
  assert.equal(clientConnectionMode({ connectionMethod: "relay", host: "localhost" }), "relay");
  assert.equal(clientConnectionMode({ host: "localhost:3773" }), "local");
  assert.equal(clientConnectionMode({ host: "127.0.0.1:3773" }), "local");
  assert.equal(clientConnectionMode({ host: "[::1]:3773" }), "local");
  assert.equal(clientConnectionMode({ host: "dev-server-1.tailab6257.ts.net" }), "tailnet");
  assert.equal(clientConnectionMode({ host: "100.101.102.103:18087" }), "tailnet");
  assert.equal(clientConnectionMode({ host: "bkt3.dev.beknown.live" }), "remote");
  assert.equal(clientConnectionMode({}), "remote");
});

it("names a session-webhook answer by its status", () => {
  assert.equal(webhookStatusFromHttp(202), "accepted");
  assert.equal(webhookStatusFromHttp(413), "http_413");
});

it.effect("records an MCP tool call by name and outcome, never its arguments", () =>
  Effect.gen(function* () {
    const recorded: Array<Recorded> = [];
    const caller = Effect.succeed({
      principal: "provider-session" as const,
      actorUserId: "user_clerk_alice",
    });
    yield* withMcpToolAnalytics("t3_send_prompt", caller, Effect.succeed("ok"));
    const failed = yield* withMcpToolAnalytics(
      "t3_send_prompt",
      caller,
      Effect.fail(new ToolBroke({ detail: "secret detail" })),
    ).pipe(Effect.flip);
    assert.equal(failed._tag, "ToolBroke");

    assert.equal(recorded.length, 0, "nothing is recorded without analytics in context");
    yield* withMcpToolAnalytics("t3_inbox", caller, Effect.void).pipe(
      Effect.provideService(AnalyticsService.AnalyticsService, recordingAnalytics(recorded)),
    );
    yield* withMcpToolAnalytics(
      "t3_inbox",
      Effect.succeed(undefined),
      Effect.fail(new ToolBroke({ detail: "secret detail" })),
    ).pipe(
      Effect.ignore,
      Effect.provideService(AnalyticsService.AnalyticsService, recordingAnalytics(recorded)),
    );

    assert.equal(recorded.length, 2);
    assert.equal(recorded[0]?.event, "mcp.tool.called");
    assert.equal(recorded[0]?.properties?.toolName, "t3_inbox");
    assert.equal(recorded[0]?.properties?.callerKind, "agent");
    assert.equal(recorded[0]?.properties?.ok, true);
    assert.deepEqual(recorded[0]?.options, { userId: "user_clerk_alice" });
    assert.equal(recorded[1]?.properties?.ok, false);
    assert.equal(recorded[1]?.properties?.callerKind, "unknown");
    assert.equal(recorded[1]?.properties?.errorClass, "ToolBroke");
    assert.isUndefined(recorded[1]?.options);
    assert.notInclude(JSON.stringify(recorded), "secret detail");
  }),
);

it.effect("records linked Linear items as a count only", () =>
  Effect.gen(function* () {
    const recorded: Array<Recorded> = [];
    const provide = Effect.provideService(
      AnalyticsService.AnalyticsService,
      recordingAnalytics(recorded),
    );
    yield* recordLinearLinked({ threadId: "thread-1", count: 0, userId: null }).pipe(provide);
    yield* recordLinearLinked({ threadId: "thread-1", count: 2, userId: "user-1" }).pipe(provide);
    assert.deepEqual(recorded, [
      {
        event: "linear.linked",
        properties: { threadId: "thread-1", count: 2 },
        options: { userId: "user-1" },
      },
    ]);
  }),
);
