/**
 * T3-CUSTOM(expbkt3): Claude account profiles per thread — host switcher client.
 *
 * `claude-autoswitch` on the host is the only thing that ranks accounts. This
 * client runs it with an argv array (never a shell string), a 10 s budget and a
 * tolerant JSON decode, and reports three outcomes per call: a decoded result,
 * `unavailable` (the binary is missing or predates the `--status`/`--place`
 * flags, so the feature degrades), or `failed` (it crashed, timed out, or
 * returned something unreadable). It never reads, copies or logs credentials.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { expandHomePath } from "../pathExpansion.ts";
import { ProcessRunner } from "../processRunner.ts";
import { ServerSettingsService } from "../serverSettings.ts";

/** Where the switcher lives when nothing overrides it, under the server user's home. */
export const DEFAULT_CLAUDE_AUTOSWITCH_PATH = "~/.local/bin/claude-autoswitch";
const AUTOSWITCH_TIMEOUT = "10 seconds";
const MAX_OUTPUT_BYTES = 256 * 1024;

const NullableNumber = Schema.NullOr(Schema.Number);
const NullableString = Schema.NullOr(Schema.String);

const SwitcherWindow = Schema.Struct({
  used: Schema.optionalKey(NullableNumber),
  resets_at: Schema.optionalKey(NullableString),
});

const SwitcherScopedWindow = Schema.Struct({
  label: Schema.optionalKey(NullableString),
  used: Schema.optionalKey(NullableNumber),
  resets_at: Schema.optionalKey(NullableString),
});

const SwitcherAuth = Schema.Struct({
  state: Schema.optionalKey(NullableString),
  detail: Schema.optionalKey(NullableString),
});

export const SwitcherProfile = Schema.Struct({
  name: Schema.String,
  dir: Schema.optionalKey(NullableString),
  rank: Schema.optionalKey(NullableNumber),
  in_rotation: Schema.optionalKey(Schema.Boolean),
  excluded: Schema.optionalKey(Schema.Boolean),
  elected: Schema.optionalKey(Schema.Boolean),
  eligible: Schema.optionalKey(Schema.Boolean),
  why: Schema.optionalKey(NullableString),
  auth: Schema.optionalKey(Schema.NullOr(SwitcherAuth)),
  email_masked: Schema.optionalKey(NullableString),
  five_hour: Schema.optionalKey(Schema.NullOr(SwitcherWindow)),
  weekly: Schema.optionalKey(Schema.NullOr(SwitcherWindow)),
  scoped: Schema.optionalKey(Schema.NullOr(SwitcherScopedWindow)),
  binding_left: Schema.optionalKey(NullableNumber),
  headroom_per_day: Schema.optionalKey(NullableNumber),
  age_sec: Schema.optionalKey(NullableNumber),
  sessions: Schema.optionalKey(NullableNumber),
  // `space-share-v1` placement figures; absent from older switchers.
  space_to_reset: Schema.optionalKey(NullableNumber),
  space_per_day: Schema.optionalKey(NullableNumber),
  five_hour_rate: Schema.optionalKey(NullableNumber),
  five_hour_full_in: Schema.optionalKey(NullableNumber),
  place_rank: Schema.optionalKey(NullableNumber),
  place_score: Schema.optionalKey(NullableNumber),
  guard_ok: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
});
export type SwitcherProfile = typeof SwitcherProfile.Type;

export const SwitcherStatus = Schema.Struct({
  schema: Schema.optionalKey(Schema.String),
  generated_ms: Schema.optionalKey(NullableNumber),
  elected: Schema.optionalKey(NullableString),
  rank_order: Schema.optionalKey(Schema.Array(Schema.String)),
  place_spread: Schema.optionalKey(NullableNumber),
  /** Set by switchers that accept `--rates` and `--pending` on `--status`. */
  place_rule: Schema.optionalKey(NullableString),
  place_order: Schema.optionalKey(Schema.Array(Schema.String)),
  profiles: Schema.Array(SwitcherProfile),
});
export type SwitcherStatus = typeof SwitcherStatus.Type;

