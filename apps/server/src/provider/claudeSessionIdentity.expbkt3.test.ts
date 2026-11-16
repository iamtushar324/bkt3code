import type {
  HookCallbackMatcher,
  Options as ClaudeQueryOptions,
  SDKUserMessage,
  UserPromptSubmitHookInput,
} from "@anthropic-ai/claude-agent-sdk";
import { assert, describe, it } from "@effect/vitest";

import {
  claudePromptTexts,
  claudeSessionIdentitySystemPrompt,
  makeClaudeTurnIdentity,
  withClaudeSessionIdentityTurnHook,
} from "./claudeSessionIdentity.expbkt3.ts";
import { buildSessionIdentityEnvironment } from "../identity/SessionIdentityEnvironment.ts";
import { senderIdentityBlock, sessionIdentityText } from "../identity/senderIdentityText.ts";

const humanEnvironment = buildSessionIdentityEnvironment({
  owner: { userId: "user_clerk_alice", name: "Alice Example", email: "owner@example.test" },
  sender: { userId: "user_clerk_bob", name: "Bob Example", email: " sender@example.test " },
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
  it("returns a block only for a prompt T3 recorded exactly, once", () => {
    const store = makeClaudeTurnIdentity();
    assert.isUndefined(store.take("hello"));
    store.record(["hello"], "ALICE");
    store.record(["scheduled check"], "AUTOMATION");
    store.record(["/review", "ignored"], "BOB");
    assert.equal(store.take("scheduled check"), "AUTOMATION");
    assert.equal(store.take(" hello "), "ALICE");
    assert.isUndefined(store.take("hello"));
    assert.isUndefined(store.take("expanded command text"));
    assert.equal(store.take("/review"), "BOB");
    assert.isUndefined(store.take("ignored"));
    assert.isUndefined(store.take(undefined));
  });

  it("ignores a message that has no block or no text", () => {
    const store = makeClaudeTurnIdentity();
    store.record(["next"], undefined);
    store.record(["  "], "ALICE");
    assert.isUndefined(store.take("next"));
    assert.isUndefined(store.take(""));
  });
});

describe("claudePromptTexts", () => {
  it("lists the string content, each text block and the joined text blocks", () => {
    const message = (content: SDKUserMessage["message"]["content"]) =>
      ({
        type: "user",
        message: { role: "user", content },
        parent_tool_use_id: null,
      }) as SDKUserMessage;
    assert.deepEqual(claudePromptTexts(message("hello")), ["hello"]);
    assert.deepEqual(
      claudePromptTexts(
        message([
          { type: "text", text: "a" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "" } },
          { type: "text", text: "b" },
        ]),
      ),
      ["a", "b", "a\nb", "a\n\nb", "ab"],
    );
  });
});

describe("withClaudeSessionIdentityTurnHook", () => {
  const hookInput = (
    prompt: string,
    source?: UserPromptSubmitHookInput["source"],
  ): UserPromptSubmitHookInput => ({
    hook_event_name: "UserPromptSubmit",
    session_id: "session-1",
    transcript_path: "/tmp/transcript.jsonl",
    cwd: "/tmp",
    prompt,
    ...(source === undefined ? {} : { source }),
  });
  const signal = { signal: new AbortController().signal };
  const automation = senderIdentityBlock({
    owner: { userId: "user_clerk_alice", name: "Alice Example", email: "owner@example.test" },
    sender: null,
  });
  const output = (additionalContext: string) => ({
    hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext },
  });

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
    store.record(["hello"], "ALICE BLOCK");
    store.record(["steer from a schedule"], "AUTOMATION BLOCK");
    store.record(["/review"], "BOB BLOCK");
    for (const [prompt, block] of [
      ["hello", "ALICE BLOCK"],
      ["steer from a schedule", "AUTOMATION BLOCK"],
      ["/review", "BOB BLOCK"],
    ] as const) {
      assert.deepEqual(await callback!(hookInput(prompt, "sdk"), undefined, signal), output(block));
    }
  });

  it("names automation for every prompt T3 did not record, with or without a source", async () => {
    const store = makeClaudeTurnIdentity();
    const options = withClaudeSessionIdentityTurnHook<ClaudeQueryOptions>(
      {},
      humanEnvironment,
      store,
    );
    const callback = options.hooks?.UserPromptSubmit?.[0]?.hooks[0];
    store.record(["Run the tests in the background."], "ALICE BLOCK");
    assert.deepEqual(
      await callback!(hookInput("Run the tests in the background."), undefined, signal),
      output("ALICE BLOCK"),
    );
    const wake = "<task-notification>tests passed</task-notification>";
    assert.deepEqual(await callback!(hookInput(wake), undefined, signal), output(automation));
    assert.deepEqual(
      await callback!(hookInput(wake, "sdk"), undefined, signal),
      output(automation),
    );
    assert.deepEqual(
      await callback!(hookInput(wake, "system"), undefined, signal),
      output(automation),
    );
    assert.notInclude(automation, "Bob Example");
  });

  it("never names the process sender when no prompt was recorded", async () => {
    const options = withClaudeSessionIdentityTurnHook<ClaudeQueryOptions>({}, humanEnvironment);
    const callback = options.hooks?.UserPromptSubmit?.[0]?.hooks[0];
    assert.deepEqual(
      await callback!(hookInput("who am i", "sdk"), undefined, signal),
      output(automation),
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
