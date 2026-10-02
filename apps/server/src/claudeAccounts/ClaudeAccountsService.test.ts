/**
 * T3-CUSTOM(expbkt3): placement, pinning, restarts and the hard-limit path for
 * Claude account profiles per thread, against a fake host switcher, a fed
 * provider event bus and real profile directories under a temp root.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  type ClaudeAccountsSnapshot,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationSession,
  type OrchestrationThreadShell,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ServerSettings,
  type ThreadClaudeAccount,
  ThreadId,
  UserId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { MigrationsLive } from "../persistence/Migrations.ts";
import * as ThreadClaudeAccountRepo from "../persistence/ThreadClaudeAccount.ts";
import { ProviderAdapterValidationError } from "../provider/Errors.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  applyClaudeAccountProfile,
  ClaudeAccountPolicyError,
} from "./applyClaudeAccountProfile.ts";
import {
  type ClaudeAutoswitchClientShape,
  ClaudeAutoswitchClient,
  type SwitcherPlaceResult,
  type SwitcherProfile,
  type SwitcherStatus,
} from "./ClaudeAutoswitchClient.ts";
import * as ClaudeAccountsServiceLayer from "./ClaudeAccountsService.ts";
import { ClaudeAccountsService, LOADING_REASON } from "./ClaudeAccountsService.ts";

const owner = UserId.make("user-owner");

type DirFor = (name: string) => string;

function switcherProfile(
  dir: DirFor,
  name: string,
  overrides: Partial<SwitcherProfile> = {},
): SwitcherProfile {
  return {
    name,
    dir: dir(name),
    rank: 1,
    in_rotation: true,
    excluded: false,
    elected: name === "tushar",
    eligible: true,
    why: "",
    auth: { state: "ok", detail: "" },
    email_masked: `${name[0]}***@example.com`,
    five_hour: { used: 20, resets_at: "2026-10-02T12:00:00Z" },
    weekly: { used: 40, resets_at: "2026-10-05T00:00:00Z" },
    scoped: null,
    binding_left: 60,
    headroom_per_day: 10,
    age_sec: 5,
    sessions: 0,
    ...overrides,
  };
}

function switcherStatus(profiles: ReadonlyArray<SwitcherProfile>): SwitcherStatus {
  return {
    schema: "claude-autoswitch.status/1",
    generated_ms: 1_000,
    elected: "tushar",
    rank_order: profiles.map((profile) => profile.name),
    place_spread: 1,
    profiles,
  };
}

const defaultStatus = (dir: DirFor) =>
  switcherStatus([
    switcherProfile(dir, "tushar"),
    switcherProfile(dir, "agent", { rank: 2, elected: false }),
    switcherProfile(dir, "barsha", { rank: 3, elected: false }),
    switcherProfile(dir, "sam", {
      rank: 4,
      elected: false,
      auth: { state: "logged_out", detail: "" },
    }),
  ]);

type PlaceInput = {
  readonly pending: Readonly<Record<string, number>>;
  readonly avoid: ReadonlyArray<string>;
};

/** Spread rule: the eligible account with the fewest pending placements, ties by rank order. */
function spreadPlace(status: SwitcherStatus) {
  return (input: PlaceInput): SwitcherPlaceResult => {
    const candidates = status.profiles.filter(
      (profile) =>
        profile.eligible === true &&
        profile.auth?.state !== "logged_out" &&
        !input.avoid.includes(profile.name),
    );
    let chosen: SwitcherProfile | undefined;
    for (const candidate of candidates) {
      const pending = input.pending[candidate.name] ?? 0;
      if (chosen === undefined || pending < (input.pending[chosen.name] ?? 0)) chosen = candidate;
    }
    if (chosen === undefined) {
      return {
        status: "no_eligible_profile",
        chosen: null,
        dir: null,
        reason: "every profile is over its limit",
        recovers_at: "2026-10-02T14:30:00Z",
      };
    }
    return {
      status: "placed",
      chosen: chosen.name,
      dir: chosen.dir ?? null,
      reason: "fewest sessions",
    };
  };
}

interface HarnessOptions {
  readonly enabled?: boolean;
  readonly status?: (dir: DirFor) => SwitcherStatus;
  readonly place?: (input: PlaceInput) => SwitcherPlaceResult;
  readonly statusUnavailable?: boolean;
  readonly placeUnavailable?: boolean;
}

const settingsFor = (isEnabled: boolean) =>
  ({
    experimental: {
      claudeAccountProfiles: { enabled: isEnabled, autoswitchPath: "", shortLabels: {} },
    },
  }) as unknown as ServerSettings;

