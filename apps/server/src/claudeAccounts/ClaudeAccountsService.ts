/**
 * T3-CUSTOM(expbkt3): Claude account profiles per thread.
 *
 * One service owns the whole feature on the server:
 *
 * - the **host snapshot**: `claude-autoswitch --status --json`, polled about
 *   every 15 s while the setting is on (at once when it turns on), overlaid
 *   with the live `rate_limit_event` windows Claude streams mid-turn, published
 *   to `subscribeClaudeAccounts`;
 * - **placement**: `resolveForSession` runs inside `ClaudeAdapter.startSession`
 *   (through `applyClaudeAccountProfile`) and decides which config directory
 *   the spawned CLI gets — a pinned account, the account the thread already
 *   runs on (sticky, so one thread does not hop accounts), or `--place` for a new one;
 * - **mode changes** from the composer, restarting an idle session at once and a
 *   busy one once its turn ends and nothing new has started;
 * - the **hard-limit path**: an account-wide rejection (`five_hour`,
 *   `seven_day`) marks the account exhausted and moves every Auto thread off
 *   it as they start; a model-scoped one (`seven_day_opus`, …) moves only the
 *   affected Auto thread. Pinned threads get a notice instead. An Auto
 *   thread whose window resets within five minutes keeps its account: the
 *   session stops and the thread continues there once the window resets;
 * - **access per user**: an account with no users assigned is open to
 *   everyone; once an admin assigns users, only they may use it. Placement
 *   avoids the accounts the thread's owner may not use, a pin to one fails,
 *   and each connection's snapshot shows only the accounts its user may use
 *   (admins see every account, flagged).
 *
 * The switcher is the only ranker. Nothing here reads credentials.
 */
import * as NodeOS from "node:os";

import {
  type ClaudeAccountAccessList,
  type ClaudeAccountMode,
  type ClaudeAccountStatus,
  type ClaudeAccountWindow,
  type ClaudeAccountsSnapshot,
  ClaudeAccountsError,
  CommandId,
  MessageId,
  type OrchestrationEvent,
  type OrchestrationSession,
  type ProviderRuntimeEvent,
  type ThreadClaudeAccount,
  type ThreadId,
  type UserId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Random from "effect/Random";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { OrchestrationEngineService } from "../orchestration-v2/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration-v2/Services/ProjectionSnapshotQuery.ts";
import { ClaudeAccountProfileAccessRepository } from "../persistence/ClaudeAccountProfileAccess.ts";
import {
  type ThreadClaudeAccountRow,
  ThreadClaudeAccountRepository,
} from "../persistence/ThreadClaudeAccount.ts";
import { ForkProviderSessions as ProviderService } from "../provider/ForkProviderSessions.expbkt3.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  ClaudeAccountPolicyError,
  type ClaudeAccountResolution,
  registerClaudeAccountResolver,
} from "./applyClaudeAccountProfile.ts";
import {
  type ClaudeAutoswitchFailure,
  ClaudeAutoswitchClient,
  type SwitcherProfile,
  type SwitcherStatus,
} from "./ClaudeAutoswitchClient.ts";
import {
  type ClaudeHardLimitCondition,
  registerClaudeHardLimitAccountsHook,
} from "./hardLimitHook.ts";
import { computeShortLabels } from "./shortLabels.ts";

export const STATUS_POLL_INTERVAL_MS = 15_000;
/** The poll is jittered by up to this much either way so several servers do not align. */
export const STATUS_POLL_JITTER_MS = 3_000;
/** A placement counts as pending — not yet visible in the switcher's session count — for this long. */
const PENDING_PLACEMENT_WINDOW_MS = 90_000;
/** How long an exhausted mark lasts when Claude did not say when the window resets. */
const DEFAULT_EXHAUSTED_MS = 60 * 60 * 1000;
const MAX_HANDLED_CONDITIONS = 256;
/** A limit that resets within this long is waited out on the same account instead of moving. */
export const RESET_WAIT_THRESHOLD_MS = 5 * 60 * 1000;
/** Margin after the reset so the status poll sees the account free before the thread continues. */
export const RESET_WAIT_BUFFER_MS = 60 * 1000;
const SNAPSHOT_CHANGE = "\u0000snapshot";
/** The fields the CLI's `sessions/<pid>.json` carries that the live-session index needs. */
const decodeSessionFile = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      pid: Schema.Number,
      sessionId: Schema.String,
      procStart: Schema.optionalKey(Schema.Unknown),
    }),
  ),
);

const sameThreadAccount = (left: ThreadClaudeAccount, right: ThreadClaudeAccount): boolean =>
  left.threadId === right.threadId &&
  left.mode.kind === right.mode.kind &&
  (left.mode.kind === "auto" ||
    (right.mode.kind === "profile" && left.mode.profile === right.mode.profile)) &&
  left.resolvedProfile === right.resolvedProfile &&
  left.resolvedAt === right.resolvedAt &&
  left.notice === right.notice &&
  left.pendingRestart === right.pendingRestart;

/** Published after each status read: watched threads re-read their observed account. */
const LIVE_SESSIONS_CHANGE = "\u0000live-sessions";
/** Reported while the first `--status` answer is still on its way. */
export const LOADING_REASON = "loading";

/** The two account-wide windows. Every other type is scoped to a model or to overage. */
const ACCOUNT_WIDE_LIMIT_TYPES: ReadonlySet<string> = new Set(["five_hour", "seven_day"]);

export interface ClaudeAccountProfilesSettingsView {
  readonly enabled: boolean;
  readonly autoswitchPath: string;
  readonly shortLabels: Readonly<Record<string, string>>;
}

/** Who a snapshot is for. A null user (the local operator) sees and may use everything. */
export interface ClaudeAccountsViewer {
  readonly userId: UserId | null;
  readonly isAdmin: boolean;
}

export interface ClaudeAccountsServiceShape {
  readonly getThread: (
    threadId: ThreadId,
  ) => Effect.Effect<ThreadClaudeAccount, ClaudeAccountsError>;
  /** `actorUserId` is the caller; a pin they (or the thread's owner) may not use is `forbidden`. */
  readonly setThreadMode: (input: {
    readonly threadId: ThreadId;
    readonly mode: ClaudeAccountMode;
    readonly actorUserId?: UserId | null;
  }) => Effect.Effect<ThreadClaudeAccount, ClaudeAccountsError>;
  /** The host-wide snapshot, unfiltered. */
  readonly snapshot: () => Effect.Effect<ClaudeAccountsSnapshot>;
  /** Live snapshots; with a viewer, narrowed to what that user may use. */
  readonly watchSnapshot: (
    viewer?: ClaudeAccountsViewer,
  ) => Stream.Stream<ClaudeAccountsSnapshot, ClaudeAccountsError>;
  /** Every account's allow list. Callers check the admin gate. */
  readonly listAccess: () => Effect.Effect<ClaudeAccountAccessList, ClaudeAccountsError>;
  /** Replaces one account's allow list; empty opens it. Callers check the admin gate. */
  readonly setAccess: (input: {
    readonly profile: string;
    readonly userIds: ReadonlyArray<UserId>;
    readonly actorUserId: UserId | null;
  }) => Effect.Effect<ClaudeAccountAccessList, ClaudeAccountsError>;
  readonly watchThread: (
    threadId: ThreadId,
  ) => Stream.Stream<ThreadClaudeAccount, ClaudeAccountsError>;
  /** Picks the account for a spawn. `undefined` leaves the environment alone. */
  readonly resolveForSession: (
    threadId: ThreadId,
  ) => Effect.Effect<ClaudeAccountResolution | undefined, ClaudeAccountPolicyError>;
  /** Re-reads `--status --json` now; the poller calls this on its own schedule. */
  readonly refreshStatus: () => Effect.Effect<void>;
  readonly markExhausted: (profile: string, resetsAt: string | undefined) => Effect.Effect<void>;
  /** Places the thread again, avoiding the given accounts, and persists the result. */
  readonly reassign: (
    threadId: ThreadId,
    input: { readonly avoid: ReadonlyArray<string> },
  ) => Effect.Effect<ClaudeAccountResolution | undefined, ClaudeAccountPolicyError>;
  /** The hard-limit hook; `false` means the feature is off and the caller keeps its own path. */
  readonly handleHardLimit: (condition: ClaudeHardLimitCondition) => Effect.Effect<boolean>;
}