export const SwitcherPlaceResult = Schema.Struct({
  schema: Schema.optionalKey(Schema.String),
  status: Schema.Literals(["placed", "fallback", "no_eligible_profile"]),
  chosen: Schema.optionalKey(NullableString),
  dir: Schema.optionalKey(NullableString),
  reason: Schema.optionalKey(NullableString),
  recovers_at: Schema.optionalKey(NullableString),
  snapshot: Schema.optionalKey(Schema.NullOr(SwitcherStatus)),
});
export type SwitcherPlaceResult = typeof SwitcherPlaceResult.Type;

export const SwitcherHardLimitResult = Schema.Struct({
  status: Schema.String,
  reason: Schema.optionalKey(NullableString),
  from: Schema.optionalKey(NullableString),
  to: Schema.optionalKey(NullableString),
});
export type SwitcherHardLimitResult = typeof SwitcherHardLimitResult.Type;

const decodeStatus = Schema.decodeUnknownOption(Schema.fromJsonString(SwitcherStatus));
const decodePlace = Schema.decodeUnknownOption(Schema.fromJsonString(SwitcherPlaceResult));
const decodeHardLimit = Schema.decodeUnknownOption(Schema.fromJsonString(SwitcherHardLimitResult));

/** Why a switcher call produced no result. */
export type ClaudeAutoswitchFailure =
  | { readonly kind: "unavailable"; readonly detail: string }
  | { readonly kind: "failed"; readonly detail: string };

export type ClaudeAutoswitchOutcome<A> =
  | { readonly kind: "ok"; readonly value: A }
  | ClaudeAutoswitchFailure;

/**
 * Inputs a `space-share-v1` switcher ranks with. Only sent once the switcher
 * has reported `place_rule`: an older one rejects unknown flags.
 */
export interface ClaudeAutoswitchRankInput {
  /** Placements this server made in the last 90 s, by profile. */
  readonly pending: Readonly<Record<string, number>>;
  /** Observed 5-hour burn, in window points per hour, by profile. */
  readonly rates?: Readonly<Record<string, number>>;
}

export interface ClaudeAutoswitchPlaceInput extends ClaudeAutoswitchRankInput {
  /** Profiles the caller knows are exhausted. */
  readonly avoid: ReadonlyArray<string>;
}

export interface ClaudeAutoswitchHardLimitInput {
  readonly type: string;
  readonly profile: string;
}

export interface ClaudeAutoswitchClientShape {
  readonly status: (
    input?: ClaudeAutoswitchRankInput,
  ) => Effect.Effect<ClaudeAutoswitchOutcome<SwitcherStatus>>;
  readonly place: (
    input: ClaudeAutoswitchPlaceInput,
  ) => Effect.Effect<ClaudeAutoswitchOutcome<SwitcherPlaceResult>>;
  readonly hardLimit: (
    input: ClaudeAutoswitchHardLimitInput,
  ) => Effect.Effect<ClaudeAutoswitchOutcome<SwitcherHardLimitResult>>;
}

export class ClaudeAutoswitchClient extends Context.Service<
  ClaudeAutoswitchClient,
  ClaudeAutoswitchClientShape
>()("t3/claudeAccounts/ClaudeAutoswitchClient") {}

/**
 * The configured switcher binary: `T3_CLAUDE_AUTOSWITCH_BIN`, then the
 * `autoswitchPath` setting, then `~/.local/bin/claude-autoswitch`. A leading
 * `~` expands to the home directory of the user running the server.
 */
export function resolveAutoswitchPath(configured: string | undefined): string {
  const fromEnv = process.env.T3_CLAUDE_AUTOSWITCH_BIN?.trim();
  if (fromEnv) return expandHomePath(fromEnv);
  const trimmed = configured?.trim() ?? "";
  return expandHomePath(trimmed.length > 0 ? trimmed : DEFAULT_CLAUDE_AUTOSWITCH_PATH);
}

/** The switcher binary this server's settings resolve to; unreadable settings fall back to the default. */
export const autoswitchPathFrom = (
  settings: ServerSettingsService["Service"],
): Effect.Effect<string> =>
  settings.getSettings.pipe(
    Effect.map((value) =>
      resolveAutoswitchPath(value.experimental.claudeAccountProfiles.autoswitchPath),
    ),
    Effect.orElseSucceed(() => resolveAutoswitchPath(undefined)),
  );