const makeHarness = (options: HarnessOptions = {}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "claude-accounts-test-" });
    const dir: DirFor = (name) => `${root}/profiles/${name}`;
    const status = (options.status ?? defaultStatus)(dir);
    for (const profile of status.profiles) {
      yield* fs.makeDirectory(dir(profile.name), { recursive: true });
    }
    /** What the next `--status` answers; tests may shrink it to retire an account. */
    const statusRef = yield* Ref.make(status);

    const placeCalls: Array<{ pending: Record<string, number>; avoid: ReadonlyArray<string> }> = [];
    const hardLimitCalls: Array<{ type: string; profile: string }> = [];
    const stoppedThreads: Array<ThreadId> = [];
    const dispatched: Array<{ command: OrchestrationCommand; actorUserId: unknown }> = [];
    const place = options.place ?? spreadPlace(status);
    const enabled = yield* Ref.make(options.enabled ?? true);
    const sessions = yield* Ref.make<ReadonlyArray<ProviderSession>>([]);
    const shellSession = yield* Ref.make<OrchestrationSession | null>(null);

    // Subscriptions are taken here, before the service exists, so an event
    // published at any point after harness creation reaches the service.
    const providerEvents = yield* PubSub.unbounded<ProviderRuntimeEvent>();
    const providerSubscription = yield* PubSub.subscribe(providerEvents);
    const domainEvents = yield* PubSub.unbounded<OrchestrationEvent>();
    const domainSubscription = yield* PubSub.subscribe(domainEvents);
    const settingsChanges = yield* PubSub.unbounded<ServerSettings>();
    const settingsSubscription = yield* PubSub.subscribe(settingsChanges);

    const client: ClaudeAutoswitchClientShape = {
      status: () =>
        Ref.get(statusRef).pipe(
          Effect.map((current) =>
            options.statusUnavailable
              ? ({
                  kind: "unavailable",
                  detail: "/x/claude-autoswitch exited 2: usage: ...",
                } as const)
              : ({ kind: "ok", value: current } as const),
          ),
        ),
      place: (input) =>
        Effect.sync(() => {
          placeCalls.push({ pending: { ...input.pending }, avoid: input.avoid });
          if (options.placeUnavailable) {
            return { kind: "unavailable", detail: "old switcher" } as const;
          }
          return { kind: "ok", value: place(input) } as const;
        }),
      hardLimit: (input) =>
        Effect.sync(() => {
          hardLimitCalls.push(input);
          return { kind: "ok", value: { status: "no-op", reason: "not_elected" } } as const;
        }),
    };

    const shell = Ref.get(shellSession).pipe(
      Effect.map(
        (session) =>
          ({
            ownerUserId: owner,
            modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" },
            runtimeMode: "full-access",
            interactionMode: "default",
            session,
          }) as unknown as OrchestrationThreadShell,
      ),
    );

    const layer = ClaudeAccountsServiceLayer.layer.pipe(
      Layer.provide(ThreadClaudeAccountRepo.layer),
      Layer.provide(MigrationsLive),
      Layer.provide(SqlitePersistenceMemory),
      Layer.provide(Layer.succeed(ClaudeAutoswitchClient, client)),
      Layer.provide(
        Layer.mock(ServerSettingsService)({
          getSettings: Ref.get(enabled).pipe(Effect.map(settingsFor)),
          streamChanges: Stream.fromSubscription(settingsSubscription),
        }),
      ),
      Layer.provide(
        Layer.mock(ProviderService)({
          stopSession: (input) =>
            Effect.sync(() => {
              stoppedThreads.push(input.threadId);
            }),
          listSessions: () => Ref.get(sessions),
          streamEvents: Stream.fromSubscription(providerSubscription),
        }),
      ),
      Layer.provide(
        Layer.mock(OrchestrationEngineService)({
          dispatch: (command, dispatchOptions) =>
            Effect.sync(() => {
              dispatched.push({ command, actorUserId: dispatchOptions?.actorUserId });
              return { sequence: dispatched.length };
            }),
          streamDomainEvents: Stream.fromSubscription(domainSubscription),
        }),
      ),
      Layer.provide(
        Layer.mock(ProjectionSnapshotQuery)({
          getThreadShellById: () => shell.pipe(Effect.map(Option.some)),
        }),
      ),
      Layer.provide(NodeServices.layer),
    );

    return {
      layer,
      dir,
      status: statusRef,
      placeCalls,
      hardLimitCalls,
      stoppedThreads,
      dispatched,
      enabled,
      sessions,
      shellSession,
      providerEvents,
      domainEvents,
      settingsChanges,
    };
  });

type Harness = Effect.Success<ReturnType<typeof makeHarness>>;

