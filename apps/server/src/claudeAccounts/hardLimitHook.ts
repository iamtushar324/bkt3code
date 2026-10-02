/**
 * T3-CUSTOM(expbkt3): Claude account profiles per thread — hard-limit hook.
 *
 * The existing rotation listener (`provider/claudeHardLimitRotation.expbkt3.ts`)
 * reacts to Claude's authoritative `rate_limit_event` rejections. With the
 * per-thread feature on, `ClaudeAccountsService` registers a hook here and the
 * listener hands each rejection to it; the hook returns `false` when the
 * feature is off so the listener falls back to today's machine-global path.
 */
import type { ThreadId } from "@t3tools/contracts";
import type * as Effect from "effect/Effect";

export interface ClaudeHardLimitCondition {
  readonly threadId: ThreadId;
  readonly rateLimitType: string;
  /** Unix seconds, when Claude reported one. */
  readonly resetAt: number | undefined;
}

export interface ClaudeHardLimitAccountsHook {
  /** Resolves `true` when the per-thread feature handled the rejection. */
  readonly handle: (condition: ClaudeHardLimitCondition) => Effect.Effect<boolean>;
}

let registeredHook: ClaudeHardLimitAccountsHook | undefined;

export function registerClaudeHardLimitAccountsHook(hook: ClaudeHardLimitAccountsHook): () => void {
  registeredHook = hook;
  return () => {
    if (registeredHook === hook) registeredHook = undefined;
  };
}

export function readClaudeHardLimitAccountsHook(): ClaudeHardLimitAccountsHook | undefined {
  return registeredHook;
}
