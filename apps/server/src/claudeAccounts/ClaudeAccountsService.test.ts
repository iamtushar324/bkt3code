/**
 * T3-CUSTOM(expbkt3): placement, pinning, restarts and the hard-limit path for
 * Claude account profiles per thread, against a fake host switcher.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  type OrchestrationCommand,
  type OrchestrationThreadShell,
  type ProviderSession,
  type ServerSettings,
  type ThreadClaudeAccount,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

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
import { ClaudeAccountsService } from "./ClaudeAccountsService.ts";

const profileDir = (name: string) => `/home/test/.claude-profiles/${name}`;

function switcherProfile(name: string, overrides: Partial<SwitcherProfile> = {}): SwitcherProfile {
  return {
    name,
    dir: profileDir(name),
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

interface HarnessOptions {
  readonly enabled?: boolean;
  readonly status?: SwitcherStatus;
  /** Decides `--place`; defaults to the first eligible profile not in `avoid` with the fewest pending. */
  readonly place?: (input: {
    readonly pending: Readonly<Record<string, number>>;
    readonly avoid: ReadonlyArray<string>;
  }) => SwitcherPlaceResult;
  readonly statusUnavailable?: boolean;
  readonly placeUnavailable?: boolean;
  readonly liveSessions?: ReadonlyArray<ProviderSession>;
}

const defaultStatus = switcherStatus([
  switcherProfile("tushar"),
  switcherProfile("agent", { rank: 2, elected: false }),
  switcherProfile("sam", { rank: 3, elected: false, auth: { state: "logged_out", detail: "" } }),
]);

