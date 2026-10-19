// T3-CUSTOM(expbkt3): bkt3 analytics identity, allowlist and key gating (TEC-1631).
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { EnvironmentUserId } from "@t3tools/contracts";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as ConfigProvider from "effect/ConfigProvider";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

import * as ServerConfig from "../config.ts";
import * as EnvironmentUsers from "../persistence/EnvironmentUsers.ts";
import { getTelemetryIdentifier } from "./Identify.ts";
import * as AnalyticsService from "./AnalyticsService.ts";

interface SentEvent {
  readonly uuid: string;
  readonly event: string;
  readonly distinct_id: string;
  readonly timestamp: string;
  readonly properties: Readonly<Record<string, unknown>>;
}

const ALICE = EnvironmentUserId.make("user_clerk_alice");
const BOB_WITHOUT_EMAIL = EnvironmentUserId.make("user_clerk_bob");

const users: ReadonlyArray<EnvironmentUsers.EnvironmentUserRecord> = [
  {
    userId: ALICE,
    displayName: "Alice Example",
    primaryEmail: " Alice@Example.com ",
    avatarUrl: null,
    role: "admin",
    status: "active",
    firstSeenAt: DateTime.makeUnsafe(0),
    lastSeenAt: DateTime.makeUnsafe(0),
  },
  {
    userId: BOB_WITHOUT_EMAIL,
    displayName: "Bob",
    primaryEmail: null,
    avatarUrl: null,
    role: "member",
    status: "active",
    firstSeenAt: DateTime.makeUnsafe(0),
    lastSeenAt: DateTime.makeUnsafe(0),
  },
];

const fakeUsers = EnvironmentUsers.EnvironmentUserRepository.of({
  upsert: () => Effect.void,
  get: () => Effect.succeed(Option.none()),
  update: () => Effect.succeed(false),
  list: Effect.succeed(users),
});

/** Runs `body` against a local batch endpoint and returns every event it received. */
const captureEvents = <A>(
  env: Record<string, unknown>,
  body: (analytics: AnalyticsService.AnalyticsService["Service"]) => Effect.Effect<A>,
) =>
  Effect.gen(function* () {
    const sent: Array<SentEvent> = [];
    let requests = 0;
    let installId: string | null = null;
    const layerBatchServer = HttpServer.serve(
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        requests += 1;
        const payload = yield* request.json.pipe(Effect.orElseSucceed(() => null));
        const batch = (payload as { readonly batch?: ReadonlyArray<SentEvent> } | null)?.batch;
        if (Array.isArray(batch)) sent.push(...batch);
        return HttpServerResponse.jsonUnsafe({});
      }),
    );
    const layerRuntime = AnalyticsService.layer.pipe(
      Layer.provideMerge(
        ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "t3-telemetry-identity-" }),
      ),
      Layer.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({ T3CODE_POSTHOG_HOST: "http://localhost", ...env }),
        ),
      ),
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(HostProcessPlatform, "linux"),
          Layer.succeed(HostProcessArchitecture, "arm64"),
        ),
      ),
      Layer.provideMerge(NodeHttpServer.layerTest),
    );
    yield* Effect.gen(function* () {
      yield* Layer.launch(layerBatchServer).pipe(Effect.forkScoped);
      const analytics = yield* AnalyticsService.AnalyticsService;
      installId = yield* getTelemetryIdentifier;
      yield* body(analytics);
      yield* analytics.flush;
    }).pipe(Effect.provide(layerRuntime));
    return { sent, requests: () => requests, installId: () => installId };
  });