export class ClaudeAccountsService extends Context.Service<
  ClaudeAccountsService,
  ClaudeAccountsServiceShape
>()("t3/claudeAccounts/ClaudeAccountsService") {}

interface WindowOverlay {
  readonly atMs: number;
  readonly fiveHour?: ClaudeAccountWindow;
  readonly weekly?: ClaudeAccountWindow;
}

interface ExhaustedMark {
  readonly untilMs: number;
  readonly resetsAt: string | undefined;
}

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

function isoOrUndefined(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const parsed = DateTime.make(value);
  return Option.isSome(parsed) ? DateTime.formatIso(parsed.value) : undefined;
}

function isoFromUnixSeconds(seconds: number): string | undefined {
  const parsed = DateTime.make(seconds * 1000);
  return Option.isSome(parsed) ? DateTime.formatIso(parsed.value) : undefined;
}

export function formatResetClock(iso: string | undefined): string {
  const parsed = iso === undefined ? Option.none() : DateTime.make(iso);
  if (Option.isNone(parsed)) return "an unknown time";
  const parts = DateTime.toPartsUtc(parsed.value);
  const hh = String(parts.hour).padStart(2, "0");
  const mm = String(parts.minute).padStart(2, "0");
  return `${hh}:${mm} UTC`;
}

/** Human name for a model- or overage-scoped limit type (`seven_day_opus` → `Opus weekly`). */
export function scopedLimitLabel(rateLimitType: string): string {
  if (rateLimitType === "overage") return "overage";
  const scoped = /^seven_day_(.+)$/.exec(rateLimitType);
  if (scoped?.[1]) {
    const model = scoped[1].replace(/_/g, " ");
    return `${model.charAt(0).toUpperCase()}${model.slice(1)} weekly`;
  }
  return rateLimitType.replace(/_/g, " ");
}

function windowFrom(
  raw: { readonly used?: number | null; readonly resets_at?: string | null } | null | undefined,
): ClaudeAccountWindow | undefined {
  if (!raw || typeof raw.used !== "number") return undefined;
  const resetsAt = isoOrUndefined(raw.resets_at);
  return { usedPercent: clampPercent(raw.used), ...(resetsAt ? { resetsAt } : {}) };
}

/**
 * `default` lives at `~/.claude`; every other account under the profile root,
 * `~/.claude-profiles/<name>` unless `CLAUDE_PROFILE_ROOT` names another (the
 * same variable `claude-profile` and `claude-autoswitch` honour).
 */
export function defaultProfileDir(path: Path.Path, profile: string): string {
  const home = NodeOS.homedir();
  if (profile === "default") return path.join(home, ".claude");
  const root = process.env.CLAUDE_PROFILE_ROOT?.trim() || path.join(home, ".claude-profiles");
  return path.join(root, profile);
}

function activeLinkPath(path: Path.Path): string {
  return process.env.T3_CLAUDE_ACTIVE_LINK?.trim() || path.join(NodeOS.homedir(), ".claude-active");
}

/** The user-facing reason never carries the binary path or a traceback; the log does. */
function shortUnavailableReason(failure: ClaudeAutoswitchFailure): string {
  return failure.kind === "unavailable"
    ? "claude-autoswitch is missing or too old for per-thread placement"
    : "claude-autoswitch failed; see the server log";
}

