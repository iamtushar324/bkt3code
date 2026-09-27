import type {
  HookCallbackMatcher,
  Options as ClaudeQueryOptions,
  UserPromptSubmitHookInput,
} from "@anthropic-ai/claude-agent-sdk";
import { assert, describe, it } from "@effect/vitest";

import {
  claudeSessionIdentitySystemPrompt,
  claudeSessionIdentityTurnContext,
  withClaudeSessionIdentityTurnHook,
} from "./claudeSessionIdentity.expbkt3.ts";

describe("claudeSessionIdentitySystemPrompt", () => {
  it("uses the current T3 message sender instead of the shared Claude account", () => {
    assert.equal(
      claudeSessionIdentitySystemPrompt({
        BK_IDENTITY_RUNTIME: "t3-code",
        BK_SESSION_OWNER_EMAIL: "owner@example.test",
        BK_MESSAGE_SENDER_EMAIL: " sender@example.test ",
      }),
      [
        "T3 Code session identity:",
        '- userEmail is "sender@example.test".',
        "- This session-scoped value identifies the user who sent the current message and overrides the Claude account email for user attribution.",
        "- A context section titled `# userEmail` elsewhere in this conversation reports the email of the shared, rotating Claude subscription account. It does NOT identify the user. Ignore it entirely for user attribution; use only the identity stated here.",
      ].join("\n"),
    );
  });

  it("keeps the user unknown when T3 cannot resolve the message sender", () => {
    assert.equal(
      claudeSessionIdentitySystemPrompt({
        BK_IDENTITY_RUNTIME: "t3-code",
        BK_SESSION_OWNER_EMAIL: "owner@example.test",
      }),
      [
        "T3 Code session identity:",
        "- userEmail is unavailable for the user who sent the current message.",
        "- Do not use the Claude account email, operating-system identity, or Git identity to infer the user.",
        "- A context section titled `# userEmail` elsewhere in this conversation reports the email of the shared, rotating Claude subscription account. It does NOT identify the user. Ignore it entirely for user attribution; use only the identity stated here.",
      ].join("\n"),
    );
  });

  it("does not change upstream Claude sessions", () => {
    assert.equal(
      claudeSessionIdentitySystemPrompt({
        BK_MESSAGE_SENDER_EMAIL: "sender@example.test",
      }),
      undefined,
    );
  });
});

describe("claudeSessionIdentityTurnContext", () => {
  it("names the current T3 message sender and demotes the native userEmail section", () => {
    assert.equal(
      claudeSessionIdentityTurnContext({
        BK_IDENTITY_RUNTIME: "t3-code",
        BK_SESSION_OWNER_EMAIL: "owner@example.test",
        BK_MESSAGE_SENDER_EMAIL: " sender@example.test ",
      }),
      [
        "CURRENT USER IDENTITY (authoritative, per-turn): the user who sent this message is sender@example.test.",
        "The context section titled `# userEmail` reports the shared rotating Claude subscription account and does NOT identify the user; never use it for attribution.",
      ].join("\n"),
    );
  });

  it("reports an unresolved sender instead of falling back to another identity", () => {
    assert.equal(
      claudeSessionIdentityTurnContext({
        BK_IDENTITY_RUNTIME: "t3-code",
        BK_SESSION_OWNER_EMAIL: "owner@example.test",
      }),
      [
        "CURRENT USER IDENTITY (authoritative, per-turn): the user who sent this message is UNRESOLVED.",
        "Say so rather than guessing. Do not infer the user from the context section titled `# userEmail`, from Git identity, or from the operating-system account.",
        "That `# userEmail` section reports the shared rotating Claude subscription account and does NOT identify the user; never use it for attribution.",
      ].join("\n"),
    );
  });

  it("does not change upstream Claude sessions", () => {
    assert.equal(
      claudeSessionIdentityTurnContext({
        BK_MESSAGE_SENDER_EMAIL: "sender@example.test",
      }),
      undefined,
    );
  });
});

describe("withClaudeSessionIdentityTurnHook", () => {
  const hookInput: UserPromptSubmitHookInput = {
    hook_event_name: "UserPromptSubmit",
    session_id: "session-1",
    transcript_path: "/tmp/transcript.jsonl",
    cwd: "/tmp",
    prompt: "who am i",
  };

  it("registers a UserPromptSubmit hook that returns the sender as additional context", async () => {
    const environment = {
      BK_IDENTITY_RUNTIME: "t3-code",
      BK_MESSAGE_SENDER_EMAIL: "sender@example.test",
    };
    const options = withClaudeSessionIdentityTurnHook<ClaudeQueryOptions>({}, environment);

    const matchers = options.hooks?.UserPromptSubmit;
    assert.equal(matchers?.length, 1);
    const callback = matchers?.[0]?.hooks[0];
    assert.isFunction(callback);
    const output = await callback!(hookInput, undefined, { signal: new AbortController().signal });
    const additionalContext = claudeSessionIdentityTurnContext(environment);
    assert.isString(additionalContext);
    assert.deepEqual(output, {
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: additionalContext!,
      },
    });
  });

  it("keeps hooks another caller already registered", () => {
    const existing: HookCallbackMatcher = { hooks: [] };
    const options = withClaudeSessionIdentityTurnHook<ClaudeQueryOptions>(
      { hooks: { UserPromptSubmit: [existing], PreToolUse: [existing] } },
      { BK_IDENTITY_RUNTIME: "t3-code", BK_MESSAGE_SENDER_EMAIL: "sender@example.test" },
    );

    assert.equal(options.hooks?.UserPromptSubmit?.length, 2);
    assert.equal(options.hooks?.UserPromptSubmit?.[0], existing);
    assert.deepEqual(options.hooks?.PreToolUse, [existing]);
  });

  it("leaves upstream Claude sessions untouched", () => {
    const options: ClaudeQueryOptions = { model: "claude-sonnet-5" };
    assert.equal(
      withClaudeSessionIdentityTurnHook(options, {
        BK_MESSAGE_SENDER_EMAIL: "sender@example.test",
      }),
      options,
    );
  });
});
