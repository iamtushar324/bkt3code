/**
 * T3-CUSTOM(expbkt3): Claude account profiles per thread.
 *
 * The host keeps several Claude subscription accounts as config directories
 * under `~/.claude-profiles/<name>` (plus `default` = `~/.claude`). Each Claude
 * thread runs on one of them: `auto` lets the server place it on the account
 * with the most space to reset per live session (the host switcher,
 * `claude-autoswitch --place`, is the only ranker), or the user pins one
 * account by hand. The choice is sticky per thread so the provider's prompt
 * cache survives across turns.
 *
 * Everything here travels on fork RPCs; upstream provider contracts are
 * untouched. Usage figures are percent USED, like `ServerProviderUsageWindow`.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, ThreadId, TrimmedString, UserId } from "./baseSchemas.ts";

export const ClaudeAccountProfileName = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(64),
  // A path component under ~/.claude-profiles: never `.` or `..`.
  Schema.isPattern(/^(?!\.{1,2}$)[A-Za-z0-9._-]+$/),
);
export type ClaudeAccountProfileName = typeof ClaudeAccountProfileName.Type;

/** `auto` places the thread; `profile` pins it to one named account. */
export const ClaudeAccountMode = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("auto") }),
  Schema.Struct({ kind: Schema.Literal("profile"), profile: ClaudeAccountProfileName }),
]);
export type ClaudeAccountMode = typeof ClaudeAccountMode.Type;

export const CLAUDE_ACCOUNT_MODE_AUTO: ClaudeAccountMode = { kind: "auto" };

const Percent = Schema.Number.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(100),
);

export const ClaudeAccountWindow = Schema.Struct({
  usedPercent: Percent,
  resetsAt: Schema.optionalKey(IsoDateTime),
});
export type ClaudeAccountWindow = typeof ClaudeAccountWindow.Type;

export const ClaudeAccountScopedWindow = Schema.Struct({
  label: Schema.String,
  usedPercent: Percent,
  resetsAt: Schema.optionalKey(IsoDateTime),
});
export type ClaudeAccountScopedWindow = typeof ClaudeAccountScopedWindow.Type;

export const ClaudeAccountAuthState = Schema.Literals(["ok", "logged_out", "unknown"]);
export type ClaudeAccountAuthState = typeof ClaudeAccountAuthState.Type;

export const ClaudeAccountStatus = Schema.Struct({
  name: ClaudeAccountProfileName,
  /** Short badge label: shortest unique prefix, or the configured override. */
  shortLabel: Schema.String,
  emailMasked: Schema.optionalKey(Schema.String),
  /** 1-based position in the switcher's ranking; absent when unranked. */
  rank: Schema.optionalKey(NonNegativeInt),
  /** Whether Auto would place a new session here right now. */
  eligible: Schema.Boolean,
  /** Human-readable reason when not eligible (`over 5-hour limit`, …). */
  why: Schema.String,
  /** The account the host-wide `~/.claude-active` symlink points at. */
  elected: Schema.Boolean,
  auth: ClaudeAccountAuthState,
  fiveHour: Schema.optionalKey(ClaudeAccountWindow),
  weekly: Schema.optionalKey(ClaudeAccountWindow),
  scoped: Schema.optionalKey(ClaudeAccountScopedWindow),
  /** Live Claude processes on this account, across every T3 instance and terminal. */
  sessions: NonNegativeInt,
  /** Age of the usage figures, in seconds; absent when unknown. */
  ageSec: Schema.optionalKey(Schema.Number),
  /**
   * Percent of the week this account can still use before its binding weekly
   * cap resets: the cap left, limited by the 5-hour windows that still fit.
   */
  spaceToReset: Schema.optionalKey(Percent),
  /** `spaceToReset` per day until that reset; Auto ranks on it. */
  spacePerDay: Schema.optionalKey(Schema.Number.check(Schema.isGreaterThanOrEqualTo(0))),
  /** Seconds until the 5-hour window fills at its current pace; absent when it will not. */
  fiveHourFullInSec: Schema.optionalKey(Schema.Number.check(Schema.isGreaterThanOrEqualTo(0))),
  /**
   * 1-based position in the order Auto tries accounts for the next new
   * session; absent for an account Auto cannot place on (logged out, at 100%).
   */
  placeRank: Schema.optionalKey(NonNegativeInt),
  /**
   * Whether the viewer may use this account. Only admins are sent accounts
   * they cannot use (so they can manage access); everyone else gets only the
   * accounts they may use, without this flag.
   */
  allowed: Schema.optionalKey(Schema.Boolean),
});
export type ClaudeAccountStatus = typeof ClaudeAccountStatus.Type;