/** Spread rule: the eligible account with the fewest pending placements, ties by rank order. */
function spreadPlace(status: SwitcherStatus) {
  return (input: {
    readonly pending: Readonly<Record<string, number>>;
    readonly avoid: ReadonlyArray<string>;
  }): SwitcherPlaceResult => {
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

const makeHarness = (options: HarnessOptions = {}) =>
  Effect.gen(function* () {
    const status = options.status ?? defaultStatus;
    const placeCalls: Array<{ pending: Record<string, number>; avoid: ReadonlyArray<string> }> = [];
    const hardLimitCalls: Array<{ type: string; profile: string }> = [];
    const stoppedThreads: Array<ThreadId> = [];
    const dispatched: Array<OrchestrationCommand> = [];
    const place = options.place ?? spreadPlace(status);
    const enabled = yield* Ref.make(options.enabled ?? true);

    const client: ClaudeAutoswitchClientShape = {
      status: () =>
        Effect.succeed(
          options.statusUnavailable
            ? { kind: "unavailable", detail: "old switcher" }
            : { kind: "ok", value: status },
        ),
      place: (input) =>
        Effect.sync(() => {
          placeCalls.push({ pending: { ...input.pending }, avoid: input.avoid });
          if (options.placeUnavailable)
            return { kind: "unavailable", detail: "old switcher" } as const;
          return { kind: "ok", value: place(input) } as const;
        }),
      hardLimit: (input) =>
        Effect.sync(() => {
          hardLimitCalls.push(input);
          return { kind: "ok", value: { status: "no-op", reason: "not_elected" } } as const;
        }),
    };

    const settings = (isEnabled: boolean) =>
      ({
        experimental: {
          claudeAccountProfiles: { enabled: isEnabled, autoswitchPath: "", shortLabels: {} },
        },
      }) as unknown as ServerSettings;

    const shell = {
      modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" },
      runtimeMode: "full-access",
      interactionMode: "default",
    } as unknown as OrchestrationThreadShell;

    const layer = ClaudeAccountsServiceLayer.layer.pipe(
      Layer.provide(ThreadClaudeAccountRepo.layer),
      Layer.provide(MigrationsLive),
      Layer.provide(SqlitePersistenceMemory),
      Layer.provide(Layer.succeed(ClaudeAutoswitchClient, client)),
      Layer.provide(
        Layer.mock(ServerSettingsService)({
          getSettings: Ref.get(enabled).pipe(Effect.map(settings)),
        }),
      ),
      Layer.provide(
        Layer.mock(ProviderService)({
          stopSession: (input) =>
            Effect.sync(() => {
              stoppedThreads.push(input.threadId);
            }),
          listSessions: () => Effect.succeed(options.liveSessions ?? []),
          streamEvents: Stream.never,
        }),
      ),
      Layer.provide(
        Layer.mock(OrchestrationEngineService)({
          dispatch: (command) =>
            Effect.sync(() => {
              dispatched.push(command);
              return { sequence: dispatched.length };
            }),
        }),
      ),
      Layer.provide(
        Layer.mock(ProjectionSnapshotQuery)({
          getThreadShellById: () => Effect.succeed(Option.some(shell)),
        }),
      ),
      Layer.provide(NodeServices.layer),
    );

    return { layer, placeCalls, hardLimitCalls, stoppedThreads, dispatched, enabled };
  });

describe("ClaudeAccountsService placement", () => {
  it.effect("places a new Auto thread once and then sticks to that account", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* Effect.gen(function* () {
        const service = yield* ClaudeAccountsService;
        yield* service.refreshStatus();
        const threadId = ThreadId.make("thread-sticky");

        const first = yield* service.resolveForSession(threadId);
        assert.equal(first?.profile, "tushar");
        assert.equal(first?.dir, profileDir("tushar"));
        assert.equal(first?.reason, "fewest sessions");

        const second = yield* service.resolveForSession(threadId);
        assert.equal(second?.profile, "tushar");
        assert.equal(second?.reason, "sticky");
        assert.equal(harness.placeCalls.length, 1);

        const view = yield* service.getThread(threadId);
        assert.equal(view.resolvedProfile, "tushar");
        assert.deepEqual(view.mode, { kind: "auto" });
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("spreads a burst of ten Auto placements 4/3/3 from the pending counts it reports", () =>
    Effect.gen(function* () {
      const status = switcherStatus([
        switcherProfile("a"),
        switcherProfile("b", { rank: 2, elected: false }),
        switcherProfile("c", { rank: 3, elected: false }),
      ]);
      const harness = yield* makeHarness({ status });
      yield* Effect.gen(function* () {
        const service = yield* ClaudeAccountsService;
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
        // The tenth call saw every earlier placement as pending.
        assert.deepEqual(harness.placeCalls[9]!.pending, { a: 3, b: 3, c: 3 });
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("pins a thread to the chosen account without asking the switcher", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* Effect.gen(function* () {
        const service = yield* ClaudeAccountsService;
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
        assert.equal(harness.placeCalls.length, 0);
        assert.equal((yield* service.getThread(threadId)).resolvedProfile, "agent");
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("fails a start on a pinned account that is logged out, with a clear message", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* Effect.gen(function* () {
        const service = yield* ClaudeAccountsService;
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
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("rejects a pin to an account the switcher does not list", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* Effect.gen(function* () {
        const service = yield* ClaudeAccountsService;
        yield* service.refreshStatus();
        const result = yield* service
          .setThreadMode({
            threadId: ThreadId.make("thread-unknown-pin"),
            mode: { kind: "profile", profile: "nobody" },
          })
          .pipe(Effect.result);
        assert.equal(result._tag, "Failure");
        if (result._tag === "Failure") assert.equal(result.failure.reason, "invalid");
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect(
    "re-places a thread whose account was marked exhausted and tells the switcher to avoid it",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* Effect.gen(function* () {
          const service = yield* ClaudeAccountsService;
          yield* service.refreshStatus();
          const threadId = ThreadId.make("thread-exhausted");
          const first = yield* service.resolveForSession(threadId);
          assert.equal(first?.profile, "tushar");

          yield* service.markExhausted("tushar", "2026-10-02T12:00:00.000Z");
          const moved = yield* service.reassign(threadId, { avoid: ["tushar"] });
          assert.equal(moved?.profile, "agent");
          assert.include(harness.placeCalls[1]!.avoid, "tushar");

          // Another thread still on the exhausted account is re-placed at its next start.
          const other = ThreadId.make("thread-exhausted-other");
          yield* service.setThreadMode({ threadId: other, mode: { kind: "auto" } });
          const otherResolution = yield* service.resolveForSession(other);
          assert.equal(otherResolution?.profile, "agent");
          assert.include(harness.placeCalls[2]!.avoid, "tushar");

          const snapshot = yield* service.snapshot();
          const tushar = snapshot.profiles.find((profile) => profile.name === "tushar");
          assert.equal(tushar?.eligible, false);
          assert.match(tushar?.why ?? "", /until 12:00 UTC/);
        }).pipe(Effect.provide(harness.layer));
      }),
  );

  it.effect("fails a start when no account has headroom, naming the first reset", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        place: () => ({
          status: "no_eligible_profile",
          chosen: null,
          dir: null,
          reason: "all over limit",
          recovers_at: "2026-10-02T14:30:00Z",
        }),
      });
      yield* Effect.gen(function* () {
        const service = yield* ClaudeAccountsService;
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
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("leaves the environment alone while the feature is off", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ enabled: false });
      yield* Effect.gen(function* () {
        const service = yield* ClaudeAccountsService;
        const resolution = yield* service.resolveForSession(ThreadId.make("thread-off"));
        assert.equal(resolution, undefined);
        assert.equal(harness.placeCalls.length, 0);
        const snapshot = yield* service.snapshot();
        assert.deepEqual(
          { enabled: snapshot.enabled, available: snapshot.available, profiles: snapshot.profiles },
          { enabled: false, available: false, profiles: [] },
        );
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("reports the switcher as unavailable and still answers the snapshot", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ statusUnavailable: true });
      yield* Effect.gen(function* () {
        const service = yield* ClaudeAccountsService;
        yield* service.refreshStatus();
        const snapshot = yield* service.snapshot();
        assert.equal(snapshot.enabled, true);
        assert.equal(snapshot.available, false);
        assert.equal(snapshot.unavailableReason, "old switcher");
        assert.deepEqual(snapshot.profiles, []);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("returns the Auto default for a thread without a row", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* Effect.gen(function* () {
        const service = yield* ClaudeAccountsService;
        const threadId = ThreadId.make("thread-no-row");
        assert.deepEqual(yield* service.getThread(threadId), { threadId, mode: { kind: "auto" } });
      }).pipe(Effect.provide(harness.layer));
    }),
  );
});

describe("ClaudeAccountsService mode changes on a live session", () => {
  const liveSession = (threadId: ThreadId, status: ProviderSession["status"]): ProviderSession =>
    ({
      provider: "claudeAgent",
      status,
      runtimeMode: "full-access",
      threadId,
      createdAt: "2026-10-02T08:00:00.000Z",
      updatedAt: "2026-10-02T08:00:00.000Z",
    }) as unknown as ProviderSession;

  it.effect("stops an idle session at once so the next turn respawns on the new account", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-idle-switch");
      const harness = yield* makeHarness({ liveSessions: [liveSession(threadId, "ready")] });
      yield* Effect.gen(function* () {
        const service = yield* ClaudeAccountsService;
        yield* service.refreshStatus();
        yield* service.resolveForSession(threadId);
        const view = yield* service.setThreadMode({
          threadId,
          mode: { kind: "profile", profile: "agent" },
        });
        assert.deepEqual(harness.stoppedThreads, [threadId]);
        assert.notEqual(view.pendingRestart, true);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("defers the restart while a turn is running and publishes the pending flag", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-busy-switch");
      const harness = yield* makeHarness({ liveSessions: [liveSession(threadId, "running")] });
      yield* Effect.gen(function* () {
        const service = yield* ClaudeAccountsService;
        yield* service.refreshStatus();
        yield* service.resolveForSession(threadId);
        const view = yield* service.setThreadMode({
          threadId,
          mode: { kind: "profile", profile: "agent" },
        });
        assert.equal(view.pendingRestart, true);
        assert.deepEqual(harness.stoppedThreads, []);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("keeps the current account when Auto is chosen from a pin and it is still usable", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-pin-to-auto");
      const harness = yield* makeHarness({ liveSessions: [liveSession(threadId, "ready")] });
      yield* Effect.gen(function* () {
        const service = yield* ClaudeAccountsService;
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
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("streams the thread's account: the current value first, then every change", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-watch");
      const harness = yield* makeHarness();
      yield* Effect.gen(function* () {
        const service = yield* ClaudeAccountsService;
        const seen = yield* Queue.unbounded<ThreadClaudeAccount>();
        yield* service.watchThread(threadId).pipe(
          Stream.runForEach((view) => Queue.offer(seen, view)),
          Effect.forkChild,
        );
        // The initial value proves the subscription is in place before the writes.
        const initial = yield* Queue.take(seen);
        assert.deepEqual(initial, { threadId, mode: { kind: "auto" } });

        yield* service.setThreadMode({ threadId, mode: { kind: "profile", profile: "agent" } });
        const afterSet = yield* Queue.take(seen);
        assert.deepEqual(afterSet.mode, { kind: "profile", profile: "agent" });
        assert.equal(afterSet.resolvedProfile, undefined);

        yield* service.resolveForSession(threadId);
        const afterResolve = yield* Queue.take(seen);
        assert.equal(afterResolve.resolvedProfile, "agent");
      }).pipe(Effect.provide(harness.layer));
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

  it.effect("sets CLAUDE_CONFIG_DIR to the resolved account while the service is live", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* Effect.gen(function* () {
        const service = yield* ClaudeAccountsService;
        yield* service.refreshStatus();
        const threadId = ThreadId.make("thread-apply");
        yield* service.setThreadMode({ threadId, mode: { kind: "profile", profile: "agent" } });
        const result = yield* applyClaudeAccountProfile(threadId, environment);
        assert.equal(result.CLAUDE_CONFIG_DIR, profileDir("agent"));
        assert.equal(result.PATH, "/usr/bin");
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("is a no-op while the feature is disabled", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ enabled: false });
      yield* Effect.gen(function* () {
        const result = yield* applyClaudeAccountProfile(
          ThreadId.make("thread-apply-off"),
          environment,
        );
        assert.deepEqual(result, environment);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("turns a policy failure into the adapter's validation error", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* Effect.gen(function* () {
        const service = yield* ClaudeAccountsService;
        yield* service.refreshStatus();
        const threadId = ThreadId.make("thread-apply-logged-out");
        yield* service.setThreadMode({ threadId, mode: { kind: "profile", profile: "sam" } });
        const result = yield* applyClaudeAccountProfile(threadId, environment).pipe(Effect.result);
        assert.equal(result._tag, "Failure");
        if (result._tag === "Failure") {
          assert.instanceOf(result.failure, ProviderAdapterValidationError);
          assert.match(result.failure.issue, /logged out/);
        }
      }).pipe(Effect.provide(harness.layer));
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
        }),
      ),
  );

  it.effect("degrades to the account the active link points at, and stays sticky on it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "claude-accounts-" });
      const target = `${root}/.claude-profiles/agent`;
      yield* fs.makeDirectory(target, { recursive: true });
      const link = `${root}/.claude-active`;
      yield* fs.symlink(target, link);
      yield* withActiveLink(
        link,
        Effect.gen(function* () {
          const harness = yield* makeHarness({ placeUnavailable: true });
          yield* Effect.gen(function* () {
            const service = yield* ClaudeAccountsService;
            yield* service.refreshStatus();
            const threadId = ThreadId.make("thread-apply-link");
            const first = yield* service.resolveForSession(threadId);
            assert.equal(first?.profile, "agent");
            assert.equal(first?.reason, "active-link");
            const second = yield* service.resolveForSession(threadId);
            assert.equal(second?.reason, "sticky");
            assert.equal(harness.placeCalls.length, 1);
          }).pipe(Effect.provide(harness.layer));
        }),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe("ClaudeAccountsService hard limits", () => {
  it.effect("moves an Auto thread, stops its session and dispatches one continue turn", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* Effect.gen(function* () {
        const service = yield* ClaudeAccountsService;
        yield* service.refreshStatus();
        const threadId = ThreadId.make("thread-hard-limit-auto");
        yield* service.resolveForSession(threadId);

        const handled = yield* service.handleHardLimit({
          threadId,
          rateLimitType: "five_hour",
          resetAt: 1_790_000_000,
        });
        assert.isTrue(handled);
        assert.deepEqual(harness.hardLimitCalls, [{ type: "five_hour", profile: "tushar" }]);
        assert.deepEqual(harness.stoppedThreads, [threadId]);
        assert.equal(harness.dispatched.length, 1);
        const command = harness.dispatched[0]!;
        assert.equal(command.type, "thread.turn.start");
        if (command.type === "thread.turn.start") {
          assert.equal(
            command.message.text,
            "Continue where you left off — this thread moved to Claude account agent because tushar hit its usage limit.",
          );
        }
        assert.equal((yield* service.getThread(threadId)).resolvedProfile, "agent");

        // The same rejection again is consumed once.
        yield* service.handleHardLimit({
          threadId,
          rateLimitType: "five_hour",
          resetAt: 1_790_000_000,
        });
        assert.equal(harness.hardLimitCalls.length, 1);
        assert.equal(harness.dispatched.length, 1);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("leaves a pinned thread in place with a notice", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* Effect.gen(function* () {
        const service = yield* ClaudeAccountsService;
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
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("declines the rejection while the feature is off", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ enabled: false });
      yield* Effect.gen(function* () {
        const service = yield* ClaudeAccountsService;
        const handled = yield* service.handleHardLimit({
          threadId: ThreadId.make("thread-hard-limit-off"),
          rateLimitType: "five_hour",
          resetAt: undefined,
        });
        assert.isFalse(handled);
        assert.deepEqual(harness.hardLimitCalls, []);
      }).pipe(Effect.provide(harness.layer));
    }),
  );
});