export const make = Effect.gen(function* () {
  const repository = yield* ThreadClaudeAccountRepository;
  const accessRepository = yield* ClaudeAccountProfileAccessRepository;
  const client = yield* ClaudeAutoswitchClient;
  const settingsService = yield* ServerSettingsService;
  const providers = yield* ProviderService;
  const dispatcher = yield* OrchestrationEngineService;
  const query = yield* ProjectionSnapshotQuery;
  const crypto = yield* Crypto.Crypto;
  const path = yield* Path.Path;
  const fileSystem = yield* FileSystem.FileSystem;
  const uuid = crypto.randomUUIDv4.pipe(Effect.orDie);

  /** The account `~/.claude-active` points at today — the degraded answer when the switcher cannot place. */
  const currentProfileFromActiveLink: Effect.Effect<ClaudeAccountResolution | undefined> =
    // Suspended so the link location (`T3_CLAUDE_ACTIVE_LINK`) is read per call.
    Effect.suspend(() => fileSystem.realPath(activeLinkPath(path))).pipe(
      Effect.map((dir) => {
        const resolved = path.resolve(dir);
        const profile =
          resolved === path.resolve(NodeOS.homedir(), ".claude")
            ? "default"
            : path.basename(resolved);
        return profile
          ? ({ profile, dir: resolved, mode: "auto", reason: "active-link" } as const)
          : undefined;
      }),
      Effect.orElseSucceed(() => undefined),
    );

  // Host state. The switcher's last answer, the live windows Claude streamed
  // since, and the accounts a hard limit took out of rotation.
  let lastStatus: SwitcherStatus | undefined;
  let lastStatusAtMs = 0;
  let firstPollDone = false;
  let unavailableReason: string | undefined;
  const overlays = new Map<string, WindowOverlay>();
  const exhausted = new Map<string, ExhaustedMark>();
  const pendingPlacements: Array<{ readonly profile: string; readonly atMs: number }> = [];
  // Per-thread state the row does not carry.
  const threadProfiles = new Map<ThreadId, string>();
  const notices = new Map<ThreadId, string>();
  const pendingRestart = new Set<ThreadId>();
  /** Threads with a turn in flight, as seen on the provider event bus. */
  const activeTurns = new Set<ThreadId>();
  /**
   * Threads a hard limit just moved, until their first turn starts on the new
   * account. Rejections that arrive in between are stale copies from the old
   * session: the new account has not been asked anything yet.
   */
  const movedAwaitingTurn = new Set<ThreadId>();
  const handledConditions = new Set<string>();
  /**
   * Auto threads waiting out a window that resets soon, each with the timer
   * that continues it. A thread leaves the set just before its continue turn
   * is sent, so that turn's own start does not cancel anything.
   */
  const waitingForReset = new Set<ThreadId>();
  const resetWaits = yield* FiberMap.make<ThreadId>();
  /**
   * Live Claude session id -> the account it runs on, from each account's
   * `sessions/<pid>.json` (the CLI writes one at start and never removes it).
   * Lets a thread whose session started before placement, on the shared
   * link, show the account it really runs on. Rebuilt on every status read.
   */
  let liveSessionProfiles = new Map<string, string>();

  const changes = yield* PubSub.unbounded<string>();
  const announce = (key: string) => PubSub.publish(changes, key).pipe(Effect.ignore);
  const announceSnapshot = announce(SNAPSHOT_CHANGE);
  const placementLock = yield* Semaphore.make(1);

  const readSettings: Effect.Effect<ClaudeAccountProfilesSettingsView> =
    settingsService.getSettings.pipe(
      Effect.map((settings) => settings.experimental.claudeAccountProfiles),
      Effect.orElseSucceed((): ClaudeAccountProfilesSettingsView => ({
        enabled: false,
        autoswitchPath: "",
        shortLabels: {},
      })),
    );

  const internal = (operation: string) => (cause: unknown) =>
    new ClaudeAccountsError({
      operation,
      reason: "internal",
      detail: cause instanceof Error ? cause.message : String(cause),
    });

  // ------------------------------------------------------------------ access

  /**
   * Allow lists by account, read once and kept until an admin changes them
   * (this server is the table's only writer). The generation stops a read
   * that started before a write from caching what the write replaced.
   */
  let accessCache: ReadonlyMap<string, ReadonlySet<UserId>> | undefined;
  let accessGeneration = 0;

  const accessMap = Effect.gen(function* () {
    if (accessCache !== undefined) return accessCache;
    const generation = accessGeneration;
    const entries = yield* accessRepository.listAll();
    const next: ReadonlyMap<string, ReadonlySet<UserId>> = new Map(
      entries.map((entry) => [entry.profile, new Set(entry.userIds)] as const),
    );
    if (generation === accessGeneration) accessCache = next;
    return next;
  });

  /** Open accounts (no users assigned) admit everyone; a null user is the unrestricted local operator. */
  const mayUse = (
    access: ReadonlyMap<string, ReadonlySet<UserId>>,
    userId: UserId | null,
    profile: string,
  ): boolean => userId === null || (access.get(profile)?.has(userId) ?? true);

  const noAccessDetail = (profile: string) =>
    `You don't have access to Claude account ${profile} — ask an admin or switch to Auto.`;

  /**
   * The user a thread's sessions run for: its owner, or nobody (unrestricted)
   * when the thread has no shell yet (a draft). A failed read is an error,
   * never "nobody": that would wave a restricted owner through.
   */
  const threadOwner = (threadId: ThreadId) =>
    query
      .getThreadShellById(threadId)
      .pipe(Effect.map((shell) => (Option.isSome(shell) ? shell.value.ownerUserId : null)));

  interface Restriction {
    readonly owner: UserId | null;
    /** The accounts the owner may not use; empty when unrestricted. */
    readonly disallowed: ReadonlySet<string>;
  }
  const UNRESTRICTED: Restriction = { owner: null, disallowed: new Set() };
  const isRestricted = (restriction: Restriction) =>
    restriction.owner !== null && restriction.disallowed.size > 0;

  /** Who the thread's sessions run for and what they may not use. Fails closed on any read error. */
  const disallowedFor = (
    threadId: ThreadId,
  ): Effect.Effect<Restriction, ClaudeAccountPolicyError> =>
    Effect.gen(function* () {
      const access = yield* accessMap;
      // Nothing is restricted until an admin assigns someone, so skip the owner read.
      if (access.size === 0) return UNRESTRICTED;
      const owner = yield* threadOwner(threadId);
      if (owner === null) return UNRESTRICTED;
      const disallowed = new Set<string>();
      for (const profile of access.keys()) {
        if (!mayUse(access, owner, profile)) disallowed.add(profile);
      }
      return { owner, disallowed };
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ClaudeAccountPolicyError({
            threadId,
            detail: `Could not check Claude account access — try again shortly. (${cause.message})`,
          }),
      ),
    );

  /** Whether every account the switcher lists is one the owner may not use. */
  const mayUseNone = (restriction: Restriction): boolean =>
    isRestricted(restriction) &&
    lastStatus !== undefined &&
    lastStatus.profiles.length > 0 &&
    lastStatus.profiles.every((profile) => restriction.disallowed.has(profile.name));

  const noAccountPolicyError = (threadId: ThreadId) =>
    new ClaudeAccountPolicyError({
      threadId,
      detail: "You don't have access to any Claude account — ask an admin to give you one.",
    });

  const accessList: Effect.Effect<ClaudeAccountAccessList, ClaudeAccountsError> = accessMap.pipe(
    Effect.map((access) => ({
      entries: [...access]
        .map(([profile, users]) => ({
          profile,
          userIds: [...users].toSorted(),
        }))
        .toSorted((left, right) => left.profile.localeCompare(right.profile)),
    })),
    Effect.mapError(internal("listAccess")),
  );

  // ---------------------------------------------------------------- snapshot

  const pruneExhausted = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    for (const [profile, mark] of exhausted) {
      if (mark.untilMs <= now) exhausted.delete(profile);
    }
  });

  const knownProfile = (profile: string): SwitcherProfile | undefined =>
    lastStatus?.profiles.find((candidate) => candidate.name === profile);

  const liveWindow = (
    profile: string,
    key: "fiveHour" | "weekly",
    raw: ClaudeAccountWindow | undefined,
  ): ClaudeAccountWindow | undefined => {
    const overlay = overlays.get(profile);
    if (overlay !== undefined && overlay.atMs > lastStatusAtMs && overlay[key] !== undefined) {
      return overlay[key];
    }
    return raw;
  };

  const overHardLimit = (profile: string): boolean => {
    const known = knownProfile(profile);
    const fiveHour = liveWindow(profile, "fiveHour", windowFrom(known?.five_hour));
    const weekly = liveWindow(profile, "weekly", windowFrom(known?.weekly));
    return (fiveHour?.usedPercent ?? 0) >= 100 || (weekly?.usedPercent ?? 0) >= 100;
  };

  const profileDir = (profile: string): string => {
    const known = knownProfile(profile);
    return known?.dir ? known.dir : defaultProfileDir(path, profile);
  };

  /**
   * Whether the account still exists: listed by the switcher (when it has
   * answered) and backed by a config directory. A stale name must never reach
   * `CLAUDE_CONFIG_DIR`, where the CLI would create an empty, signed-out home.
   */
  const profileExists = (profile: string): Effect.Effect<boolean> =>
    Effect.gen(function* () {
      if (lastStatus !== undefined && knownProfile(profile) === undefined) return false;
      return yield* fileSystem.exists(profileDir(profile)).pipe(Effect.orElseSucceed(() => false));
    });

  /** Whether an existing thread may keep running on this account. Unknown accounts are trusted. */
  const usable = (profile: string): boolean => {
    if (exhausted.has(profile)) return false;
    const known = knownProfile(profile);
    if (known === undefined) return true;
    if (known.auth?.state === "logged_out") return false;
    return !overHardLimit(profile);
  };

  const usableAndPresent = (profile: string): Effect.Effect<boolean> =>
    usable(profile) ? profileExists(profile) : Effect.succeed(false);

  const toStatus = (raw: SwitcherProfile, shortLabel: string): ClaudeAccountStatus => {
    const mark = exhausted.get(raw.name);
    const fiveHour = liveWindow(raw.name, "fiveHour", windowFrom(raw.five_hour));
    const weekly = liveWindow(raw.name, "weekly", windowFrom(raw.weekly));
    const scopedUsed = raw.scoped?.used;
    const scopedResets = isoOrUndefined(raw.scoped?.resets_at);
    const authState = raw.auth?.state;
    const rank = raw.rank;
    const sessions = raw.sessions;
    const ageSec = raw.age_sec;
    return {
      name: raw.name,
      shortLabel,
      ...(raw.email_masked ? { emailMasked: raw.email_masked } : {}),
      ...(typeof rank === "number" && Number.isInteger(rank) && rank >= 0 ? { rank } : {}),
      eligible: mark === undefined && (raw.eligible ?? false) && authState !== "logged_out",
      why:
        mark !== undefined
          ? `at its usage limit until ${formatResetClock(mark.resetsAt)}`
          : (raw.why ?? ""),
      elected: raw.elected ?? false,
      auth: authState === "ok" || authState === "logged_out" ? authState : "unknown",
      ...(fiveHour ? { fiveHour } : {}),
      ...(weekly ? { weekly } : {}),
      ...(typeof scopedUsed === "number"
        ? {
            scoped: {
              label: raw.scoped?.label ?? "scoped",
              usedPercent: clampPercent(scopedUsed),
              ...(scopedResets ? { resetsAt: scopedResets } : {}),
            },
          }
        : {}),
      sessions:
        typeof sessions === "number" && Number.isInteger(sessions) && sessions >= 0 ? sessions : 0,
      ...(typeof ageSec === "number" && Number.isFinite(ageSec) ? { ageSec } : {}),
    };
  };

  const snapshot: ClaudeAccountsServiceShape["snapshot"] = () =>
    Effect.gen(function* () {
      const settings = yield* readSettings;
      const generatedAt = yield* nowIso;
      if (!settings.enabled) {
        return { enabled: false, available: false, generatedAt, profiles: [] };
      }
      yield* pruneExhausted;
      if (lastStatus === undefined) {
        // Before the first answer the control is usable but empty; afterwards
        // a missing status means the switcher could not be read.
        return firstPollDone
          ? {
              enabled: true,
              available: false,
              ...(unavailableReason ? { unavailableReason } : {}),
              generatedAt,
              profiles: [],
            }
          : {
              enabled: true,
              available: true,
              unavailableReason: LOADING_REASON,
              generatedAt,
              profiles: [],
            };
      }
      const labels = computeShortLabels(
        lastStatus.profiles.map((profile) => profile.name),
        settings.shortLabels,
      );
      return {
        enabled: true,
        available: unavailableReason === undefined,
        ...(unavailableReason ? { unavailableReason } : {}),
        generatedAt,
        profiles: lastStatus.profiles.map((profile) =>
          toStatus(profile, labels[profile.name] ?? profile.name),
        ),
      };
    });

  /**
   * Narrows a snapshot to one viewer: admins get every account with an
   * `allowed` flag (they manage access); everyone else only the accounts they
   * may use. A composer pinned to a revoked account still renders its badge
   * from the thread's own row.
   */
  const viewSnapshot = (
    current: ClaudeAccountsSnapshot,
    viewer: ClaudeAccountsViewer | undefined,
  ): Effect.Effect<ClaudeAccountsSnapshot> =>
    Effect.gen(function* () {
      if (viewer === undefined || viewer.userId === null || current.profiles.length === 0) {
        return current;
      }
      const userId = viewer.userId;
      const accessResult = yield* accessMap.pipe(Effect.result);
      if (accessResult._tag === "Failure") {
        yield* Effect.logWarning("claude.account.access-read-failed", {
          cause: accessResult.failure.message,
        });
        return { ...current, profiles: [] };
      }
      const access = accessResult.success;
      return {
        ...current,
        profiles: viewer.isAdmin
          ? current.profiles.map((status) => ({
              ...status,
              allowed: mayUse(access, userId, status.name),
            }))
          : current.profiles.filter((status) => mayUse(access, userId, status.name)),
      };
    });

  /** Field 22 (start time) of /proc/<pid>/stat, or undefined off Linux or when gone. */
  const procStartTime = (pid: number): Effect.Effect<string | undefined> =>
    fileSystem.readFileString(`/proc/${pid}/stat`).pipe(
      Effect.map(
        (raw) =>
          raw
            .slice(raw.lastIndexOf(")") + 1)
            .trim()
            .split(/\s+/)[19],
      ),
      Effect.orElseSucceed(() => undefined),
    );

  const pidAlive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  };

  const indexLiveSessions = (status: SwitcherStatus): Effect.Effect<Map<string, string>> =>
    Effect.gen(function* () {
      const index = new Map<string, string>();
      const hasProc = yield* fileSystem
        .exists("/proc/self/stat")
        .pipe(Effect.orElseSucceed(() => false));
      for (const profile of status.profiles) {
        if (!profile.dir) continue;
        const dir = path.join(profile.dir, "sessions");
        const entries = yield* fileSystem.readDirectory(dir).pipe(Effect.orElseSucceed(() => []));
        for (const entry of entries) {
          const match = /^(\d+)\.json$/.exec(entry);
          if (!match) continue;
          const pid = Number(match[1]);
          if (!pidAlive(pid)) continue;
          const raw = yield* fileSystem
            .readFileString(path.join(dir, entry))
            .pipe(Effect.orElseSucceed(() => ""));
          const decoded = yield* decodeSessionFile(raw).pipe(Effect.option);
          if (Option.isNone(decoded)) continue;
          const parsed = decoded.value;
          if (parsed.pid !== pid) continue;
          // A reused pid belongs to another process: on Linux, the start time must match.
          if (hasProc && String(parsed.procStart) !== (yield* procStartTime(pid))) continue;
          index.set(parsed.sessionId, profile.name);
        }
      }
      return index;
    });

  const adoptStatus = (status: SwitcherStatus) =>
    Effect.gen(function* () {
      lastStatus = status;
      lastStatusAtMs = yield* Clock.currentTimeMillis;
      unavailableReason = undefined;
      // A fresher reading from the switcher supersedes live overlays up to now.
      for (const [profile, overlay] of overlays) {
        if (overlay.atMs <= lastStatusAtMs) overlays.delete(profile);
      }
    });

  const noteFailure = (failure: ClaudeAutoswitchFailure) =>
    Effect.gen(function* () {
      unavailableReason = shortUnavailableReason(failure);
      yield* Effect.logWarning(
        failure.kind === "unavailable"
          ? "claude.account.switcher-unavailable"
          : "claude.account.switcher-failed",
        { detail: failure.detail },
      );
    });

  const refreshStatus: ClaudeAccountsServiceShape["refreshStatus"] = () =>
    Effect.gen(function* () {
      const outcome = yield* client.status();
      if (outcome.kind === "ok") {
        yield* adoptStatus(outcome.value);
      } else {
        yield* noteFailure(outcome);
      }
      firstPollDone = true;
      yield* announceSnapshot;
      // The live-session index reads files, so it runs after the snapshot is
      // out and only tells thread views, which may now show an observed account.
      if (outcome.kind === "ok") {
        liveSessionProfiles = yield* indexLiveSessions(outcome.value);
        yield* announce(LIVE_SESSIONS_CHANGE);
      }
    });

  // Poll only while the setting is on; a disabled feature costs nothing but
  // one settings read per interval, so toggling it needs no restart. The
  // settings stream below wakes the loop as soon as the flag turns on.
  const pollLoop = Effect.gen(function* () {
    let wasEnabled: boolean | undefined;
    while (true) {
      const settings = yield* readSettings;
      if (settings.enabled) {
        yield* refreshStatus();
      } else if (wasEnabled !== false) {
        yield* announceSnapshot;
      }
      wasEnabled = settings.enabled;
      const jitter = yield* Random.nextIntBetween(
        -STATUS_POLL_JITTER_MS,
        STATUS_POLL_JITTER_MS + 1,
      );
      yield* Effect.sleep(Duration.millis(STATUS_POLL_INTERVAL_MS + jitter));
    }
  });

  const refreshOnEnable = settingsService.streamChanges.pipe(
    Stream.map((settings) => settings.experimental.claudeAccountProfiles.enabled),
    Stream.changes,
    Stream.runForEach((enabled) => (enabled ? refreshStatus() : announceSnapshot)),
  );

  // ---------------------------------------------------------------- threads

  const threadView = (row: ThreadClaudeAccountRow): ThreadClaudeAccount => {
    const notice = notices.get(row.threadId);
    return {
      threadId: row.threadId,
      mode: row.mode,
      ...(row.resolvedProfile ? { resolvedProfile: row.resolvedProfile } : {}),
      ...(row.resolvedAt ? { resolvedAt: row.resolvedAt } : {}),
      ...(notice ? { notice } : {}),
      ...(pendingRestart.has(row.threadId) ? { pendingRestart: true } : {}),
    };
  };

  /** The account a thread's live Claude session runs on, read from the session files. */
  const observedProfile = (threadId: ThreadId): Effect.Effect<string | undefined> =>
    Effect.gen(function* () {
      if (liveSessionProfiles.size === 0) return undefined;
      const shell = yield* query
        .getThreadShellById(threadId)
        .pipe(Effect.orElseSucceed(() => Option.none()));
      const sessionId = Option.isSome(shell) ? shell.value.session?.providerThreadId : undefined;
      return sessionId ? liveSessionProfiles.get(sessionId) : undefined;
    });

  const getThread: ClaudeAccountsServiceShape["getThread"] = (threadId) =>
    Effect.gen(function* () {
      const row = yield* repository.get(threadId).pipe(Effect.mapError(internal("getThread")));
      if (row.resolvedProfile || row.mode.kind !== "auto") return threadView(row);
      // A session that started before placement (on the shared link) has no
      // resolved account yet: show the one its live process really uses.
      const observed = yield* observedProfile(threadId);
      if (observed === undefined) return threadView(row);
      threadProfiles.set(threadId, observed);
      return threadView({ ...row, resolvedProfile: observed });
    });

  const persistResolved = (threadId: ThreadId, profile: string) =>
    Effect.gen(function* () {
      const resolvedAt = yield* nowIso;
      threadProfiles.set(threadId, profile);
      yield* repository.setResolved({ threadId, profile, resolvedAt });
      yield* announce(threadId);
    });

  const pendingCounts = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    while (
      pendingPlacements.length > 0 &&
      pendingPlacements[0]!.atMs + PENDING_PLACEMENT_WINDOW_MS <= now
    ) {
      pendingPlacements.shift();
    }
    const counts: Record<string, number> = {};
    for (const placement of pendingPlacements) {
      counts[placement.profile] = (counts[placement.profile] ?? 0) + 1;
    }
    return counts;
  });

  const exhaustedNames = Effect.map(pruneExhausted, () => [...exhausted.keys()]);

  /** The earliest reset among exhausted accounts, skipping those the owner may not use. */
  const firstRecovery = (disallowed: ReadonlySet<string>): string | undefined => {
    let earliest: string | undefined;
    for (const [profile, mark] of exhausted) {
      if (disallowed.has(profile)) continue;
      if (mark.resetsAt && (earliest === undefined || mark.resetsAt < earliest)) {
        earliest = mark.resetsAt;
      }
    }
    return earliest;
  };

  const PLACEMENT_UNAVAILABLE_DETAIL =
    "Claude account placement is unavailable right now and the host's default account is not one you can use — try again shortly.";

  /**
   * What a start gets when placement cannot answer. Unrestricted threads keep
   * the old degraded behaviour (`undefined`: the spawn runs on
   * `~/.claude-active`). A restricted owner never does that blindly: the
   * active link is used only when it is an account they may use.
   */
  const restrictedFallback = (
    threadId: ThreadId,
    restriction: Restriction,
  ): Effect.Effect<ClaudeAccountResolution | undefined, ClaudeAccountPolicyError> =>
    Effect.gen(function* () {
      if (!isRestricted(restriction)) return undefined;
      const fallback = yield* currentProfileFromActiveLink;
      if (fallback !== undefined && !restriction.disallowed.has(fallback.profile)) return fallback;
      return yield* new ClaudeAccountPolicyError({
        threadId,
        detail: PLACEMENT_UNAVAILABLE_DETAIL,
      });
    });

  /** Asks the switcher for an account. Must run under `placementLock`. */
  const placeWith = (
    threadId: ThreadId,
    avoid: ReadonlyArray<string>,
  ): Effect.Effect<ClaudeAccountResolution | undefined, ClaudeAccountPolicyError> =>
    Effect.gen(function* () {
      const pending = yield* pendingCounts;
      const restriction = yield* disallowedFor(threadId);
      const { disallowed } = restriction;
      if (mayUseNone(restriction)) return yield* noAccountPolicyError(threadId);
      const exhaustedNow = yield* exhaustedNames;
      const avoidSet = new Set([...exhaustedNow, ...avoid, ...disallowed]);
      const outcome = yield* client.place({ pending, avoid: [...avoidSet] });
      if (outcome.kind !== "ok") {
        // `available` tracks `--status` alone; a failed `--place` only logs.
        yield* Effect.logWarning("claude.account.place-failed", {
          threadId,
          kind: outcome.kind,
          detail: outcome.detail,
        });
        if (outcome.kind === "unavailable") {
          const fallback = yield* currentProfileFromActiveLink;
          if (fallback !== undefined && !avoidSet.has(fallback.profile)) return fallback;
        }
        // Leaving the environment alone runs `~/.claude-active`, which a
        // restricted owner may not be allowed to use.
        return yield* restrictedFallback(threadId, restriction);
      }
      const result = outcome.value;
      if (result.snapshot) yield* adoptStatus(result.snapshot);
      // The switcher is told what to avoid; never trust that it listened.
      const chosen = result.chosen && !avoidSet.has(result.chosen) ? result.chosen : null;
      if (result.chosen && chosen === null) {
        yield* Effect.logWarning("claude.account.place-chose-avoided", {
          threadId,
          chosen: result.chosen,
        });
      }
      if (result.status === "no_eligible_profile" || chosen === null) {
        if (mayUseNone(restriction)) return yield* noAccountPolicyError(threadId);
        const recoversAt = isoOrUndefined(result.recovers_at) ?? firstRecovery(disallowed);
        // Nothing the owner may use is waiting on a reset, and whatever else
        // is left is off limits: that is "no access", not "at its limit". The
        // access list decides this; the host list, when known, only narrows it.
        if (isRestricted(restriction) && recoversAt === undefined) {
          const ownExhausted = exhaustedNow.some((profile) => !disallowed.has(profile));
          const remaining = (lastStatus?.profiles ?? []).filter(
            (profile) => !exhaustedNow.includes(profile.name),
          );
          if (!ownExhausted && remaining.every((profile) => disallowed.has(profile.name))) {
            return yield* noAccountPolicyError(threadId);
          }
        }
        const limitLine = isRestricted(restriction)
          ? "Every Claude account you can use is at its limit"
          : "All Claude accounts are at their limit";
        return yield* new ClaudeAccountPolicyError({
          threadId,
          detail:
            recoversAt === undefined
              ? `${limitLine}.`
              : `${limitLine} — first resets at ${formatResetClock(recoversAt)}.`,
        });
      }
      const atMs = yield* Clock.currentTimeMillis;
      pendingPlacements.push({ profile: chosen, atMs });
      return {
        profile: chosen,
        dir: result.dir ? result.dir : profileDir(chosen),
        mode: "auto",
        reason: result.reason ?? result.status,
      } as const;
    });

  const placeAndPersist = (threadId: ThreadId, avoid: ReadonlyArray<string>) =>
    Semaphore.withPermit(placementLock)(
      Effect.gen(function* () {
        const resolution = yield* placeWith(threadId, avoid);
        if (resolution !== undefined) {
          yield* persistResolved(threadId, resolution.profile).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("claude.account.persist-failed", { threadId, cause }),
            ),
          );
          yield* announceSnapshot;
        }
        return resolution;
      }),
    );

  const resolveUnguarded = (
    threadId: ThreadId,
  ): Effect.Effect<ClaudeAccountResolution | undefined, ClaudeAccountPolicyError> =>
    Effect.gen(function* () {
      const settings = yield* readSettings;
      if (!settings.enabled) return undefined;
      const restriction = yield* disallowedFor(threadId);
      const { disallowed } = restriction;
      const rowResult = yield* repository.get(threadId).pipe(Effect.result);
      if (rowResult._tag === "Failure") {
        yield* Effect.logWarning("claude.account.row-read-failed", {
          threadId,
          cause: rowResult.failure.message,
        });
        return yield* restrictedFallback(threadId, restriction);
      }
      const row = rowResult.success;
      yield* pruneExhausted;
      // A spawn is the restart a deferred mode change was waiting for.
      if (pendingRestart.delete(threadId)) yield* announce(threadId);

      if (row.mode.kind === "profile") {
        const pinned = row.mode.profile;
        if (disallowed.has(pinned)) {
          return yield* new ClaudeAccountPolicyError({ threadId, detail: noAccessDetail(pinned) });
        }
        if (!(yield* profileExists(pinned))) {
          return yield* new ClaudeAccountPolicyError({
            threadId,
            detail: `Claude account ${pinned} no longer exists — switch this thread to Auto or another account.`,
          });
        }
        if (knownProfile(pinned)?.auth?.state === "logged_out") {
          return yield* new ClaudeAccountPolicyError({
            threadId,
            detail: `Claude account ${pinned} is logged out — sign it in on the Claude Accounts page or switch this thread to Auto.`,
          });
        }
        if (row.resolvedProfile !== pinned) {
          yield* persistResolved(threadId, pinned).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("claude.account.persist-failed", { threadId, cause }),
            ),
          );
        } else {
          threadProfiles.set(threadId, pinned);
        }
        return {
          profile: pinned,
          dir: profileDir(pinned),
          mode: "profile",
          reason: "pinned",
        } as const;
      }

      // Sticky: an account the thread already ran on is kept until a hard
      // limit, a sign-out, an exhausted mark or its removal takes it out.
      // Nearing a limit never moves an existing thread; only new placements
      // avoid it. Losing access to the account re-places it too.
      if (
        row.resolvedProfile !== null &&
        !disallowed.has(row.resolvedProfile) &&
        (yield* usableAndPresent(row.resolvedProfile))
      ) {
        threadProfiles.set(threadId, row.resolvedProfile);
        return {
          profile: row.resolvedProfile,
          dir: profileDir(row.resolvedProfile),
          mode: "auto",
          reason: "sticky",
        } as const;
      }
      return yield* placeAndPersist(threadId, row.resolvedProfile ? [row.resolvedProfile] : []);
    });

  /**
   * A defect here would otherwise reach `applyClaudeAccountProfile`, which
   * leaves the spawn on `~/.claude-active`. For a restricted owner that is a
   * policy decision, so it goes through the same fallback as a failed placement.
   */
  const resolveForSession: ClaudeAccountsServiceShape["resolveForSession"] = (threadId) =>
    resolveUnguarded(threadId).pipe(
      Effect.catchDefect((defect) =>
        Effect.gen(function* () {
          yield* Effect.logWarning("claude.account.resolve-defect", {
            threadId,
            defect: String(defect),
          });
          const restriction = yield* disallowedFor(threadId);
          return yield* restrictedFallback(threadId, restriction);
        }),
      ),
    );

  const reassign: ClaudeAccountsServiceShape["reassign"] = (threadId, input) =>
    placeAndPersist(threadId, input.avoid);

  const markExhausted: ClaudeAccountsServiceShape["markExhausted"] = (profile, resetsAt) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const resetMs = resetsAt ? Date.parse(resetsAt) : Number.NaN;
      const untilMs = Number.isNaN(resetMs)
        ? now + DEFAULT_EXHAUSTED_MS
        : Math.max(now + 1, resetMs);
      exhausted.set(profile, { untilMs, resetsAt: isoOrUndefined(resetsAt) });
      yield* announceSnapshot;
    });

  // ---------------------------------------------------------------- restarts

  const stopSessionQuietly = (threadId: ThreadId, why: string) =>
    providers.stopSession({ threadId }).pipe(
      Effect.tap(() => Effect.logInfo("claude.account.session-stopped", { threadId, why })),
      Effect.catchCause((cause) =>
        Effect.logWarning("claude.account.session-stop-failed", { threadId, why, cause }),
      ),
    );

  /**
   * Whether the thread is between turns on both views: the orchestration
   * shell (which marks a turn active as soon as its command is accepted, before
   * the provider has started it) and the provider session itself.
   */
  const threadIsIdle = (
    threadId: ThreadId,
    settled?: OrchestrationSession,
  ): Effect.Effect<boolean> =>
    Effect.gen(function* () {
      if (activeTurns.has(threadId)) return false;
      // A `thread.session-set` event carries the session as just applied; the
      // shell projection may not have caught up with it yet.
      let session: OrchestrationSession | null = settled ?? null;
      if (settled === undefined) {
        const shell = yield* query
          .getThreadShellById(threadId)
          .pipe(Effect.orElseSucceed(() => Option.none()));
        session = Option.isSome(shell) ? shell.value.session : null;
      }
      if (
        session !== null &&
        (session.activeTurnId !== null ||
          session.status === "running" ||
          session.status === "starting")
      ) {
        return false;
      }
      const sessions = yield* providers.listSessions();
      const live = sessions.find(
        (session) => session.threadId === threadId && session.status !== "closed",
      );
      return live === undefined || (live.status !== "running" && live.activeTurnId === undefined);
    });

  /** Restarts the thread's provider session so its next turn spawns on the new account. */
  const restartForNewAccount = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const sessions = yield* providers.listSessions();
      const live = sessions.find(
        (session) => session.threadId === threadId && session.status !== "closed",
      );
      if (live === undefined) return;
      if (!(yield* threadIsIdle(threadId))) {
        pendingRestart.add(threadId);
        yield* Effect.logInfo("claude.account.restart-deferred", { threadId });
        return;
      }
      yield* stopSessionQuietly(threadId, "mode-changed");
    });

  /**
   * The turn a mode change waited for has ended. Stop only if nothing new has
   * started since (a queued message may already be on its way); otherwise
   * keep waiting for the next completion.
   */
  const completePendingRestart = (threadId: ThreadId, settled?: OrchestrationSession) =>
    Effect.gen(function* () {
      if (!pendingRestart.has(threadId)) return;
      if (!(yield* threadIsIdle(threadId, settled))) {
        yield* Effect.logInfo("claude.account.restart-still-deferred", { threadId });
        return;
      }
      pendingRestart.delete(threadId);
      yield* stopSessionQuietly(threadId, "mode-changed-after-turn");
      yield* announce(threadId);
    });

  /** Drops a pending wait-for-reset; `true` when there was one. */
  const cancelResetWait = (threadId: ThreadId) =>
    Effect.gen(function* () {
      if (!waitingForReset.delete(threadId)) return false;
      yield* FiberMap.remove(resetWaits, threadId);
      yield* Effect.logInfo("claude.account.reset-wait-cancelled", { threadId });
      return true;
    });

  const setThreadMode: ClaudeAccountsServiceShape["setThreadMode"] = ({
    threadId,
    mode,
    actorUserId = null,
  }) =>
    Effect.gen(function* () {
      const access = yield* accessMap.pipe(Effect.mapError(internal("setThreadMode")));
      // A draft has no owner yet; its first send makes the caller the owner.
      const owner =
        (yield* threadOwner(threadId).pipe(Effect.mapError(internal("setThreadMode")))) ??
        actorUserId;
      if (mode.kind === "profile") {
        // Access is checked before existence, and an identified caller gets the
        // same answer for both, so a pin cannot probe for hidden accounts.
        const exists = yield* profileExists(mode.profile);
        const refusal =
          !mayUse(access, actorUserId, mode.profile) || (!exists && actorUserId !== null)
            ? noAccessDetail(mode.profile)
            : !mayUse(access, owner, mode.profile)
              ? `This thread's owner doesn't have access to Claude account ${mode.profile} — pick another account or Auto.`
              : undefined;
        if (refusal !== undefined) {
          return yield* new ClaudeAccountsError({
            operation: "setThreadMode",
            reason: "forbidden",
            detail: refusal,
          });
        }
        if (!exists) {
          return yield* new ClaudeAccountsError({
            operation: "setThreadMode",
            reason: "invalid",
            detail: `Unknown Claude account '${mode.profile}'.`,
          });
        }
      }
      const row = yield* repository.get(threadId).pipe(Effect.mapError(internal("setThreadMode")));
      const updatedAt = yield* nowIso;
      yield* repository
        .setMode({ threadId, mode, updatedAt })
        .pipe(Effect.mapError(internal("setThreadMode")));
      yield* cancelResetWait(threadId);
      notices.delete(threadId);
      movedAwaitingTurn.delete(threadId);
      yield* pruneExhausted;

      const wouldChange =
        mode.kind === "profile"
          ? row.resolvedProfile !== mode.profile
          : row.resolvedProfile !== null &&
            (!mayUse(access, owner, row.resolvedProfile) ||
              !(yield* usableAndPresent(row.resolvedProfile)));
      if (mode.kind === "profile" && knownProfile(mode.profile)?.auth?.state === "logged_out") {
        notices.set(
          threadId,
          `Claude account ${mode.profile} is logged out — sign it in on the Claude Accounts page or switch this thread to Auto.`,
        );
      }
      if (wouldChange) {
        yield* restartForNewAccount(threadId);
      } else {
        pendingRestart.delete(threadId);
      }
      yield* announce(threadId);
      return yield* getThread(threadId);
    });

  // -------------------------------------------------------------- hard limit

  const continueText = (from: string, to: string, scope: string | undefined) =>
    scope === undefined
      ? `Continue where you left off — this thread moved to Claude account ${to} because ${from} hit its usage limit.`
      : `Continue where you left off — this thread moved to Claude account ${to} because ${from} has no ${scope} allowance left.`;

  const continueAfterResetText = (profile: string, scope: string | undefined) =>
    scope === undefined
      ? `Continue where you left off — Claude account ${profile} has reset its usage limit.`
      : `Continue where you left off — Claude account ${profile} has reset its ${scope} allowance.`;

  const dispatchContinueTurn = (threadId: ThreadId, text: string) =>
    Effect.gen(function* () {
      const shell = yield* query.getThreadShellById(threadId);
      if (Option.isNone(shell)) return;
      const commandUuid = yield* uuid;
      const messageUuid = yield* uuid;
      const createdAt = yield* nowIso;
      // The thread's owner is the actor: this is the server finishing the
      // owner's own turn on another account, not a message from someone else.
      yield* dispatcher.dispatch(
        {
          type: "thread.turn.start",
          commandId: CommandId.make(`server:claude-account-move:${commandUuid}`),
          threadId,
          message: {
            messageId: MessageId.make(`claude-account-move:${messageUuid}`),
            role: "user",
            text,
            attachments: [],
          },
          modelSelection: shell.value.modelSelection,
          runtimeMode: shell.value.runtimeMode,
          interactionMode: shell.value.interactionMode,
          createdAt,
        },
        { actorUserId: shell.value.ownerUserId },
      );
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("claude.account.continue-turn-failed", { threadId, cause }),
      ),
    );

  const rememberCondition = (key: string): boolean => {
    if (handledConditions.has(key)) return false;
    if (handledConditions.size >= MAX_HANDLED_CONDITIONS) {
      const oldest = handledConditions.values().next().value;
      if (oldest !== undefined) handledConditions.delete(oldest);
    }
    handledConditions.add(key);
    return true;
  };

  const handleHardLimit: ClaudeAccountsServiceShape["handleHardLimit"] = (condition) =>
    Effect.gen(function* () {
      const settings = yield* readSettings;
      if (!settings.enabled) return false;
      const { threadId, rateLimitType } = condition;

      const rowResult = yield* repository.get(threadId).pipe(Effect.result);
      if (rowResult._tag === "Failure") {
        yield* Effect.logWarning("claude.account.hard-limit-row-read-failed", {
          threadId,
          cause: rowResult.failure.message,
        });
        return false;
      }
      const row = rowResult.success;
      let profile = threadProfiles.get(threadId) ?? row.resolvedProfile ?? undefined;
      if (profile === undefined) {
        profile = (yield* currentProfileFromActiveLink)?.profile;
      }
      if (profile === undefined) {
        yield* Effect.logWarning("claude.account.hard-limit-unattributed", {
          threadId,
          rateLimitType,
        });
        return false;
      }
      const resetsAt =
        condition.resetAt !== undefined ? isoFromUnixSeconds(condition.resetAt) : undefined;

      // A thread this service just moved has not asked its new account for
      // anything until a turn starts there, so a rejection before that is a
      // stale copy from the session that was stopped.
      if (movedAwaitingTurn.has(threadId)) {
        yield* Effect.logInfo("claude.account.hard-limit-stale", { threadId, rateLimitType });
        return true;
      }
      // Repeated copies of one rejection against one account are consumed
      // once. Accounts often share a reset instant (5-hour windows are
      // hour-aligned), so the account is part of the key. Without a reset time
      // nothing identifies the rejection, so every copy is judged on its own.
      const conditionKey = `${threadId}\u0000${profile}\u0000${rateLimitType}\u0000${resetsAt}`;
      if (resetsAt !== undefined && !rememberCondition(conditionKey)) {
        return true;
      }

      const accountWide = ACCOUNT_WIDE_LIMIT_TYPES.has(rateLimitType);
      const scope = accountWide ? undefined : scopedLimitLabel(rateLimitType);

      // Keep the host-wide symlink honest: the switcher moves it only when this
      // account is the elected one, and answers `no-op` otherwise.
      const election = yield* client.hardLimit({ type: rateLimitType, profile });
      yield* Effect.logInfo("claude.account.hard-limit", {
        threadId,
        profile,
        rateLimitType,
        resetsAt,
        accountWide,
        election: election.kind === "ok" ? election.value.status : election.kind,
      });
      // Only an account-wide window takes the account out of rotation; a
      // model-scoped one leaves other models, and other threads, alone.
      if (accountWide) yield* markExhausted(profile, resetsAt);

      if (row.mode.kind === "profile") {
        notices.set(
          threadId,
          accountWide
            ? `${profile} is at its usage limit until ${formatResetClock(resetsAt)} — switch to Auto or another account.`
            : `${profile} has no ${scope} allowance left until ${formatResetClock(resetsAt)} — switch the model or account.`,
        );
        yield* announce(threadId);
        return true;
      }

      // A window that resets within the threshold is cheaper to wait out than
      // to leave: the thread keeps its account and its cache, and continues
      // there once the window resets. The timer lives in memory, so a restart
      // in between leaves the notice and a stopped thread.
      const nowMs = yield* Clock.currentTimeMillis;
      const resetMs = resetsAt === undefined ? Number.NaN : Date.parse(resetsAt);
      // A reset already in the past while Claude still refuses is not worth
      // another wait: the thread moves instead.
      if (resetMs > nowMs && resetMs - nowMs <= RESET_WAIT_THRESHOLD_MS) {
        const continueAtMs = resetMs + RESET_WAIT_BUFFER_MS;
        const continueAt = isoFromUnixSeconds(continueAtMs / 1000);
        notices.set(
          threadId,
          `${profile} resets at ${formatResetClock(resetsAt)} — this thread continues on it at ${formatResetClock(continueAt)}.`,
        );
        waitingForReset.add(threadId);
        yield* stopSessionQuietly(threadId, "hard-limit-reset-wait");
        yield* FiberMap.run(
          resetWaits,
          threadId,
          Effect.gen(function* () {
            yield* Effect.sleep(Duration.millis(continueAtMs - nowMs));
            if (!waitingForReset.delete(threadId)) return;
            // The continue asks the same account again, so a fresh rejection
            // carrying the same reset is real, not a copy of this one.
            handledConditions.delete(conditionKey);
            notices.delete(threadId);
            yield* pruneExhausted;
            yield* Effect.logInfo("claude.account.reset-wait-continue", { threadId, profile });
            yield* dispatchContinueTurn(threadId, continueAfterResetText(profile, scope));
            yield* announce(threadId);
          }),
        );
        yield* Effect.logInfo("claude.account.reset-wait", { threadId, profile, continueAt });
        yield* announce(threadId);
        return true;
      }

      const moved = yield* reassign(threadId, { avoid: [profile] }).pipe(Effect.result);
      if (moved._tag === "Failure") {
        notices.set(threadId, moved.failure.detail);
        yield* announce(threadId);
        return true;
      }
      if (moved.success === undefined) {
        notices.set(
          threadId,
          `${profile} is at its usage limit until ${formatResetClock(resetsAt)} and no other account could be chosen.`,
        );
        yield* announce(threadId);
        return true;
      }
      notices.delete(threadId);
      movedAwaitingTurn.add(threadId);
      yield* stopSessionQuietly(threadId, "hard-limit");
      yield* dispatchContinueTurn(threadId, continueText(profile, moved.success.profile, scope));
      yield* announce(threadId);
      return true;
    });

  // ------------------------------------------------------------------ events

  const overlayFromEvent = (event: ProviderRuntimeEvent) =>
    Effect.gen(function* () {
      if (event.type !== "account.rate-limits.updated" || event.provider !== "claudeAgent") return;
      const profile = threadProfiles.get(event.threadId);
      if (profile === undefined) return;
      const atMs = yield* Clock.currentTimeMillis;
      const previous = overlays.get(profile);
      let fiveHour = previous?.fiveHour;
      let weekly = previous?.weekly;
      for (const window of event.payload.limits.windows) {
        const value: ClaudeAccountWindow = {
          usedPercent: clampPercent(window.usedPercent),
          ...(window.resetsAt ? { resetsAt: window.resetsAt } : {}),
        };
        if (window.id === "five_hour") fiveHour = value;
        else if (window.id === "seven_day") weekly = value;
      }
      const next: WindowOverlay = {
        atMs,
        ...(fiveHour ? { fiveHour } : {}),
        ...(weekly ? { weekly } : {}),
      };
      overlays.set(profile, next);
      yield* announceSnapshot;
    });

  const onProviderEvent = (event: ProviderRuntimeEvent) =>
    Effect.gen(function* () {
      yield* overlayFromEvent(event);
      switch (event.type) {
        case "turn.started": {
          activeTurns.add(event.threadId);
          // Someone sent a message during the wait: their turn replaces the continue.
          if (yield* cancelResetWait(event.threadId)) {
            notices.delete(event.threadId);
            yield* announce(event.threadId);
          }
          // The first turn on the new account: from here a rejection is real.
          if (movedAwaitingTurn.delete(event.threadId)) yield* announce(event.threadId);
          return;
        }
        case "turn.completed":
        case "turn.aborted": {
          activeTurns.delete(event.threadId);
          yield* completePendingRestart(event.threadId);
          return;
        }
        case "session.exited": {
          activeTurns.delete(event.threadId);
          return;
        }
        default:
          return;
      }
    });

  const onDomainEvent = (event: OrchestrationEvent) =>
    Effect.gen(function* () {
      // Runtime ingestion applies a provider turn completion to the thread
      // asynchronously, so the provider's own `turn.completed` usually arrives
      // while the shell still reads "running". The settled session is the
      // reliable moment to finish a deferred account change.
      // A message accepted during a wait replaces the continue, even before
      // its turn reaches the provider.
      if (event.type === "thread.turn-start-requested") {
        if (yield* cancelResetWait(event.payload.threadId)) {
          notices.delete(event.payload.threadId);
          yield* announce(event.payload.threadId);
        }
        return;
      }
      if (event.type === "thread.session-set") {
        const session = event.payload.session;
        // T3-CUSTOM(expbkt3): native run/session projections drive account lifecycle.
        if (session.status === "running" && session.activeTurnId !== null) {
          activeTurns.add(event.payload.threadId);
          if (movedAwaitingTurn.delete(event.payload.threadId))
            yield* announce(event.payload.threadId);
        } else if (session.status !== "starting") {
          activeTurns.delete(event.payload.threadId);
        }
        if (
          pendingRestart.has(event.payload.threadId) &&
          session.activeTurnId === null &&
          session.status !== "running" &&
          session.status !== "starting"
        ) {
          yield* completePendingRestart(event.payload.threadId, session);
        }
        return;
      }
      if (event.type !== "thread.deleted") return;
      const threadId = event.payload.threadId;
      yield* cancelResetWait(threadId);
      threadProfiles.delete(threadId);
      notices.delete(threadId);
      pendingRestart.delete(threadId);
      activeTurns.delete(threadId);
      movedAwaitingTurn.delete(threadId);
      yield* repository
        .delete(threadId)
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("claude.account.row-delete-failed", { threadId, cause }),
          ),
        );
      yield* announce(threadId);
    });

  // ----------------------------------------------------------------- streams

  const watchSnapshot: ClaudeAccountsServiceShape["watchSnapshot"] = (viewer) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(changes);
        const view = Effect.flatMap(snapshot(), (current) => viewSnapshot(current, viewer));
        const initial = yield* view;
        return Stream.concat(
          Stream.make(initial),
          Stream.fromSubscription(subscription).pipe(
            Stream.filter((changed) => changed === SNAPSHOT_CHANGE),
            Stream.mapEffect(() => view),
          ),
        );
      }),
    );

  // ------------------------------------------------------------------ access

  const listAccess: ClaudeAccountsServiceShape["listAccess"] = () => accessList;

  /**
   * After access changes, a live Claude session on an account its owner may
   * no longer use is restarted (idle at once, busy once its turn ends), so the
   * next turn is placed again (Auto) or refused (pinned) instead of carrying on.
   */
  const restartRevokedSessions = Effect.gen(function* () {
    const access = yield* accessMap;
    if (access.size === 0) return;
    const sessions = yield* providers.listSessions();
    for (const session of sessions) {
      if (session.status === "closed" || session.provider !== "claudeAgent") continue;
      const threadId = session.threadId;
      const row = yield* repository.get(threadId);
      const profile = row.mode.kind === "profile" ? row.mode.profile : row.resolvedProfile;
      if (profile === null) continue;
      const owner = yield* threadOwner(threadId);
      if (mayUse(access, owner, profile)) continue;
      if (row.mode.kind === "profile") notices.set(threadId, noAccessDetail(profile));
      yield* Effect.logInfo("claude.account.access-revoked", { threadId, profile });
      yield* restartForNewAccount(threadId);
      yield* announce(threadId);
    }
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("claude.account.revocation-restart-failed", { cause }),
    ),
  );

  const setAccess: ClaudeAccountsServiceShape["setAccess"] = ({ profile, userIds, actorUserId }) =>
    Effect.gen(function* () {
      // Clearing a list is allowed for an account that is gone, to tidy up.
      if (userIds.length > 0 && !(yield* profileExists(profile))) {
        return yield* new ClaudeAccountsError({
          operation: "setAccess",
          reason: "invalid",
          detail: `Unknown Claude account '${profile}'.`,
        });
      }
      const addedAt = yield* nowIso;
      accessGeneration += 1;
      accessCache = undefined;
      yield* accessRepository
        .setUsers({ profile, userIds, addedByUserId: actorUserId, addedAt })
        .pipe(Effect.mapError(internal("setAccess")));
      accessGeneration += 1;
      accessCache = undefined;
      yield* Effect.logInfo("claude.account.access-set", {
        profile,
        users: userIds.length,
        actorUserId,
      });
      // Snapshots are filtered per viewer, so every connection re-reads its view.
      yield* announceSnapshot;
      yield* restartRevokedSessions;
      return yield* accessList;
    });

  const watchThread: ClaudeAccountsServiceShape["watchThread"] = (threadId) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(changes);
        const initial = yield* getThread(threadId);
        // Every change to this thread is sent, even an identical view (callers
        // use it as a signal). A live-session re-read every status poll is sent
        // only when it changed what the thread shows.
        let last = initial;
        return Stream.concat(
          Stream.make(initial),
          Stream.fromSubscription(subscription).pipe(
            Stream.filter((changed) => changed === threadId || changed === LIVE_SESSIONS_CHANGE),
            Stream.mapEffect((changed) =>
              getThread(threadId).pipe(
                Effect.map((view) => {
                  const unchanged =
                    changed === LIVE_SESSIONS_CHANGE && sameThreadAccount(last, view);
                  last = view;
                  return { view, unchanged };
                }),
              ),
            ),
            Stream.filter((frame) => !frame.unchanged),
            Stream.map((frame) => frame.view),
          ),
        );
      }),
    );

  // ------------------------------------------------------------------ wiring

  const unregisterResolver = registerClaudeAccountResolver(resolveForSession);
  const unregisterHook = registerClaudeHardLimitAccountsHook({ handle: handleHardLimit });
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      unregisterResolver();
      unregisterHook();
    }),
  );
  yield* providers.streamEvents.pipe(Stream.runForEach(onProviderEvent), Effect.forkScoped);
  yield* dispatcher.streamDomainEvents.pipe(Stream.runForEach(onDomainEvent), Effect.forkScoped);
  yield* refreshOnEnable.pipe(Effect.forkScoped);
  yield* pollLoop.pipe(Effect.forkScoped);

  return ClaudeAccountsService.of({
    getThread,
    setThreadMode,
    snapshot,
    watchSnapshot,
    listAccess,
    setAccess,
    watchThread,
    resolveForSession,
    refreshStatus,
    markExhausted,
    reassign,
    handleHardLimit,
  });
});

export const layer = Layer.effect(ClaudeAccountsService, make);
