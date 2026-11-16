// T3-CUSTOM(expbkt3): Claude Code derives its native `userEmail` context from
// the authenticated Claude account. Beknown runs that account on a shared
// machine, so it identifies the subscription rather than the person sending
// the current T3 message. Append the session-scoped identity to Claude's native
// system prompt without changing the account used for authentication.
//
// The CLI offers no way to suppress its own `# userEmail` section, and the
// rotating profile makes its value flap, so the appended block also names that
// section and countermands it explicitly. Without that, two contradictory
// identity claims coexist and the model follows the one that arrives last.
//
// The append is the belt; the `UserPromptSubmit` hook below is the braces. Only
// the hook reliably beats the native section on smaller models, because it puts
// the sender at user-message position on every turn rather than in the system
// prompt. Both are gated on the same runtime marker.

import type { HookCallback, HookCallbackMatcher, HookEvent } from "@anthropic-ai/claude-agent-sdk";

import { senderIdentityText } from "../identity/senderIdentityText.ts";

/** Structural shape of the Claude SDK query options this module folds hooks into. */
interface ClaudeIdentityHookOptions {
  readonly hooks?: Partial<Record<HookEvent, HookCallbackMatcher[]>>;
}

export function claudeSessionIdentitySystemPrompt(
  environment: NodeJS.ProcessEnv,
): string | undefined {
  const identity = senderIdentityText(environment);
  return identity === undefined ? undefined : `T3 Code session identity:\n${identity}`;
}

// T3-CUSTOM(expbkt3): the appended system prompt alone is not enough. Sonnet 5 still
// answered with the native `# userEmail` value, which arrives later in context. A
// `UserPromptSubmit` hook re-states the sender at user-message position on every turn,
// which does win (verified 2026-08-21).
export function claudeSessionIdentityTurnContext(
  environment: NodeJS.ProcessEnv,
): string | undefined {
  return senderIdentityText(environment);
}

/**
 * T3-CUSTOM(expbkt3): folds the per-turn identity hook into Claude SDK query
 * options. Merges with whatever hooks the caller already registered instead of
 * replacing them, so an upstream `hooks` option keeps working after a merge.
 */
export function withClaudeSessionIdentityTurnHook<Options extends ClaudeIdentityHookOptions>(
  options: Options,
  environment: NodeJS.ProcessEnv,
): Options {
  const additionalContext = claudeSessionIdentityTurnContext(environment);
  if (additionalContext === undefined) {
    return options;
  }

  const identityHook: HookCallback = async () => ({
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext,
    },
  });
  const existingHooks = options.hooks ?? {};

  return {
    ...options,
    hooks: {
      ...existingHooks,
      UserPromptSubmit: [...(existingHooks.UserPromptSubmit ?? []), { hooks: [identityHook] }],
    },
  };
}
