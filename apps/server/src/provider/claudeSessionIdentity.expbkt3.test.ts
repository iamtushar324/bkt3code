import type {
  HookCallbackMatcher,
  Options as ClaudeQueryOptions,
  UserPromptSubmitHookInput,
} from "@anthropic-ai/claude-agent-sdk";
import { assert, describe, it } from "@effect/vitest";

import {
  claudeSessionIdentitySystemPrompt,
  claudeSessionIdentityTurnContext,
  makeClaudeTurnIdentity,
  withClaudeSessionIdentityTurnHook,
} from "./claudeSessionIdentity.expbkt3.ts";
import { buildSessionIdentityEnvironment } from "../identity/SessionIdentityEnvironment.ts";
import { senderIdentityText, sessionIdentityText } from "../identity/senderIdentityText.ts";

const humanEnvironment = buildSessionIdentityEnvironment({
  owner: { userId: "user_clerk_alice", name: "Alice Example", email: "owner@example.test" },
  sender: { userId: "user_clerk_bob", name: "Bob Example", email: " sender@example.test " },
});
const automationEnvironment = buildSessionIdentityEnvironment({
  owner: { userId: "user_clerk_alice", name: "Alice Example", email: "owner@example.test" },
  sender: null,
});

describe("claudeSessionIdentitySystemPrompt", () => {
  it("states the owner and leaves the sender to each message", () => {
    assert.equal(
      claudeSessionIdentitySystemPrompt(humanEnvironment),
      `T3 Code session identity:\n${sessionIdentityText(humanEnvironment)}`,
    );
    const prompt = claudeSessionIdentitySystemPrompt(humanEnvironment)!;
    assert.include(prompt, 'Session owner: "Alice Example", "owner@example.test"');
    assert.include(prompt, "Each user message carries a CURRENT USER block");
    assert.include(prompt, "`# userEmail`");
    assert.notInclude(prompt, "Bob Example");
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

describe("makeClaudeTurnIdentity", () => {
  it("returns each prompt's own block, and the latest one for an unmatched prompt", () => {
    const store = makeClaudeTurnIdentity();
    assert.isUndefined(store.take("hello"));
    store.record("hello", "ALICE");
    store.record("scheduled check", "AUTOMATION");
    store.record("/review", "BOB");
    assert.equal(store.take("scheduled check"), "AUTOMATION");
    assert.equal(store.take(" hello "), "ALICE");
    assert.equal(store.take("/review"), "BOB");
    assert.equal(store.take("expanded command text"), "BOB");
  });

  it("ignores a message that has no block", () => {
    const store = makeClaudeTurnIdentity();
    store.record("hello", "ALICE");
    store.record("next", undefined);
    assert.equal(store.take("next"), "ALICE");
  });
});

describe("withClaudeSessionIdentityTurnHook", () => {
  const hookInput = (prompt: string): UserPromptSubmitHookInput => ({
    hook_event_name: "UserPromptSubmit",
    session_id: "session-1",
    transcript_path: "/tmp/transcript.jsonl",
    cwd: "/tmp",
    prompt,
  });
  const signal = { signal: new AbortController().signal };

  it("returns the block recorded for each prompt, steers and slash commands included", async () => {
    const store = makeClaudeTurnIdentity();
    const options = withClaudeSessionIdentityTurnHook<ClaudeQueryOptions>(
      {},
      humanEnvironment,
      store,
    );
    const matchers = options.hooks?.UserPromptSubmit;
    assert.equal(matchers?.length, 1);
    const callback = matchers?.[0]?.hooks[0];
    assert.isFunction(callback);
    store.record("hello", "ALICE BLOCK");
    store.record("steer from a schedule", "AUTOMATION BLOCK");
    store.record("/review", "BOB BLOCK");
    for (const [prompt, block] of [
      ["hello", "ALICE BLOCK"],
      ["steer from a schedule", "AUTOMATION BLOCK"],
      ["/review", "BOB BLOCK"],
    ] as const) {
      assert.deepEqual(await callback!(hookInput(prompt), undefined, signal), {
        hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: block },
      });
    }
  });

  it("falls back to the process sender before any prompt was recorded", async () => {
    const options = withClaudeSessionIdentityTurnHook<ClaudeQueryOptions>({}, humanEnvironment);
    const callback = options.hooks?.UserPromptSubmit?.[0]?.hooks[0];
    const additionalContext = claudeSessionIdentityTurnContext(humanEnvironment);
    assert.include(additionalContext!, '- Name: "Bob Example"');
    assert.deepEqual(await callback!(hookInput("who am i"), undefined, signal), {
      hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext },
    });
    assert.equal(
      senderIdentityText(automationEnvironment),
      claudeSessionIdentityTurnContext(automationEnvironment),
    );
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