/** Builds a harness, provides the service, and runs the body inside one scope. */
const scenario = <E>(
  name: string,
  options: HarnessOptions,
  body: (
    harness: Harness,
    service: ClaudeAccountsService["Service"],
  ) => Effect.Effect<void, E, Scope.Scope | FileSystem.FileSystem>,
) =>
  it.effect(name, () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness(options);
      yield* Effect.gen(function* () {
        const service = yield* ClaudeAccountsService;
        yield* body(harness, service);
      }).pipe(Effect.provide(harness.layer));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

const liveSession = (threadId: ThreadId, status: ProviderSession["status"]): ProviderSession =>
  ({
    provider: "claudeAgent",
    status,
    runtimeMode: "full-access",
    threadId,
    createdAt: "2026-10-02T08:00:00.000Z",
    updatedAt: "2026-10-02T08:00:00.000Z",
  }) as unknown as ProviderSession;

const orchestrationSession = (
  threadId: ThreadId,
  status: OrchestrationSession["status"],
  activeTurnId: string | null,
): OrchestrationSession =>
  ({
    threadId,
    status,
    providerName: "claudeAgent",
    runtimeMode: "full-access",
    activeTurnId,
    lastError: null,
    updatedAt: "2026-10-02T08:00:00.000Z",
  }) as unknown as OrchestrationSession;

let eventCounter = 0;
const providerEvent = (
  type: "turn.started" | "turn.completed" | "turn.aborted",
  threadId: ThreadId,
): ProviderRuntimeEvent =>
  ({
    type,
    eventId: `evt-${(eventCounter += 1)}`,
    provider: "claudeAgent",
    providerInstanceId: "claudeAgent",
    threadId,
    createdAt: "2026-10-02T08:00:00.000Z",
    payload: {},
  }) as unknown as ProviderRuntimeEvent;

const rateLimitsEvent = (
  threadId: ThreadId,
  windows: ReadonlyArray<{ id: string; usedPercent: number; resetsAt?: string }>,
): ProviderRuntimeEvent =>
  ({
    type: "account.rate-limits.updated",
    eventId: `evt-${(eventCounter += 1)}`,
    provider: "claudeAgent",
    providerInstanceId: "claudeAgent",
    threadId,
    createdAt: "2026-10-02T08:00:00.000Z",
    payload: {
      limits: {
        windows: windows.map((window) => ({
          id: window.id,
          kind: window.id === "five_hour" ? "session" : "weekly",
          label: window.id,
          usedPercent: window.usedPercent,
          ...(window.resetsAt ? { resetsAt: window.resetsAt } : {}),
        })),
      },
    },
  }) as unknown as ProviderRuntimeEvent;

/** Subscribes to the thread stream and hands back its initial value plus a queue of later values. */
const watchThreadInto = (service: ClaudeAccountsService["Service"], threadId: ThreadId) =>
  Effect.gen(function* () {
    const seen = yield* Queue.unbounded<ThreadClaudeAccount>();
    yield* service.watchThread(threadId).pipe(
      Stream.runForEach((view) => Queue.offer(seen, view)),
      Effect.forkScoped,
    );
    const initial = yield* Queue.take(seen);
    return { initial, seen };
  });

const watchSnapshotInto = (service: ClaudeAccountsService["Service"]) =>
  Effect.gen(function* () {
    const seen = yield* Queue.unbounded<ClaudeAccountsSnapshot>();
    yield* service.watchSnapshot().pipe(
      Stream.runForEach((view) => Queue.offer(seen, view)),
      Effect.forkScoped,
    );
    const initial = yield* Queue.take(seen);
    return { initial, seen };
  });

/** Takes snapshots until one satisfies the predicate. */
const takeUntil = <A>(seen: Queue.Queue<A>, predicate: (value: A) => boolean) =>
  Effect.gen(function* () {
    while (true) {
      const value = yield* Queue.take(seen);
      if (predicate(value)) return value;
    }
  });

describe("ClaudeAccountsService placement", () => {
  scenario(
    "places a new Auto thread once and then sticks to that account",
    {},
    (harness, service) =>
      Effect.gen(function* () {
        yield* service.refreshStatus();
        const threadId = ThreadId.make("thread-sticky");

        const first = yield* service.resolveForSession(threadId);
        assert.equal(first?.profile, "tushar");
        assert.equal(first?.dir, harness.dir("tushar"));
        assert.equal(first?.reason, "fewest sessions");

        const second = yield* service.resolveForSession(threadId);
        assert.equal(second?.profile, "tushar");
        assert.equal(second?.reason, "sticky");
        assert.equal(harness.placeCalls.length, 1);

        const view = yield* service.getThread(threadId);
        assert.equal(view.resolvedProfile, "tushar");
        assert.deepEqual(view.mode, { kind: "auto" });
      }),
  );

  scenario(
    "spreads a burst of ten Auto placements 4/3/3 from the pending counts it reports",
    {
      status: (dir) =>
        switcherStatus([
          switcherProfile(dir, "a"),
          switcherProfile(dir, "b", { rank: 2, elected: false }),
          switcherProfile(dir, "c", { rank: 3, elected: false }),
        ]),
    },
    (harness, service) =>
      Effect.gen(function* () {
        yield* service.refreshStatus();
        const threads = Array.from({ length: 10 }, (_, index) => ThreadId.make(`burst-${index}`));
        const resolutions = yield* Effect.forEach(
          threads,
          (threadId) => service.resolveForSession(threadId),
          { concurrency: "unbounded" },
        );
        const counts: Record<string, number> = {};
        for (const resolution of resolutions) {
          counts[resolution!.profile] = (counts[resolution!.profile] ?? 0) + 1;
        }
        assert.deepEqual(counts, { a: 4, b: 3, c: 3 });
        assert.equal(harness.placeCalls.length, 10);
        assert.deepEqual(harness.placeCalls[9]!.pending, { a: 3, b: 3, c: 3 });
      }),
  );

  scenario(
    "pins a thread to the chosen account without asking the switcher",
    {},
    (harness, service) =>
      Effect.gen(function* () {
        yield* service.refreshStatus();
        // A draft thread id: no projection row exists yet and the row is stored anyway.
        const threadId = ThreadId.make("draft-thread-pin");
        const updated = yield* service.setThreadMode({
          threadId,
          mode: { kind: "profile", profile: "agent" },
        });
        assert.deepEqual(updated.mode, { kind: "profile", profile: "agent" });

        const resolution = yield* service.resolveForSession(threadId);
        assert.equal(resolution?.profile, "agent");
        assert.equal(resolution?.mode, "profile");
        assert.equal(resolution?.dir, harness.dir("agent"));
        assert.equal(harness.placeCalls.length, 0);
        assert.equal((yield* service.getThread(threadId)).resolvedProfile, "agent");
      }),
  );

  scenario("fails a start on a pinned account that is logged out", {}, (_harness, service) =>
    Effect.gen(function* () {
      yield* service.refreshStatus();
      const threadId = ThreadId.make("thread-logged-out");
      const view = yield* service.setThreadMode({
        threadId,
        mode: { kind: "profile", profile: "sam" },
      });
      assert.match(view.notice ?? "", /logged out/);
      const result = yield* service.resolveForSession(threadId).pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.instanceOf(result.failure, ClaudeAccountPolicyError);
        assert.equal(
          result.failure.detail,
          "Claude account sam is logged out — sign it in on the Claude Accounts page or switch this thread to Auto.",
        );
      }
    }),
  );

  scenario("rejects a pin to an account the switcher does not list", {}, (_harness, service) =>
    Effect.gen(function* () {
      yield* service.refreshStatus();
      const result = yield* service
        .setThreadMode({
          threadId: ThreadId.make("thread-unknown-pin"),
          mode: { kind: "profile", profile: "nobody" },
        })
        .pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") assert.equal(result.failure.reason, "invalid");
    }),
  );

  scenario(
    "rejects a pin to an account without a directory even before the switcher has answered",
    {},
    (_harness, service) =>
      Effect.gen(function* () {
        // No snapshot yet, so the name maps to ~/.claude-profiles/<name>, which
        // does not exist for this one.
        const missing = yield* service
          .setThreadMode({
            threadId: ThreadId.make("thread-no-dir-pin"),
            mode: { kind: "profile", profile: "no-such-claude-profile-for-test" },
          })
          .pipe(Effect.result);
        assert.equal(missing._tag, "Failure");
        if (missing._tag === "Failure") assert.equal(missing.failure.reason, "invalid");
      }),
  );

  scenario(
    "fails a pinned start, and re-places a sticky Auto thread, when the account is gone",
    {},
    (harness, service) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* service.refreshStatus();
        const pinnedThread = ThreadId.make("thread-pinned-stale");
        const autoThread = ThreadId.make("thread-auto-stale");
        yield* service.setThreadMode({
          threadId: pinnedThread,
          mode: { kind: "profile", profile: "tushar" },
        });
        assert.equal((yield* service.resolveForSession(pinnedThread))?.profile, "tushar");
        assert.equal((yield* service.resolveForSession(autoThread))?.profile, "tushar");

        // The account's directory disappears from the host.
        yield* fs.remove(harness.dir("tushar"), { recursive: true });

        const pinned = yield* service.resolveForSession(pinnedThread).pipe(Effect.result);
        assert.equal(pinned._tag, "Failure");
        if (pinned._tag === "Failure") {
          assert.equal(
            pinned.failure.detail,
            "Claude account tushar no longer exists — switch this thread to Auto or another account.",
          );
        }
        const moved = yield* service.resolveForSession(autoThread);
        assert.equal(moved?.profile, "agent");
        assert.include(harness.placeCalls.at(-1)!.avoid, "tushar");
      }),
  );

  scenario(
    "fails a pinned start on an account the switcher no longer lists, directory or not",
    {},
    (harness, service) =>
      Effect.gen(function* () {
        yield* service.refreshStatus();
        const threadId = ThreadId.make("thread-unlisted-pin");
        yield* service.setThreadMode({ threadId, mode: { kind: "profile", profile: "barsha" } });
        assert.equal((yield* service.resolveForSession(threadId))?.profile, "barsha");

        // The operator deletes the profile; the switcher stops listing it while
        // its directory is still there.
        yield* Ref.update(harness.status, (current) => ({
          ...current,
          profiles: current.profiles.filter((profile) => profile.name !== "barsha"),
        }));
        yield* service.refreshStatus();
        const result = yield* service.resolveForSession(threadId).pipe(Effect.result);
        assert.equal(result._tag, "Failure");
        if (result._tag === "Failure") {
          assert.equal(
            result.failure.detail,
            "Claude account barsha no longer exists — switch this thread to Auto or another account.",
          );
        }
      }),
  );

  scenario(
    "re-places a thread whose account was marked exhausted and tells the switcher to avoid it",
    {},
    (harness, service) =>
      Effect.gen(function* () {
        yield* service.refreshStatus();
        const threadId = ThreadId.make("thread-exhausted");
        const first = yield* service.resolveForSession(threadId);
        assert.equal(first?.profile, "tushar");

        yield* service.markExhausted("tushar", "2026-10-02T12:00:00.000Z");
        const moved = yield* service.reassign(threadId, { avoid: ["tushar"] });
        assert.equal(moved?.profile, "agent");
        assert.include(harness.placeCalls[1]!.avoid, "tushar");

        const other = ThreadId.make("thread-exhausted-other");
        yield* service.setThreadMode({ threadId: other, mode: { kind: "auto" } });
        const otherResolution = yield* service.resolveForSession(other);
        assert.notEqual(otherResolution?.profile, "tushar");
        assert.include(harness.placeCalls[2]!.avoid, "tushar");

        const snapshot = yield* service.snapshot();
        const tushar = snapshot.profiles.find((profile) => profile.name === "tushar");
        assert.equal(tushar?.eligible, false);
        assert.match(tushar?.why ?? "", /until 12:00 UTC/);
      }),
  );

  scenario(
    "fails a start when no account has headroom, naming the first reset",
    {
      place: () => ({
        status: "no_eligible_profile",
        chosen: null,
        dir: null,
        reason: "all over limit",
        recovers_at: "2026-10-02T14:30:00Z",
      }),
    },
    (_harness, service) =>
      Effect.gen(function* () {
        yield* service.refreshStatus();
        const result = yield* service
          .resolveForSession(ThreadId.make("thread-no-eligible"))
          .pipe(Effect.result);
        assert.equal(result._tag, "Failure");
        if (result._tag === "Failure") {
          assert.equal(
            result.failure.detail,
            "All Claude accounts are at their limit — first resets at 14:30 UTC.",
          );
        }
      }),
  );

  scenario(
    "leaves the environment alone while the feature is off",
    { enabled: false },
    (harness, service) =>
      Effect.gen(function* () {
        const resolution = yield* service.resolveForSession(ThreadId.make("thread-off"));
        assert.equal(resolution, undefined);
        assert.equal(harness.placeCalls.length, 0);
        const snapshot = yield* service.snapshot();
        assert.deepEqual(
          { enabled: snapshot.enabled, available: snapshot.available, profiles: snapshot.profiles },
          { enabled: false, available: false, profiles: [] },
        );
      }),
  );

  scenario("reports a loading snapshot until the first poll answers", {}, (_harness, service) =>
    Effect.gen(function* () {
      const before = yield* service.snapshot();
      assert.equal(before.enabled, true);
      assert.equal(before.available, true);
      assert.equal(before.unavailableReason, LOADING_REASON);
      assert.deepEqual(before.profiles, []);
      yield* service.refreshStatus();
      const after = yield* service.snapshot();
      assert.equal(after.unavailableReason, undefined);
      assert.equal(after.profiles.length, 4);
    }),
  );

  scenario(
    "reports the switcher as unavailable with a short reason and still answers the snapshot",
    { statusUnavailable: true },
    (_harness, service) =>
      Effect.gen(function* () {
        yield* service.refreshStatus();
        const snapshot = yield* service.snapshot();
        assert.equal(snapshot.enabled, true);
        assert.equal(snapshot.available, false);
        assert.equal(
          snapshot.unavailableReason,
          "claude-autoswitch is missing or too old for per-thread placement",
        );
        assert.deepEqual(snapshot.profiles, []);
      }),
  );

  scenario("polls at once when the setting turns on", { enabled: false }, (harness, service) =>
    Effect.gen(function* () {
      const { seen } = yield* watchSnapshotInto(service);
      yield* Ref.set(harness.enabled, true);
      yield* PubSub.publish(harness.settingsChanges, settingsFor(true));
      const loaded = yield* takeUntil(seen, (snapshot) => snapshot.profiles.length > 0);
      assert.equal(loaded.available, true);
      assert.equal(loaded.unavailableReason, undefined);
    }),
  );

  scenario("returns the Auto default for a thread without a row", {}, (_harness, service) =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-no-row");
      assert.deepEqual(yield* service.getThread(threadId), { threadId, mode: { kind: "auto" } });
    }),
  );

  scenario("drops the thread's row when the thread is deleted", {}, (harness, service) =>
    Effect.gen(function* () {
      yield* service.refreshStatus();
      const threadId = ThreadId.make("thread-deleted");
      yield* service.setThreadMode({ threadId, mode: { kind: "profile", profile: "agent" } });
      yield* service.resolveForSession(threadId);
      const { initial, seen } = yield* watchThreadInto(service, threadId);
      assert.equal(initial.resolvedProfile, "agent");

      yield* PubSub.publish(harness.domainEvents, {
        type: "thread.deleted",
        payload: { threadId, deletedAt: "2026-10-02T09:00:00.000Z" },
      } as unknown as OrchestrationEvent);
      const afterDelete = yield* Queue.take(seen);
      assert.deepEqual(afterDelete, { threadId, mode: { kind: "auto" } });
    }),
  );
});