/**
 * The same answer where the settings service may be absent (the hard-limit
 * rotation), so the client and the rotation always run the same binary.
 */
export const configuredAutoswitchPath: Effect.Effect<string> = Effect.serviceOption(
  ServerSettingsService,
).pipe(
  Effect.flatMap((settings) =>
    Option.isSome(settings)
      ? autoswitchPathFrom(settings.value)
      : Effect.sync(() => resolveAutoswitchPath(undefined)),
  ),
);

function rankArgs(input: ClaudeAutoswitchRankInput | undefined): Array<string> {
  if (input === undefined) return [];
  const args: Array<string> = [];
  const pending = Object.entries(input.pending)
    .filter(([, count]) => count > 0)
    .map(([name, count]) => `${name}=${count}`);
  if (pending.length > 0) args.push("--pending", pending.join(","));
  const rates = Object.entries(input.rates ?? {})
    .filter(([, rate]) => Number.isFinite(rate) && rate >= 0)
    .map(([name, rate]) => `${name}=${Math.round(rate * 10) / 10}`);
  if (rates.length > 0) args.push("--rates", rates.join(","));
  return args;
}

function placeArgs(input: ClaudeAutoswitchPlaceInput): ReadonlyArray<string> {
  const args: Array<string> = ["--place", "--json", ...rankArgs(input)];
  if (input.avoid.length > 0) args.push("--avoid", input.avoid.join(","));
  return args;
}

/** An old switcher prints usage and exits non-zero when it sees a flag it does not know. */
function looksLikeUnknownFlag(stderr: string, stdout: string): boolean {
  const text = `${stderr}\n${stdout}`;
  return /unrecognized arguments|unknown option|usage:/i.test(text);
}

export const make = Effect.gen(function* () {
  const runner = yield* ProcessRunner;
  const settings = yield* ServerSettingsService;

  const binaryPath = autoswitchPathFrom(settings);

  const invoke = <A>(
    args: ReadonlyArray<string>,
    decode: (stdout: string) => Option.Option<A>,
  ): Effect.Effect<ClaudeAutoswitchOutcome<A>> =>
    Effect.gen(function* () {
      const command = yield* binaryPath;
      const result = yield* runner
        .run({
          command,
          args,
          timeout: AUTOSWITCH_TIMEOUT,
          timeoutBehavior: "timedOutResult",
          maxOutputBytes: MAX_OUTPUT_BYTES,
          outputMode: "truncate",
        })
        .pipe(Effect.result);
      if (result._tag === "Failure") {
        const error = result.failure;
        if (error._tag === "ProcessSpawnError") {
          return { kind: "unavailable", detail: `${command} could not be started.` } as const;
        }
        return { kind: "failed", detail: error.message } as const;
      }
      const output = result.success;
      if (output.timedOut) {
        return { kind: "failed", detail: `${command} did not answer within 10 s.` } as const;
      }
      const stdout = output.stdout.trim();
      const decoded = decode(stdout);
      if (Option.isSome(decoded)) {
        return { kind: "ok", value: decoded.value } as const;
      }
      if (output.code !== 0 && looksLikeUnknownFlag(output.stderr, stdout)) {
        return {
          kind: "unavailable",
          detail: `${command} does not support ${args[0]}; update the host switcher.`,
        } as const;
      }
      return {
        kind: "failed",
        detail:
          output.code !== 0
            ? `${command} exited ${String(output.code)}: ${output.stderr.trim().slice(0, 200)}`
            : `${command} returned unreadable JSON for ${args[0]}.`,
      } as const;
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.succeed({ kind: "failed", detail: String(cause) } as const),
      ),
    );

  return ClaudeAutoswitchClient.of({
    status: (input) => invoke(["--status", "--json", ...rankArgs(input)], decodeStatus),
    place: (input) => invoke(placeArgs(input), decodePlace),
    hardLimit: (input) =>
      invoke(["--hard-limit", input.type, "--profile", input.profile, "--json"], decodeHardLimit),
  });
});

export const layer = Layer.effect(ClaudeAutoswitchClient, make);
