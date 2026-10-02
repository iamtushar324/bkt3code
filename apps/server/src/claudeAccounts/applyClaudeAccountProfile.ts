/**
 * T3-CUSTOM(expbkt3): Claude account profiles per thread — the adapter seam.
 *
 * `ClaudeAdapter.startSession` calls `applyClaudeAccountProfile` once per spawn
 * with the environment it was about to use. A resolver registered by
 * `ClaudeAccountsService` picks the account; with nothing registered, or the
 * feature off, the environment passes through untouched. Infrastructure
 * trouble (the switcher crashed, timed out, the row could not be read) also
 * passes through, with a warning, so a broken switcher never blocks a turn.
 * Only a policy outcome — a pinned account that is logged out, or no account
 * with headroom — fails the start, with that message as the thread's error.
 */
import type { ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { ProviderAdapterValidationError } from "../provider/Errors.ts";

export class ClaudeAccountPolicyError extends Schema.TaggedError<ClaudeAccountPolicyError>()(
  "ClaudeAccountPolicyError",
  {
    threadId: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export interface ClaudeAccountResolution {
  readonly profile: string;
  readonly dir: string;
  readonly mode: "auto" | "profile";
  readonly reason: string;
}

export type ClaudeAccountResolver = (
  threadId: ThreadId,
) => Effect.Effect<ClaudeAccountResolution | undefined, ClaudeAccountPolicyError>;

let registeredResolver: ClaudeAccountResolver | undefined;

/** Installs the resolver; returns the matching uninstall. */
export function registerClaudeAccountResolver(resolver: ClaudeAccountResolver): () => void {
  registeredResolver = resolver;
  return () => {
    if (registeredResolver === resolver) registeredResolver = undefined;
  };
}

export function readClaudeAccountResolver(): ClaudeAccountResolver | undefined {
  return registeredResolver;
}

const isPolicyError = Schema.is(ClaudeAccountPolicyError);

export const applyClaudeAccountProfile = Effect.fn("applyClaudeAccountProfile")(function* (
  threadId: ThreadId,
  environment: NodeJS.ProcessEnv,
): Effect.fn.Return<NodeJS.ProcessEnv, ProviderAdapterValidationError> {
  const resolver = registeredResolver;
  if (resolver === undefined) return environment;

  const exit = yield* Effect.exit(resolver(threadId));
  if (Exit.isFailure(exit)) {
    const failure = exit.cause.reasons.find(Cause.isFailReason);
    if (failure !== undefined && isPolicyError(failure.error)) {
      return yield* new ProviderAdapterValidationError({
        provider: "claudeAgent",
        operation: "startSession",
        issue: failure.error.detail,
      });
    }
    yield* Effect.logWarning("claude.account.resolve-failed", {
      threadId,
      cause: Cause.pretty(exit.cause),
    });
    return environment;
  }

  const resolution = exit.value;
  if (resolution === undefined) return environment;

  yield* Effect.logInfo("claude.account.placed", {
    threadId,
    profile: resolution.profile,
    mode: resolution.mode,
    reason: resolution.reason,
  });
  return { ...environment, CLAUDE_CONFIG_DIR: resolution.dir };
});