describe("ClaudeAccountsService mode changes on a live session", () => {
  scenario(
    "stops an idle session at once so the next turn respawns on the new account",
    {},
    (harness, service) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("thread-idle-switch");
        yield* Ref.set(harness.sessions, [liveSession(threadId, "ready")]);
        yield* service.refreshStatus();
        yield* service.resolveForSession(threadId);
        const view = yield* service.setThreadMode({
          threadId,
          mode: { kind: "profile", profile: "agent" },
        });
        assert.deepEqual(harness.stoppedThreads, [threadId]);
        assert.notEqual(view.pendingRestart, true);
      }),
  );

  scenario(
    "defers the restart while a turn is running and publishes the pending flag",
    {},
    (harness, service) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("thread-busy-switch");
        yield* Ref.set(harness.sessions, [liveSession(threadId, "running")]);
        yield* service.refreshStatus();
        yield* service.resolveForSession(threadId);
        const view = yield* service.setThreadMode({
          threadId,
          mode: { kind: "profile", profile: "agent" },
        });
        assert.equal(view.pendingRestart, true);
        assert.deepEqual(harness.stoppedThreads, []);
      }),
  );

  scenario(
    "completes a deferred restart on the settled session, not on the provider's turn.completed",
    {},
    (harness, service) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("thread-deferred-restart");
        const drainId = ThreadId.make("thread-deferred-drain");
        yield* Ref.set(harness.sessions, [liveSession(threadId, "running")]);
        yield* Ref.set(harness.shellSession, orchestrationSession(threadId, "running", "turn-1"));
        yield* service.refreshStatus();
        yield* service.resolveForSession(threadId);
        yield* service.setThreadMode({ threadId, mode: { kind: "profile", profile: "agent" } });
        const { initial, seen } = yield* watchThreadInto(service, threadId);
        assert.equal(initial.pendingRestart, true);

        // Domain events are handled in order on one fiber; deleting a watched
        // drain thread shows when everything published before it was handled.
        yield* service.setThreadMode({
          threadId: drainId,
          mode: { kind: "profile", profile: "agent" },
        });
        const drain = yield* watchThreadInto(service, drainId);
        const sessionSet = (status: "ready" | "running", activeTurnId: string | null) =>
          ({
            type: "thread.session-set",
            payload: { threadId, session: orchestrationSession(threadId, status, activeTurnId) },
          }) as unknown as OrchestrationEvent;

        // Real ordering: the provider reports the turn finished while runtime
        // ingestion has not applied it yet, so the shell still reads running.
        yield* PubSub.publish(harness.providerEvents, providerEvent("turn.completed", threadId));
        // The settled session arrives while the provider already runs the next
        // queued turn: still no stop.
        yield* Ref.set(harness.sessions, [liveSession(threadId, "running")]);
        yield* PubSub.publish(harness.domainEvents, sessionSet("ready", null));
        yield* PubSub.publish(harness.domainEvents, {
          type: "thread.deleted",
          payload: { threadId: drainId, deletedAt: "2026-10-02T09:00:00.000Z" },
        } as unknown as OrchestrationEvent);
        yield* Queue.take(drain.seen);
        assert.deepEqual(harness.stoppedThreads, []);

        // That turn ends; the projection still lags (shell reads running) but
        // the settled session is idle: now the session stops.
        yield* Ref.set(harness.sessions, [liveSession(threadId, "ready")]);
        yield* PubSub.publish(harness.domainEvents, sessionSet("ready", null));
        const restarted = yield* Queue.take(seen);
        assert.notEqual(restarted.pendingRestart, true);
        assert.deepEqual(harness.stoppedThreads, [threadId]);
      }),
  );

  scenario(
    "keeps the current account when Auto is chosen from a pin and it is still usable",
    {},
    (harness, service) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("thread-pin-to-auto");
        yield* Ref.set(harness.sessions, [liveSession(threadId, "ready")]);
        yield* service.refreshStatus();
        // Pinning a thread that resolved to nothing yet restarts it once.
        yield* service.setThreadMode({ threadId, mode: { kind: "profile", profile: "agent" } });
        yield* service.resolveForSession(threadId);
        assert.deepEqual(harness.stoppedThreads, [threadId]);
        // Back to Auto: the account is still usable, so nothing restarts.
        yield* service.setThreadMode({ threadId, mode: { kind: "auto" } });
        assert.deepEqual(harness.stoppedThreads, [threadId]);
        assert.equal((yield* service.resolveForSession(threadId))?.profile, "agent");
        assert.equal(harness.placeCalls.length, 0);
      }),
  );

  scenario(
    "streams the thread's account: the current value first, then every change",
    {},
    (_harness, service) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("thread-watch");
        const { initial, seen } = yield* watchThreadInto(service, threadId);
        assert.deepEqual(initial, { threadId, mode: { kind: "auto" } });

        yield* service.setThreadMode({ threadId, mode: { kind: "profile", profile: "agent" } });
        const afterSet = yield* Queue.take(seen);
        assert.deepEqual(afterSet.mode, { kind: "profile", profile: "agent" });
        assert.equal(afterSet.resolvedProfile, undefined);

        yield* service.resolveForSession(threadId);
        const afterResolve = yield* Queue.take(seen);
        assert.equal(afterResolve.resolvedProfile, "agent");
      }),
  );

  scenario(
    "overlays the live windows Claude streams onto the thread's account",
    {},
    (harness, service) =>
      Effect.gen(function* () {
        yield* service.refreshStatus();
        const threadId = ThreadId.make("thread-overlay");
        yield* service.resolveForSession(threadId);
        const { initial, seen } = yield* watchSnapshotInto(service);
        assert.equal(
          initial.profiles.find((profile) => profile.name === "tushar")?.fiveHour?.usedPercent,
          20,
        );

        // Live windows count only after the switcher's last reading.
        yield* TestClock.adjust("1 second");
        yield* PubSub.publish(
          harness.providerEvents,
          rateLimitsEvent(threadId, [
            { id: "five_hour", usedPercent: 97, resetsAt: "2026-10-02T12:29:59.000Z" },
          ]),
        );
        const updated = yield* Queue.take(seen);
        const tushar = updated.profiles.find((profile) => profile.name === "tushar");
        assert.equal(tushar?.fiveHour?.usedPercent, 97);
        assert.equal(tushar?.fiveHour?.resetsAt, "2026-10-02T12:29:59.000Z");
        assert.equal(tushar?.weekly?.usedPercent, 40);
        // Other accounts are untouched.
        assert.equal(
          updated.profiles.find((profile) => profile.name === "agent")?.fiveHour?.usedPercent,
          20,
        );

        // A fresh switcher reading supersedes the overlay.
        yield* TestClock.adjust("1 second");
        yield* service.refreshStatus();
        const refreshed = yield* Queue.take(seen);
        assert.equal(
          refreshed.profiles.find((profile) => profile.name === "tushar")?.fiveHour?.usedPercent,
          20,
        );
      }),
  );
});

