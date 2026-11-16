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

import type {
  HookCallback,
  HookCallbackMatcher,
  HookEvent,
  HookInput,
} from "@anthropic-ai/claude-agent-sdk";

import {
  ownerFromEnvironment,
  senderIdentityBlock,
  senderIdentityText,
  sessionIdentityText,
} from "../identity/senderIdentityText.ts";

/** Structural shape of the Claude SDK query options this module folds hooks into. */
interface ClaudeIdentityHookOptions {
  readonly hooks?: Partial<Record<HookEvent, HookCallbackMatcher[]>>;
}

/** Session-level text: the owner, and that each message carries its own CURRENT USER block. */
export function claudeSessionIdentitySystemPrompt(
  environment: NodeJS.ProcessEnv,
): string | undefined {
  const identity = sessionIdentityText(environment);
  return identity === undefined ? undefined : `T3 Code session identity:\n${identity}`;
}

/** Fallback block from the process environment, used before any message was recorded. */
export function claudeSessionIdentityTurnContext(
  environment: NodeJS.ProcessEnv,
): string | undefined {
  return senderIdentityText(environment);
}

/**
 * T3-CUSTOM(expbkt3): the identity block of each message sent to one Claude process.
 * Start and steer record it before the prompt is queued; the hook takes the block of
 * the matching prompt, else the latest one, so a steer or slash command keeps its own.
 */
export interface ClaudeTurnIdentity {
  readonly record: (prompt: string, identity: string | undefined) => void;
  readonly take: (prompt: string | undefined) => string | undefined;
}

const MAX_PENDING_PROMPTS = 32;

export function makeClaudeTurnIdentity(): ClaudeTurnIdentity {
  const pending: Array<{ readonly prompt: string; readonly identity: string }> = [];
  let latest: string | undefined;
  return {
    record: (prompt, identity) => {
      if (identity === undefined) return;
      pending.push({ prompt: prompt.trim(), identity });
      if (pending.length > MAX_PENDING_PROMPTS) pending.shift();
      latest = identity;
    },
    take: (prompt) => {
      const key = prompt?.trim();
      const index = pending.findIndex((entry) => entry.prompt === key);
      if (index === -1) return latest;
      const [entry] = pending.splice(index, 1);
      return entry?.identity ?? latest;
    },
  };
}

/**
 * A prompt the Claude CLI wrote itself: a task notification, an auto-continuation, a
 * loop or schedule wakeup. T3 sends every prompt it owns with source `sdk`.
 */
export function isNativeWake(input: HookInput): boolean {
  if (input.hook_event_name !== "UserPromptSubmit") return false;
  return input.source !== undefined && input.source !== "sdk" && input.source !== "user";
}

// T3-CUSTOM(expbkt3): the system prompt alone is not enough. Sonnet 5 still answered with
// the native `# userEmail` value, which arrives later in context. A `UserPromptSubmit`
// hook states the sender at user-message position on every prompt, which does win
// (verified 2026-08-21). Existing hooks are kept, so an upstream `hooks` option works.
export function withClaudeSessionIdentityTurnHook<Options extends ClaudeIdentityHookOptions>(
  options: Options,
  environment: NodeJS.ProcessEnv,
  turnIdentity?: ClaudeTurnIdentity,
): Options {
  const fallback = claudeSessionIdentityTurnContext(environment);
  if (fallback === undefined) {
    return options;
  }

  const automation = senderIdentityBlock({
    owner: ownerFromEnvironment(environment),
    sender: null,
  });
  const identityHook: HookCallback = async (input) => ({
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: isNativeWake(input)
        ? automation
        : (turnIdentity?.take("prompt" in input ? input.prompt : undefined) ?? fallback),
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