it.layer(NodeServices.layer)("AnalyticsService bkt3 identity", (it) => {
  it.effect("sends nothing when no PostHog key is set, even with telemetry enabled", () =>
    Effect.gen(function* () {
      const { sent, requests } = yield* captureEvents(
        { T3CODE_TELEMETRY_ENABLED: true },
        (analytics) => analytics.record("test.no_key", { count: 1 }),
      );
      assert.deepEqual(sent, []);
      assert.equal(requests(), 0);
    }),
  );

  it.effect("keeps the two-argument record call and drops keys outside the allowlist", () =>
    Effect.gen(function* () {
      const { sent, installId } = yield* captureEvents(
        { T3CODE_TELEMETRY_ENABLED: true, T3CODE_POSTHOG_KEY: "phc_test_key" },
        (analytics) =>
          analytics.record("test.allowlist", {
            count: 2,
            threadId: "thread-1",
            title: "secret session title",
            prompt: "secret prompt",
            cwd: "/home/someone/repo",
          }),
      );
      const event = sent.find((entry) => entry.event === "test.allowlist");
      assert.isDefined(event);
      assert.equal(event?.properties.count, 2);
      assert.equal(event?.properties.threadId, "thread-1");
      assert.isUndefined(event?.properties.title);
      assert.isUndefined(event?.properties.prompt);
      assert.isUndefined(event?.properties.cwd);
      // No user: the install id, and no person profile.
      assert.equal(event?.distinct_id, installId());
      assert.equal(event?.properties.$process_person_profile, false);
      assert.deepEqual(event?.properties.$groups, { instance: "unknown" });
      assert.equal(event?.properties.instance, "unknown");
    }),
  );

  it.effect("sends a known user's events as their email and identifies them once", () =>
    Effect.gen(function* () {
      const { sent } = yield* captureEvents(
        { T3CODE_TELEMETRY_ENABLED: true, T3CODE_POSTHOG_KEY: "phc_test_key" },
        (analytics) =>
          Effect.gen(function* () {
            yield* analytics.record("test.user", { count: 1 }, { userId: ALICE });
            yield* analytics.record("test.user", { count: 2 }, { userId: ALICE });
            yield* analytics.record("test.user", { count: 3 }, { userId: BOB_WITHOUT_EMAIL });
            yield* analytics.record("test.user", { count: 4 }, { userId: "user_unknown" });
          }).pipe(Effect.provideService(EnvironmentUsers.EnvironmentUserRepository, fakeUsers)),
      );

      const identifies = sent.filter((entry) => entry.event === "$identify");
      assert.equal(identifies.length, 1, "one $identify per user per process");
      assert.equal(identifies[0]?.distinct_id, "alice@example.com");
      assert.deepEqual(identifies[0]?.properties.$set, {
        email: "alice@example.com",
        role: "admin",
        name: "Alice Example",
      });

      const byCount = new Map(
        sent
          .filter((entry) => entry.event === "test.user")
          .map((entry) => [entry.properties.count, entry] as const),
      );
      for (const count of [1, 2]) {
        assert.equal(byCount.get(count)?.distinct_id, "alice@example.com");
        assert.equal(byCount.get(count)?.properties.$process_person_profile, true);
      }
      // A user without an email, and an unknown user, stay anonymous.
      for (const count of [3, 4]) {
        assert.notEqual(byCount.get(count)?.distinct_id, "alice@example.com");
        assert.equal(byCount.get(count)?.properties.$process_person_profile, false);
      }
    }),
  );

  it.effect("stays anonymous when the caller has no user repository", () =>
    Effect.gen(function* () {
      const { sent } = yield* captureEvents(
        { T3CODE_TELEMETRY_ENABLED: true, T3CODE_POSTHOG_KEY: "phc_test_key" },
        (analytics) => analytics.record("test.no_repo", { count: 1 }, { userId: ALICE }),
      );
      assert.equal(sent.filter((entry) => entry.event === "$identify").length, 0);
      const event = sent.find((entry) => entry.event === "test.no_repo");
      assert.equal(event?.properties.$process_person_profile, false);
    }),
  );

  it.effect("maps an insert id to a stable uuid and keeps the caller's timestamp", () =>
    Effect.gen(function* () {
      const timestamp = "2026-10-01T10:00:00.000Z";
      const { sent } = yield* captureEvents(
        { T3CODE_TELEMETRY_ENABLED: true, T3CODE_POSTHOG_KEY: "phc_test_key" },
        (analytics) =>
          Effect.gen(function* () {
            const options = { insertId: "run-1", timestamp };
            yield* analytics.record("test.backfill", { count: 1 }, options);
            yield* analytics.record("test.backfill", { count: 2 }, options);
            yield* analytics.record("test.backfill", { count: 3 }, { insertId: "run-2" });
          }),
      );
      const events = sent.filter((entry) => entry.event === "test.backfill");
      assert.equal(events.length, 3);
      assert.equal(events[0]?.uuid, events[1]?.uuid);
      assert.notEqual(events[0]?.uuid, events[2]?.uuid);
      assert.match(
        events[0]?.uuid ?? "",
        /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      assert.equal(events[0]?.timestamp, timestamp);
      assert.equal(events[0]?.properties.$insert_id, "run-1");
    }),
  );

  it.effect("names the instance group and identifies it once per boot", () =>
    Effect.gen(function* () {
      const { sent } = yield* captureEvents(
        {
          T3CODE_TELEMETRY_ENABLED: true,
          T3CODE_POSTHOG_KEY: "phc_test_key",
          T3CODE_ANALYTICS_INSTANCE: "bkt3",
        },
        (analytics) => analytics.record("test.instance", { count: 1 }),
      );
      const groups = sent.filter((entry) => entry.event === "$groupidentify");
      assert.equal(groups.length, 1);
      assert.equal(groups[0]?.properties.$group_type, "instance");
      assert.equal(groups[0]?.properties.$group_key, "bkt3");
      const event = sent.find((entry) => entry.event === "test.instance");
      assert.deepEqual(event?.properties.$groups, { instance: "bkt3" });
      assert.equal(event?.properties.instance, "bkt3");
    }),
  );
});