describe("applyClaudeAccountProfile", () => {
  const environment = { PATH: "/usr/bin", CLAUDE_CONFIG_DIR: "/home/test/.claude-active" };

  it.effect("passes the environment through when nothing is registered", () =>
    Effect.gen(function* () {
      const result = yield* applyClaudeAccountProfile(ThreadId.make("thread-none"), environment);
      assert.deepEqual(result, environment);
    }),
  );

  scenario(
    "sets CLAUDE_CONFIG_DIR to the resolved account while the service is live",
    {},
    (harness, service) =>
      Effect.gen(function* () {
        yield* service.refreshStatus();
        const threadId = ThreadId.make("thread-apply");
        yield* service.setThreadMode({ threadId, mode: { kind: "profile", profile: "agent" } });
        const result = yield* applyClaudeAccountProfile(threadId, environment);
        assert.equal(result.CLAUDE_CONFIG_DIR, harness.dir("agent"));
        assert.equal(result.PATH, "/usr/bin");
      }),
  );

  scenario("is a no-op while the feature is disabled", { enabled: false }, () =>
    Effect.gen(function* () {
      const result = yield* applyClaudeAccountProfile(
        ThreadId.make("thread-apply-off"),
        environment,
      );
      assert.deepEqual(result, environment);
    }),
  );

  scenario("turns a policy failure into the adapter's validation error", {}, (_harness, service) =>
    Effect.gen(function* () {
      yield* service.refreshStatus();
      const threadId = ThreadId.make("thread-apply-logged-out");
      yield* service.setThreadMode({ threadId, mode: { kind: "profile", profile: "sam" } });
      const result = yield* applyClaudeAccountProfile(threadId, environment).pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.instanceOf(result.failure, ProviderAdapterValidationError);
        assert.match(result.failure.issue, /logged out/);
      }
    }),
  );

  const withActiveLink = <A, E, R>(link: string, body: Effect.Effect<A, E, R>) =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const previous = process.env.T3_CLAUDE_ACTIVE_LINK;
        process.env.T3_CLAUDE_ACTIVE_LINK = link;
        return previous;
      }),
      () => body,
      (previous) =>
        Effect.sync(() => {
          if (previous === undefined) delete process.env.T3_CLAUDE_ACTIVE_LINK;
          else process.env.T3_CLAUDE_ACTIVE_LINK = previous;
        }),
    );

  it.effect(
    "falls back to the unchanged environment when the switcher cannot place and no link resolves",
    () =>
      withActiveLink(
        "/nonexistent/claude-active-for-test",
        Effect.gen(function* () {
          const harness = yield* makeHarness({ placeUnavailable: true });
          yield* Effect.gen(function* () {
            const service = yield* ClaudeAccountsService;
            yield* service.refreshStatus();
            const result = yield* applyClaudeAccountProfile(
              ThreadId.make("thread-apply-fallback"),
              environment,
            );
            assert.deepEqual(result, environment);
          }).pipe(Effect.provide(harness.layer));
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
      ),
  );

  it.effect("degrades to the account the active link points at, and stays sticky on it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const harness = yield* makeHarness({ placeUnavailable: true });
      const link = `${harness.dir("agent")}-active-link`;
      yield* fs.symlink(harness.dir("agent"), link);
      yield* withActiveLink(
        link,
        Effect.gen(function* () {
          const service = yield* ClaudeAccountsService;
          yield* service.refreshStatus();
          const threadId = ThreadId.make("thread-apply-link");
          const first = yield* service.resolveForSession(threadId);
          assert.equal(first?.profile, "agent");
          assert.equal(first?.reason, "active-link");
          const second = yield* service.resolveForSession(threadId);
          assert.equal(second?.reason, "sticky");
          assert.equal(harness.placeCalls.length, 1);
        }).pipe(Effect.provide(harness.layer)),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe("ClaudeAccountsService hard limits", () => {
  const sameReset = 1_790_000_000;

  scenario(
    "moves an Auto thread, stops its session and dispatches one continue turn as the owner",
    {},
    (harness, service) =>
      Effect.gen(function* () {
        yield* service.refreshStatus();
        const threadId = ThreadId.make("thread-hard-limit-auto");
        yield* service.resolveForSession(threadId);

        const handled = yield* service.handleHardLimit({
          threadId,
          rateLimitType: "five_hour",
          resetAt: sameReset,
        });
        assert.isTrue(handled);
        assert.deepEqual(harness.hardLimitCalls, [{ type: "five_hour", profile: "tushar" }]);
        assert.deepEqual(harness.stoppedThreads, [threadId]);
        assert.equal(harness.dispatched.length, 1);
        const { command, actorUserId } = harness.dispatched[0]!;
        assert.equal(actorUserId, owner);
        assert.equal(command.type, "thread.turn.start");
        if (command.type === "thread.turn.start") {
          assert.equal(
            command.message.text,
            "Continue where you left off — this thread moved to Claude account agent because tushar hit its usage limit.",
          );
        }
        assert.equal((yield* service.getThread(threadId)).resolvedProfile, "agent");
        const snapshot = yield* service.snapshot();
        assert.equal(
          snapshot.profiles.find((profile) => profile.name === "tushar")?.eligible,
          false,
        );
      }),
  );

  scenario(
    "ignores stale copies of the first rejection, then moves again when the new account rejects with the same reset",
    {},
    (harness, service) =>
      Effect.gen(function* () {
        yield* service.refreshStatus();
        const threadId = ThreadId.make("thread-hard-limit-twice");
        yield* service.resolveForSession(threadId);
        yield* service.handleHardLimit({
          threadId,
          rateLimitType: "five_hour",
          resetAt: sameReset,
        });
        assert.equal((yield* service.getThread(threadId)).resolvedProfile, "agent");

        // A late copy from the stopped session: nothing has run on agent yet.
        yield* service.handleHardLimit({
          threadId,
          rateLimitType: "five_hour",
          resetAt: sameReset,
        });
        assert.equal(harness.hardLimitCalls.length, 1);
        assert.equal(harness.dispatched.length, 1);
        assert.equal((yield* service.getThread(threadId)).resolvedProfile, "agent");

        // The continue turn starts on agent — from here a rejection is agent's own.
        const { seen } = yield* watchThreadInto(service, threadId);
        yield* PubSub.publish(harness.providerEvents, providerEvent("turn.started", threadId));
        yield* Queue.take(seen);

        yield* service.handleHardLimit({
          threadId,
          rateLimitType: "five_hour",
          resetAt: sameReset,
        });
        assert.deepEqual(harness.hardLimitCalls, [
          { type: "five_hour", profile: "tushar" },
          { type: "five_hour", profile: "agent" },
        ]);
        assert.equal(harness.dispatched.length, 2);
        assert.deepEqual(harness.stoppedThreads, [threadId, threadId]);
        assert.equal((yield* service.getThread(threadId)).resolvedProfile, "barsha");
        assert.include(harness.placeCalls.at(-1)!.avoid, "agent");
        assert.include(harness.placeCalls.at(-1)!.avoid, "tushar");

        // And agent's own repeated copy is consumed once.
        yield* service.handleHardLimit({
          threadId,
          rateLimitType: "five_hour",
          resetAt: sameReset,
        });
        assert.equal(harness.hardLimitCalls.length, 2);
      }),
  );

  scenario("leaves a pinned thread in place with a notice", {}, (harness, service) =>
    Effect.gen(function* () {
      yield* service.refreshStatus();
      const threadId = ThreadId.make("thread-hard-limit-pinned");
      yield* service.setThreadMode({ threadId, mode: { kind: "profile", profile: "agent" } });
      yield* service.resolveForSession(threadId);

      yield* service.handleHardLimit({
        threadId,
        rateLimitType: "seven_day",
        resetAt: Date.parse("2026-10-05T00:00:00Z") / 1000,
      });
      assert.deepEqual(harness.hardLimitCalls, [{ type: "seven_day", profile: "agent" }]);
      assert.deepEqual(harness.stoppedThreads, []);
      assert.equal(harness.dispatched.length, 0);
      const view = yield* service.getThread(threadId);
      assert.equal(
        view.notice,
        "agent is at its usage limit until 00:00 UTC — switch to Auto or another account.",
      );
      assert.equal(view.resolvedProfile, "agent");
    }),
  );

  scenario(
    "moves only the affected Auto thread for a model-scoped limit and leaves the account in rotation",
    {},
    (harness, service) =>
      Effect.gen(function* () {
        yield* service.refreshStatus();
        const affected = ThreadId.make("thread-scoped-auto");
        const sibling = ThreadId.make("thread-scoped-sibling");
        yield* service.resolveForSession(affected);
        yield* service.resolveForSession(sibling);

        yield* service.handleHardLimit({
          threadId: affected,
          rateLimitType: "seven_day_opus",
          resetAt: sameReset,
        });
        assert.deepEqual(harness.hardLimitCalls, [{ type: "seven_day_opus", profile: "tushar" }]);
        const movedTo = (yield* service.getThread(affected)).resolvedProfile;
        assert.notEqual(movedTo, "tushar");
        assert.include(harness.placeCalls.at(-1)!.avoid, "tushar");
        assert.deepEqual(harness.stoppedThreads, [affected]);
        const { command } = harness.dispatched[0]!;
        if (command.type === "thread.turn.start") {
          assert.equal(
            command.message.text,
            `Continue where you left off — this thread moved to Claude account ${movedTo} because tushar has no Opus weekly allowance left.`,
          );
        }
        // tushar is not exhausted: the sibling stays, and new threads may still land there.
        const snapshot = yield* service.snapshot();
        assert.equal(
          snapshot.profiles.find((profile) => profile.name === "tushar")?.eligible,
          true,
        );
        assert.equal((yield* service.resolveForSession(sibling))?.reason, "sticky");
        yield* service.resolveForSession(ThreadId.make("thread-scoped-new"));
        assert.notInclude(harness.placeCalls.at(-1)!.avoid, "tushar");
      }),
  );

  scenario("gives a pinned thread a scoped notice without moving it", {}, (harness, service) =>
    Effect.gen(function* () {
      yield* service.refreshStatus();
      const threadId = ThreadId.make("thread-scoped-pinned");
      yield* service.setThreadMode({ threadId, mode: { kind: "profile", profile: "tushar" } });
      yield* service.resolveForSession(threadId);
      yield* service.handleHardLimit({
        threadId,
        rateLimitType: "seven_day_sonnet",
        resetAt: Date.parse("2026-10-05T00:00:00Z") / 1000,
      });
      assert.deepEqual(harness.stoppedThreads, []);
      assert.equal(
        (yield* service.getThread(threadId)).notice,
        "tushar has no Sonnet weekly allowance left until 00:00 UTC — switch the model or account.",
      );
      assert.equal(
        (yield* service.snapshot()).profiles.find((p) => p.name === "tushar")?.eligible,
        true,
      );
    }),
  );

  scenario(
    "declines the rejection while the feature is off",
    { enabled: false },
    (harness, service) =>
      Effect.gen(function* () {
        const handled = yield* service.handleHardLimit({
          threadId: ThreadId.make("thread-hard-limit-off"),
          rateLimitType: "five_hour",
          resetAt: undefined,
        });
        assert.isFalse(handled);
        assert.deepEqual(harness.hardLimitCalls, []);
      }),
  );

  it.effect("declines a rejection it cannot attribute to an account", () =>
    Effect.gen(function* () {
      const previous = process.env.T3_CLAUDE_ACTIVE_LINK;
      process.env.T3_CLAUDE_ACTIVE_LINK = "/nonexistent/claude-active-for-test";
      try {
        const harness = yield* makeHarness();
        yield* Effect.gen(function* () {
          const service = yield* ClaudeAccountsService;
          const handled = yield* service.handleHardLimit({
            threadId: ThreadId.make("thread-hard-limit-unattributed"),
            rateLimitType: "five_hour",
            resetAt: undefined,
          });
          assert.isFalse(handled);
          assert.deepEqual(harness.hardLimitCalls, []);
        }).pipe(Effect.provide(harness.layer));
      } finally {
        if (previous === undefined) delete process.env.T3_CLAUDE_ACTIVE_LINK;
        else process.env.T3_CLAUDE_ACTIVE_LINK = previous;
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
