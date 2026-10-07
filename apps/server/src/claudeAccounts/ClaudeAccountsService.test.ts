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

import { OrchestrationEngineService } from "../orchestration-v2/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration-v2/Services/ProjectionSnapshotQuery.ts";
import { layerMemory as SqlitePersistenceMemory } from "../persistence/Sqlite.ts";
import { MigrationsLive } from "../persistence/Migrations.ts";
import * as ThreadClaudeAccountRepo from "../persistence/ThreadClaudeAccount.ts";
import * as ClaudeAccountProfileAccessRepo from "../persistence/ClaudeAccountProfileAccess.ts";
import { PersistenceSqlError } from "../persistence/Errors.ts";
import { ProviderAdapterValidationError } from "../provider/Errors.ts";
import { ForkProviderSessions as ProviderService } from "../provider/ForkProviderSessions.expbkt3.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  applyClaudeAccountProfile,
  ClaudeAccountPolicyError,
} from "./applyClaudeAccountProfile.ts";
import {
  type ClaudeAutoswitchClientShape,
  type ClaudeAutoswitchRankInput,
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
  /** `--place` crashes or times out (`kind: "failed"`). */
  readonly placeFailed?: boolean;
  /** `--place` dies with a defect, as a bug in the client would. */
  readonly placeDefect?: boolean;
  /** Replaces the thread-account repository, e.g. with one whose reads fail. */
  readonly threadRepository?: Layer.Layer<ThreadClaudeAccountRepo.ThreadClaudeAccountRepository>;
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
    // Accounts the switcher does not list resolve under the profile root, which
    // must be this sandbox rather than the real home of whoever runs the tests.
    const previousProfileRoot = process.env.CLAUDE_PROFILE_ROOT;
    process.env.CLAUDE_PROFILE_ROOT = `${root}/profiles`;
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (previousProfileRoot === undefined) delete process.env.CLAUDE_PROFILE_ROOT;
        else process.env.CLAUDE_PROFILE_ROOT = previousProfileRoot;
      }),
    );
    const status = (options.status ?? defaultStatus)(dir);
    for (const profile of status.profiles) {
      yield* fs.makeDirectory(dir(profile.name), { recursive: true });
    }
    /** What the next `--status` answers; tests may shrink it to retire an account. */
    const statusRef = yield* Ref.make(status);

    const placeCalls: Array<{ pending: Record<string, number>; avoid: ReadonlyArray<string> }> = [];
    /** The ranking input of every `--status` call, `undefined` when none was sent. */
    const statusCalls: Array<ClaudeAutoswitchRankInput | undefined> = [];
    const hardLimitCalls: Array<{ type: string; profile: string }> = [];
    const stoppedThreads: Array<ThreadId> = [];
    const dispatched: Array<{ command: OrchestrationCommand; actorUserId: unknown }> = [];
    const place = options.place ?? spreadPlace(status);
    const enabled = yield* Ref.make(options.enabled ?? true);
    const sessions = yield* Ref.make<ReadonlyArray<ProviderSession>>([]);
    const shellSession = yield* Ref.make<OrchestrationSession | null>(null);
    /** The thread shell's owner; `undefined` means no shell (a draft). */
    const shellOwner = yield* Ref.make<UserId | null | undefined>(owner);
    /** When set, reading the thread shell fails, as a broken projection read would. */
    const shellFails = yield* Ref.make(false);

    // Subscriptions are taken here, before the service exists, so an event
    // published at any point after harness creation reaches the service.
    const providerEvents = yield* PubSub.unbounded<ProviderRuntimeEvent>();
    const providerSubscription = yield* PubSub.subscribe(providerEvents);
    const domainEvents = yield* PubSub.unbounded<OrchestrationEvent>();
    const domainSubscription = yield* PubSub.subscribe(domainEvents);
    const settingsChanges = yield* PubSub.unbounded<ServerSettings>();
    const settingsSubscription = yield* PubSub.subscribe(settingsChanges);

    const client: ClaudeAutoswitchClientShape = {
      status: (input) =>
        Ref.get(statusRef).pipe(
          Effect.tap(() => Effect.sync(() => statusCalls.push(input))),
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
          if (options.placeFailed) {
            return { kind: "failed", detail: "timed out after 10s" } as const;
          }
          if (options.placeDefect) throw new Error("place exploded");
          return { kind: "ok", value: place(input) } as const;
        }),
      hardLimit: (input) =>
        Effect.sync(() => {
          hardLimitCalls.push(input);
          return { kind: "ok", value: { status: "no-op", reason: "not_elected" } } as const;
        }),
    };

    const shell = Effect.all([Ref.get(shellSession), Ref.get(shellOwner)]).pipe(
      Effect.map(
        ([session, ownerUserId]) =>
          ({
            ownerUserId,
            modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" },
            runtimeMode: "full-access",
            interactionMode: "default",
            session,
          }) as unknown as OrchestrationThreadShell,
      ),
    );

    const layer = ClaudeAccountsServiceLayer.layer.pipe(
      Layer.provide(options.threadRepository ?? ThreadClaudeAccountRepo.layer),
      Layer.provide(ClaudeAccountProfileAccessRepo.layer),
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
          getThreadShellById: () =>
            Effect.gen(function* () {
              if (yield* Ref.get(shellFails)) {
                return yield* new PersistenceSqlError({
                  operation: "test:getThreadShellById",
                  cause: "boom",
                });
              }
              const value = yield* shell;
              const ownerUserId = yield* Ref.get(shellOwner);
              return ownerUserId === undefined ? Option.none() : Option.some(value);
            }),
        }),
      ),
      Layer.provide(NodeServices.layer),
    );

    return {
      layer,
      dir,
      status: statusRef,
      placeCalls,
      statusCalls,
      hardLimitCalls,
      stoppedThreads,
      dispatched,
      enabled,
      sessions,
      shellSession,
      shellOwner,
      shellFails,
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

describe("ClaudeAccountsService live sessions started before placement", () => {
  scenario(
    "shows the account a thread's live Claude session runs on when nothing placed it",
    {},
    (harness, service) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("thread-older-session");
        const fs = yield* FileSystem.FileSystem;
        const stat = yield* fs.readFileString("/proc/self/stat");
        const procStart = stat
          .slice(stat.lastIndexOf(")") + 1)
          .trim()
          .split(/\s+/)[19];
        yield* fs.makeDirectory(`${harness.dir("barsha")}/sessions`, { recursive: true });
        yield* fs.writeFileString(
          `${harness.dir("barsha")}/sessions/${process.pid}.json`,
          `{"pid":${process.pid},"sessionId":"claude-older","procStart":"${procStart}"}`,
        );
        // A stale file for a pid that is gone does not count.
        yield* fs
          .writeFileString(
            `${harness.dir("agent")}/sessions/999999.json`,
            `{"pid":999999,"sessionId":"claude-older","procStart":"1"}`,
          )
          .pipe(Effect.ignore);
        yield* Ref.set(harness.shellSession, {
          ...orchestrationSession(threadId, "ready", null),
          providerThreadId: "claude-older",
        });

        const before = yield* service.getThread(threadId);
        assert.equal(before.resolvedProfile, undefined);

        yield* service.refreshStatus();
        const after = yield* service.getThread(threadId);
        assert.equal(after.resolvedProfile, "barsha");
        assert.deepEqual(after.mode, { kind: "auto" });
        // An observation only: nothing was placed or persisted.
        assert.equal(harness.placeCalls.length, 0);
      }),
  );
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

  scenario(
    "sends burn rates once the switcher ranks by space to reset, and shows its order",
    {
      status: (dir) => ({
        ...switcherStatus([
          switcherProfile(dir, "tushar", {
            five_hour: { used: 20, resets_at: "2026-10-02T12:00:00Z" },
            space_to_reset: 68.5,
            space_per_day: 46.6,
            five_hour_full_in: 3720,
            place_rank: 2,
            eligible: false,
          }),
          switcherProfile(dir, "agent", {
            rank: 2,
            elected: false,
            space_to_reset: 97,
            space_per_day: 14.1,
            place_rank: 1,
          }),
          switcherProfile(dir, "sam", {
            rank: 3,
            elected: false,
            auth: { state: "logged_out", detail: "" },
            place_rank: 3,
          }),
        ]),
        place_rule: "space-share-v1",
        place_order: ["agent", "tushar", "sam"],
      }),
    },
    (harness, service) =>
      Effect.gen(function* () {
        yield* service.refreshStatus();
        // Nothing is sent before the switcher has shown it accepts the flags.
        assert.equal(harness.statusCalls[0], undefined);

        // Ten minutes later tushar's window is 10 points fuller: 60 points/h.
        yield* Ref.update(harness.status, (current) => ({
          ...current,
          generated_ms: 1_000 + 600_000,
          profiles: current.profiles.map((profile) =>
            profile.name === "tushar"
              ? { ...profile, five_hour: { used: 30, resets_at: "2026-10-02T12:00:00Z" } }
              : profile,
          ),
        }));
        yield* service.refreshStatus();
        yield* service.refreshStatus();
        const last = harness.statusCalls.at(-1);
        assert.deepEqual(last?.pending, {});
        assert.closeTo(last?.rates?.tushar ?? -1, 60, 0.001);
        assert.equal(last?.rates?.agent, 0);

        const snapshot = yield* service.snapshot();
        const byName = new Map(snapshot.profiles.map((profile) => [profile.name, profile]));
        assert.include(byName.get("tushar"), {
          spaceToReset: 68.5,
          spacePerDay: 46.6,
          fiveHourFullInSec: 3720,
          placeRank: 2,
        });
        assert.equal(byName.get("agent")?.placeRank, 1);
        // A logged-out account is never numbered, whatever the switcher says.
        assert.equal(byName.get("sam")?.placeRank, undefined);
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

  // The test clock starts at the epoch, so these resets are minutes away.
  const resetInTwoMinutes = 120;

  scenario(
    "waits out a limit that resets within five minutes, then continues on the same account",
    {},
    (harness, service) =>
      Effect.gen(function* () {
        yield* service.refreshStatus();
        const threadId = ThreadId.make("thread-reset-wait");
        yield* service.resolveForSession(threadId);
        const placementsBefore = harness.placeCalls.length;
        const { seen } = yield* watchThreadInto(service, threadId);

        assert.isTrue(
          yield* service.handleHardLimit({
            threadId,
            rateLimitType: "five_hour",
            resetAt: resetInTwoMinutes,
          }),
        );
        assert.deepEqual(harness.stoppedThreads, [threadId]);
        assert.equal(harness.dispatched.length, 0);
        const waiting = yield* service.getThread(threadId);
        assert.equal(
          waiting.notice,
          "tushar resets at 00:02 UTC — this thread continues on it at 00:03 UTC.",
        );
        assert.equal(waiting.resolvedProfile, "tushar");
        assert.equal(harness.placeCalls.length, placementsBefore);

        yield* TestClock.adjust("3 minutes");
        yield* takeUntil(seen, (view) => view.notice === undefined);
        assert.equal(harness.dispatched.length, 1);
        const { command, actorUserId } = harness.dispatched[0]!;
        assert.equal(actorUserId, owner);
        if (command.type === "thread.turn.start") {
          assert.equal(
            command.message.text,
            "Continue where you left off — Claude account tushar has reset its usage limit.",
          );
        }
        const resumed = yield* service.resolveForSession(threadId);
        assert.equal(resumed?.profile, "tushar");
        assert.equal(resumed?.reason, "sticky");

        // Claude still refuses with the old reset: no second wait, the thread moves.
        yield* PubSub.publish(harness.providerEvents, providerEvent("turn.started", threadId));
        yield* service.handleHardLimit({
          threadId,
          rateLimitType: "five_hour",
          resetAt: resetInTwoMinutes,
        });
        assert.equal(harness.dispatched.length, 2);
        assert.equal((yield* service.getThread(threadId)).resolvedProfile, "agent");
      }),
  );

  scenario(
    "drops the wait as soon as a message is accepted for the thread",
    {},
    (harness, service) =>
      Effect.gen(function* () {
        yield* service.refreshStatus();
        const threadId = ThreadId.make("thread-reset-wait-message");
        yield* service.resolveForSession(threadId);
        const { seen } = yield* watchThreadInto(service, threadId);
        yield* service.handleHardLimit({
          threadId,
          rateLimitType: "five_hour",
          resetAt: resetInTwoMinutes,
        });

        yield* PubSub.publish(harness.domainEvents, {
          type: "thread.turn-start-requested",
          payload: { threadId },
        } as unknown as OrchestrationEvent);
        yield* takeUntil(seen, (view) => view.notice === undefined);
        yield* TestClock.adjust("10 minutes");
        assert.equal(harness.dispatched.length, 0);
      }),
  );

  scenario("drops the wait when someone sends a message before the reset", {}, (harness, service) =>
    Effect.gen(function* () {
      yield* service.refreshStatus();
      const threadId = ThreadId.make("thread-reset-wait-interrupted");
      yield* service.resolveForSession(threadId);
      const { seen } = yield* watchThreadInto(service, threadId);
      yield* service.handleHardLimit({
        threadId,
        rateLimitType: "five_hour",
        resetAt: resetInTwoMinutes,
      });

      yield* PubSub.publish(harness.providerEvents, providerEvent("turn.started", threadId));
      yield* takeUntil(seen, (view) => view.notice === undefined);
      yield* TestClock.adjust("10 minutes");
      assert.equal(harness.dispatched.length, 0);
    }),
  );

  scenario("drops the wait when the thread's account mode changes", {}, (harness, service) =>
    Effect.gen(function* () {
      yield* service.refreshStatus();
      const threadId = ThreadId.make("thread-reset-wait-mode");
      yield* service.resolveForSession(threadId);
      yield* service.handleHardLimit({
        threadId,
        rateLimitType: "five_hour",
        resetAt: resetInTwoMinutes,
      });
      yield* service.setThreadMode({ threadId, mode: { kind: "profile", profile: "agent" } });
      yield* TestClock.adjust("10 minutes");
      assert.equal(harness.dispatched.length, 0);
    }),
  );

  scenario("moves instead when the reset is more than five minutes away", {}, (harness, service) =>
    Effect.gen(function* () {
      yield* service.refreshStatus();
      const threadId = ThreadId.make("thread-reset-too-far");
      yield* service.resolveForSession(threadId);
      yield* service.handleHardLimit({
        threadId,
        rateLimitType: "five_hour",
        resetAt: 5 * 60 + 1,
      });
      assert.equal(harness.dispatched.length, 1);
      assert.equal((yield* service.getThread(threadId)).resolvedProfile, "agent");
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

describe("ClaudeAccountsService access per user", () => {
  const colleague = UserId.make("user-colleague");

  scenario("leaves every account open while no users are assigned", {}, (harness, service) =>
    Effect.gen(function* () {
      yield* service.refreshStatus();
      const resolution = yield* service.resolveForSession(ThreadId.make("thread-open"));
      assert.equal(resolution?.profile, "tushar");
      assert.deepEqual(harness.placeCalls[0]!.avoid, []);
      assert.deepEqual((yield* service.listAccess()).entries, []);
    }),
  );

  scenario("makes Auto avoid an account assigned only to other users", {}, (harness, service) =>
    Effect.gen(function* () {
      yield* service.refreshStatus();
      yield* service.setAccess({ profile: "tushar", userIds: [colleague], actorUserId: null });
      const resolution = yield* service.resolveForSession(ThreadId.make("thread-avoid"));
      assert.equal(resolution?.profile, "agent");
      assert.include(harness.placeCalls[0]!.avoid, "tushar");
    }),
  );

  scenario("lets an assigned user keep using their account", {}, (harness, service) =>
    Effect.gen(function* () {
      yield* service.refreshStatus();
      yield* service.setAccess({
        profile: "tushar",
        userIds: [colleague, owner],
        actorUserId: null,
      });
      const resolution = yield* service.resolveForSession(ThreadId.make("thread-assigned"));
      assert.equal(resolution?.profile, "tushar");
      assert.deepEqual(harness.placeCalls[0]!.avoid, []);
    }),
  );

  scenario(
    "refuses a pin to an account the caller may not use, and fails a stored one",
    {},
    (_harness, service) =>
      Effect.gen(function* () {
        yield* service.refreshStatus();
        const threadId = ThreadId.make("thread-pin-revoked");
        // Pinned while the account was still open.
        yield* service.setThreadMode({
          threadId,
          mode: { kind: "profile", profile: "barsha" },
          actorUserId: owner,
        });
        yield* service.setAccess({ profile: "barsha", userIds: [colleague], actorUserId: null });

        const refused = yield* service
          .setThreadMode({
            threadId: ThreadId.make("thread-pin-new"),
            mode: { kind: "profile", profile: "barsha" },
            actorUserId: owner,
          })
          .pipe(Effect.result);
        assert.equal(refused._tag, "Failure");
        if (refused._tag === "Failure") assert.equal(refused.failure.reason, "forbidden");

        const start = yield* service.resolveForSession(threadId).pipe(Effect.result);
        assert.equal(start._tag, "Failure");
        if (start._tag === "Failure") {
          assert.instanceOf(start.failure, ClaudeAccountPolicyError);
          assert.equal(
            start.failure.detail,
            "You don't have access to Claude account barsha — ask an admin or switch to Auto.",
          );
        }
      }),
  );

  scenario(
    "checks a draft's pin against the caller, since no owner exists yet",
    {},
    (harness, service) =>
      Effect.gen(function* () {
        yield* service.refreshStatus();
        yield* Ref.set(harness.shellOwner, undefined);
        yield* service.setAccess({ profile: "agent", userIds: [colleague], actorUserId: null });
        const threadId = ThreadId.make("draft-pin-access");
        const refused = yield* service
          .setThreadMode({
            threadId,
            mode: { kind: "profile", profile: "agent" },
            actorUserId: owner,
          })
          .pipe(Effect.result);
        assert.equal(refused._tag, "Failure");
        if (refused._tag === "Failure") assert.equal(refused.failure.reason, "forbidden");

        const accepted = yield* service.setThreadMode({
          threadId,
          mode: { kind: "profile", profile: "agent" },
          actorUserId: colleague,
        });
        assert.deepEqual(accepted.mode, { kind: "profile", profile: "agent" });
      }),
  );

  scenario("re-places a sticky thread once its account is taken away", {}, (harness, service) =>
    Effect.gen(function* () {
      yield* service.refreshStatus();
      const threadId = ThreadId.make("thread-sticky-revoked");
      assert.equal((yield* service.resolveForSession(threadId))?.profile, "tushar");

      yield* service.setAccess({ profile: "tushar", userIds: [colleague], actorUserId: null });
      const moved = yield* service.resolveForSession(threadId);
      assert.equal(moved?.profile, "agent");
      assert.equal(harness.placeCalls.length, 2);
      assert.include(harness.placeCalls[1]!.avoid, "tushar");
      assert.equal((yield* service.getThread(threadId)).resolvedProfile, "agent");
    }),
  );

  scenario("fails clearly when the owner may use no account at all", {}, (harness, service) =>
    Effect.gen(function* () {
      yield* service.refreshStatus();
      for (const profile of ["tushar", "agent", "barsha", "sam"]) {
        yield* service.setAccess({ profile, userIds: [colleague], actorUserId: null });
      }
      const result = yield* service
        .resolveForSession(ThreadId.make("thread-no-access"))
        .pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.equal(
          result.failure.detail,
          "You don't have access to any Claude account — ask an admin to give you one.",
        );
      }
      assert.equal(harness.placeCalls.length, 0);
    }),
  );

  scenario("leaves the unidentified local operator unrestricted", {}, (harness, service) =>
    Effect.gen(function* () {
      yield* service.refreshStatus();
      yield* Ref.set(harness.shellOwner, null);
      yield* service.setAccess({ profile: "tushar", userIds: [colleague], actorUserId: null });
      const threadId = ThreadId.make("thread-local");
      const resolution = yield* service.resolveForSession(threadId);
      assert.equal(resolution?.profile, "tushar");
      assert.deepEqual(harness.placeCalls[0]!.avoid, []);
      const pinned = yield* service.setThreadMode({
        threadId,
        mode: { kind: "profile", profile: "tushar" },
        actorUserId: null,
      });
      assert.deepEqual(pinned.mode, { kind: "profile", profile: "tushar" });
    }),
  );

  scenario(
    "narrows each viewer's snapshot and pushes a new one when access changes",
    {},
    (_harness, service) =>
      Effect.gen(function* () {
        yield* service.refreshStatus();
        const member = yield* watchSnapshotInto(service);
        const nonAdmin = yield* service
          .watchSnapshot({ userId: owner, isAdmin: false })
          .pipe(Stream.take(1), Stream.runCollect);
        assert.equal(Array.from(nonAdmin)[0]!.profiles.length, 4);
        assert.equal(member.initial.profiles.length, 4);

        yield* service.setAccess({ profile: "tushar", userIds: [colleague], actorUserId: null });
        const [restricted] = yield* service
          .watchSnapshot({ userId: owner, isAdmin: false })
          .pipe(Stream.take(1), Stream.runCollect);
        assert.deepEqual(
          restricted!.profiles.map((status) => status.name),
          ["agent", "barsha", "sam"],
        );
        assert.isUndefined(restricted!.profiles[0]!.allowed);

        const [admin] = yield* service
          .watchSnapshot({ userId: owner, isAdmin: true })
          .pipe(Stream.take(1), Stream.runCollect);
        assert.deepEqual(
          admin!.profiles.map((status) => [status.name, status.allowed]),
          [
            ["tushar", false],
            ["agent", true],
            ["barsha", true],
            ["sam", true],
          ],
        );
        // An unfiltered watcher hears the change too.
        yield* Queue.take(member.seen);
      }),
  );

  scenario("lists and clears allow lists", {}, (_harness, service) =>
    Effect.gen(function* () {
      yield* service.refreshStatus();
      const set = yield* service.setAccess({
        profile: "agent",
        userIds: [owner, colleague, owner],
        actorUserId: owner,
      });
      assert.deepEqual(set.entries, [{ profile: "agent", userIds: [colleague, owner] }]);
      const cleared = yield* service.setAccess({
        profile: "agent",
        userIds: [],
        actorUserId: owner,
      });
      assert.deepEqual(cleared.entries, []);

      const unknown = yield* service
        .setAccess({ profile: "nobody", userIds: [owner], actorUserId: owner })
        .pipe(Effect.result);
      assert.equal(unknown._tag, "Failure");
      if (unknown._tag === "Failure") assert.equal(unknown.failure.reason, "invalid");
    }),
  );
});

describe("ClaudeAccountsService access per user: fallbacks fail closed", () => {
  const colleague = UserId.make("user-colleague");
  const UNAVAILABLE =
    "Claude account placement is unavailable right now and the host's default account is not one you can use — try again shortly.";

  /** Points `~/.claude-active` at a directory for the body; its basename is the account. */
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

  const expectPolicy = (
    result: { readonly _tag: "Success" | "Failure"; readonly failure?: unknown },
    detail: string,
  ) => {
    assert.equal(result._tag, "Failure");
    assert.instanceOf(result.failure, ClaudeAccountPolicyError);
    assert.equal((result.failure as ClaudeAccountPolicyError).detail, detail);
  };

  for (const [label, options] of [
    ["the switcher is unavailable", { placeUnavailable: true }],
    ["the switcher times out", { placeFailed: true }],
    ["placement hits a defect", { placeDefect: true }],
  ] as const) {
    scenario(
      `refuses when ${label} and the active link is off limits`,
      options,
      (harness, service) =>
        withActiveLink(
          harness.dir("tushar"),
          Effect.gen(function* () {
            yield* service.refreshStatus();
            yield* service.setAccess({
              profile: "tushar",
              userIds: [colleague],
              actorUserId: null,
            });
            const result = yield* service
              .resolveForSession(ThreadId.make(`thread-closed-${label}`))
              .pipe(Effect.result);
            expectPolicy(result as never, UNAVAILABLE);
          }),
        ),
    );

    scenario(
      `uses the active link explicitly when ${label} and the owner may use it`,
      options,
      (harness, service) =>
        withActiveLink(
          harness.dir("agent"),
          Effect.gen(function* () {
            yield* service.refreshStatus();
            yield* service.setAccess({
              profile: "tushar",
              userIds: [colleague],
              actorUserId: null,
            });
            const resolution = yield* service.resolveForSession(
              ThreadId.make(`thread-link-${label}`),
            );
            assert.equal(resolution?.profile, "agent");
            assert.equal(resolution?.reason, "active-link");
          }),
        ),
    );
  }

  scenario(
    "still leaves an unrestricted owner on the host default when the switcher times out",
    { placeFailed: true },
    (_harness, service) =>
      Effect.gen(function* () {
        yield* service.refreshStatus();
        const resolution = yield* service.resolveForSession(ThreadId.make("thread-open-timeout"));
        assert.isUndefined(resolution);
      }),
  );

  scenario(
    "refuses when the thread's row cannot be read and the active link is off limits",
    {
      threadRepository: Layer.mock(ThreadClaudeAccountRepo.ThreadClaudeAccountRepository)({
        get: () =>
          Effect.fail(new PersistenceSqlError({ operation: "test:get", cause: "disk gone" })),
      }),
    },
    (harness, service) =>
      withActiveLink(
        harness.dir("tushar"),
        Effect.gen(function* () {
          yield* service.refreshStatus();
          yield* service.setAccess({ profile: "tushar", userIds: [colleague], actorUserId: null });
          const result = yield* service
            .resolveForSession(ThreadId.make("thread-row-broken"))
            .pipe(Effect.result);
          expectPolicy(result as never, UNAVAILABLE);
        }),
      ),
  );

  scenario(
    "fails closed when the owner cannot be read, instead of treating the thread as unowned",
    {},
    (harness, service) =>
      Effect.gen(function* () {
        yield* service.refreshStatus();
        yield* service.setAccess({ profile: "tushar", userIds: [colleague], actorUserId: null });
        yield* Ref.set(harness.shellFails, true);
        const result = yield* service
          .resolveForSession(ThreadId.make("thread-shell-broken"))
          .pipe(Effect.result);
        assert.equal(result._tag, "Failure");
        if (result._tag === "Failure") {
          assert.instanceOf(result.failure, ClaudeAccountPolicyError);
          assert.match(result.failure.detail, /Could not check Claude account access/);
        }
        assert.equal(harness.placeCalls.length, 0);
      }),
  );

  scenario(
    "refuses an account the switcher picked despite --avoid",
    {
      place: () => ({ status: "placed", chosen: "tushar", dir: null, reason: "ignored avoid" }),
    },
    (_harness, service) =>
      Effect.gen(function* () {
        yield* service.refreshStatus();
        yield* service.setAccess({ profile: "tushar", userIds: [colleague], actorUserId: null });
        const result = yield* service
          .resolveForSession(ThreadId.make("thread-bad-pick"))
          .pipe(Effect.result);
        assert.equal(result._tag, "Failure");
        if (result._tag === "Failure") {
          assert.notEqual(result.failure.detail, "");
          assert.notInclude(result.failure.detail, "tushar");
        }
      }),
  );

  scenario(
    "says 'no access' rather than inventing a reset when nothing usable is left",
    {
      statusUnavailable: true,
      place: () => ({
        status: "no_eligible_profile",
        chosen: null,
        dir: null,
        reason: "everything avoided",
        recovers_at: null,
      }),
    },
    (_harness, service) =>
      Effect.gen(function* () {
        // `--status` cannot be read, so only the access list and the switcher speak.
        yield* service.setAccess({ profile: "tushar", userIds: [colleague], actorUserId: null });
        const result = yield* service
          .resolveForSession(ThreadId.make("thread-nothing-left"))
          .pipe(Effect.result);
        expectPolicy(
          result as never,
          "You don't have access to any Claude account — ask an admin to give you one.",
        );
      }),
  );

  scenario(
    "reports an unknown reset without a made-up time for an unrestricted owner",
    {
      place: () => ({
        status: "no_eligible_profile",
        chosen: null,
        dir: null,
        reason: "every profile is over its limit",
        recovers_at: null,
      }),
    },
    (_harness, service) =>
      Effect.gen(function* () {
        yield* service.refreshStatus();
        const result = yield* service
          .resolveForSession(ThreadId.make("thread-unknown-reset"))
          .pipe(Effect.result);
        expectPolicy(result as never, "All Claude accounts are at their limit.");
      }),
  );
});

describe("ClaudeAccountsService access per user: owners, probing, hard limits, revocation", () => {
  const colleague = UserId.make("user-colleague");

  scenario("refuses a pin the caller may use but the thread's owner may not", {}, (_h, service) =>
    Effect.gen(function* () {
      yield* service.refreshStatus();
      yield* service.setAccess({ profile: "agent", userIds: [colleague], actorUserId: null });
      const result = yield* service
        .setThreadMode({
          threadId: ThreadId.make("thread-shared"),
          mode: { kind: "profile", profile: "agent" },
          actorUserId: colleague,
        })
        .pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.equal(result.failure.reason, "forbidden");
        assert.match(result.failure.detail, /thread's owner doesn't have access/);
      }
    }),
  );

  scenario(
    "answers a hidden and a missing account the same way, so pins cannot probe",
    {},
    (_harness, service) =>
      Effect.gen(function* () {
        yield* service.refreshStatus();
        yield* service.setAccess({ profile: "agent", userIds: [colleague], actorUserId: null });
        const attempt = (profile: string) =>
          service
            .setThreadMode({
              threadId: ThreadId.make(`thread-probe-${profile}`),
              mode: { kind: "profile", profile },
              actorUserId: owner,
            })
            .pipe(Effect.flip);
        const hidden = yield* attempt("agent");
        const missing = yield* attempt("nobody");
        assert.equal(hidden.reason, "forbidden");
        assert.equal(missing.reason, "forbidden");
        assert.equal(hidden.detail.replace("agent", "X"), missing.detail.replace("nobody", "X"));
      }),
  );

  scenario(
    "moves an Auto thread on a hard limit only to an account its owner may use",
    {},
    (harness, service) =>
      Effect.gen(function* () {
        yield* service.refreshStatus();
        yield* service.setAccess({ profile: "agent", userIds: [colleague], actorUserId: null });
        const threadId = ThreadId.make("thread-hard-limit-access");
        assert.equal((yield* service.resolveForSession(threadId))?.profile, "tushar");

        yield* service.handleHardLimit({
          threadId,
          rateLimitType: "five_hour",
          resetAt: 1_790_000_000,
        });
        assert.equal((yield* service.getThread(threadId)).resolvedProfile, "barsha");
        const avoid = harness.placeCalls.at(-1)!.avoid;
        assert.include(avoid, "agent");
        assert.include(avoid, "tushar");
      }),
  );

  scenario(
    "restarts a live session whose account was just taken from its owner",
    {},
    (harness, service) =>
      Effect.gen(function* () {
        yield* service.refreshStatus();
        const idle = ThreadId.make("thread-revoked-idle");
        const busy = ThreadId.make("thread-revoked-busy");
        const untouched = ThreadId.make("thread-revoke-untouched");
        assert.equal((yield* service.resolveForSession(idle))?.profile, "tushar");
        yield* service.setThreadMode({
          threadId: busy,
          mode: { kind: "profile", profile: "tushar" },
          actorUserId: owner,
        });
        yield* service.resolveForSession(busy);
        yield* service.setThreadMode({
          threadId: untouched,
          mode: { kind: "profile", profile: "agent" },
          actorUserId: owner,
        });
        yield* service.resolveForSession(untouched);
        yield* Ref.set(harness.sessions, [
          liveSession(idle, "ready"),
          liveSession(busy, "running"),
          liveSession(untouched, "ready"),
        ]);

        yield* service.setAccess({ profile: "tushar", userIds: [colleague], actorUserId: null });
        assert.deepEqual(harness.stoppedThreads, [idle]);
        const busyView = yield* service.getThread(busy);
        assert.isTrue(busyView.pendingRestart);
        assert.equal(
          busyView.notice,
          "You don't have access to Claude account tushar — ask an admin or switch to Auto.",
        );
      }),
  );
});
