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
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

import {
  ownerFromEnvironment,
  senderIdentityBlock,
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

/**
 * T3-CUSTOM(expbkt3): the identity block of each prompt T3 queued on one Claude process.
 * The hook names a human only for a prompt that equals one of these exactly; every other
 * prompt (a native wake, an unknown prompt) gets the automation block.
 */
export interface ClaudeTurnIdentity {
  readonly record: (prompts: ReadonlyArray<string>, identity: string | undefined) => void;
  readonly take: (prompt: string | undefined) => string | undefined;
}

const MAX_PENDING_PROMPTS = 32;

export function makeClaudeTurnIdentity(): ClaudeTurnIdentity {
  const pending: Array<{ readonly prompts: ReadonlySet<string>; readonly identity: string }> = [];
  return {
    record: (prompts, identity) => {
      const exact = new Set(prompts.map((prompt) => prompt.trim()).filter((p) => p.length > 0));
      if (identity === undefined || exact.size === 0) return;
      pending.push({ prompts: exact, identity });
      if (pending.length > MAX_PENDING_PROMPTS) pending.shift();
    },
    take: (prompt) => {
      const key = prompt?.trim();
      if (key === undefined || key.length === 0) return undefined;
      const index = pending.findIndex((entry) => entry.prompts.has(key));
      if (index === -1) return undefined;
      return pending.splice(index, 1)[0]?.identity;
    },
  };
}

/**
 * The texts of a queued Claude user message that the CLI can report as the hook prompt:
 * the string content, each text block, and the text blocks joined.
 */
export function claudePromptTexts(message: SDKUserMessage): ReadonlyArray<string> {
  const content = message.message.content;
  if (typeof content === "string") return [content];
  const texts = content.flatMap((block) => (block.type === "text" ? [block.text] : []));
  return [...texts, texts.join("\n"), texts.join("\n\n"), texts.join("")];
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
  if (sessionIdentityText(environment) === undefined) {
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
        : (turnIdentity?.take("prompt" in input ? input.prompt : undefined) ?? automation),
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