export const ClaudeAccountsSnapshot = Schema.Struct({
  /** `experimental.claudeAccountProfiles.enabled` on this server. */
  enabled: Schema.Boolean,
  /** False when the host switcher is missing or lacks `--status --json`. */
  available: Schema.Boolean,
  unavailableReason: Schema.optionalKey(Schema.String),
  generatedAt: IsoDateTime,
  profiles: Schema.Array(ClaudeAccountStatus),
});
export type ClaudeAccountsSnapshot = typeof ClaudeAccountsSnapshot.Type;

export const ThreadClaudeAccount = Schema.Struct({
  threadId: ThreadId,
  mode: ClaudeAccountMode,
  /** The account the thread's current or last session ran on. */
  resolvedProfile: Schema.optionalKey(ClaudeAccountProfileName),
  resolvedAt: Schema.optionalKey(IsoDateTime),
  /** A one-line notice for the composer, e.g. a pinned account at its limit. */
  notice: Schema.optionalKey(Schema.String),
  /** True when a mode change waits for the running turn to finish. */
  pendingRestart: Schema.optionalKey(Schema.Boolean),
});
export type ThreadClaudeAccount = typeof ThreadClaudeAccount.Type;

export const ClaudeAccountsThreadInput = Schema.Struct({ threadId: ThreadId });
export type ClaudeAccountsThreadInput = typeof ClaudeAccountsThreadInput.Type;

export const ClaudeAccountsSetThreadModeInput = Schema.Struct({
  threadId: ThreadId,
  mode: ClaudeAccountMode,
});
export type ClaudeAccountsSetThreadModeInput = typeof ClaudeAccountsSetThreadModeInput.Type;

export const ClaudeAccountsErrorReason = Schema.Literals([
  "not-found",
  "invalid",
  "unavailable",
  "internal",
  /** The caller may not use the account, or may not manage access. */
  "forbidden",
]);
export type ClaudeAccountsErrorReason = typeof ClaudeAccountsErrorReason.Type;

export class ClaudeAccountsError extends Schema.TaggedError<ClaudeAccountsError>()(
  "ClaudeAccountsError",
  {
    operation: Schema.String,
    reason: ClaudeAccountsErrorReason,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Claude accounts ${this.operation} failed: ${this.detail}`;
  }
}

/**
 * Who may use one account. An account with no users is open to everyone; once
 * users are listed, only they may use it. Admins manage this list.
 */
export const ClaudeAccountAccessEntry = Schema.Struct({
  profile: ClaudeAccountProfileName,
  userIds: Schema.Array(UserId),
});
export type ClaudeAccountAccessEntry = typeof ClaudeAccountAccessEntry.Type;

/** Every account that has an allow list; accounts absent here are open. */
export const ClaudeAccountAccessList = Schema.Struct({
  entries: Schema.Array(ClaudeAccountAccessEntry),
});
export type ClaudeAccountAccessList = typeof ClaudeAccountAccessList.Type;

/** Replaces one account's allow list; an empty `userIds` opens it to everyone. */
export const ClaudeAccountsAccessSetInput = ClaudeAccountAccessEntry;
export type ClaudeAccountsAccessSetInput = typeof ClaudeAccountsAccessSetInput.Type;

/** `experimental.claudeAccountProfiles` server settings. Off by default. */
export const ClaudeAccountProfilesSettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  /** Path to `claude-autoswitch`; empty means `~/.local/bin/claude-autoswitch`. */
  autoswitchPath: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  /** Badge label overrides by profile name, e.g. `{ "agent": "a" }`. */
  shortLabels: Schema.Record(Schema.String, Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
});
export type ClaudeAccountProfilesSettings = typeof ClaudeAccountProfilesSettings.Type;
