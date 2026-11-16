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
import { buildSessionIdentityEnvironment } from "../identity/SessionIdentityEnvironment.ts";
import { senderIdentityText } from "../identity/senderIdentityText.ts";

const humanEnvironment = buildSessionIdentityEnvironment({
  owner: { userId: "user_clerk_alice", name: "Alice Example", email: "owner@example.test" },
  sender: { userId: "user_clerk_bob", name: "Bob Example", email: " sender@example.test " },
});
const automationEnvironment = buildSessionIdentityEnvironment({
  owner: { userId: "user_clerk_alice", name: "Alice Example", email: "owner@example.test" },
  sender: null,
});

describe("claudeSessionIdentitySystemPrompt", () => {
  it("states the Clerk sender instead of the shared Claude account", () => {
    assert.equal(
      claudeSessionIdentitySystemPrompt(humanEnvironment),
      `T3 Code session identity:\n${senderIdentityText(humanEnvironment)}`,
    );
    const prompt = claudeSessionIdentitySystemPrompt(humanEnvironment)!;
    assert.include(
      prompt,
      "- Name: Bob Example\n- Email: sender@example.test\n- T3 user id: user_clerk_bob",
    );
    assert.include(prompt, "Session owner: Alice Example <owner@example.test>");
    assert.include(prompt, "`# userEmail`");
  });

  it("says no human sent the message when T3 has no sender", () => {
    assert.include(
      claudeSessionIdentitySystemPrompt(automationEnvironment)!,
      "CURRENT USER: no human sender for this message (automation).",
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
  it("restates the same identity block on every turn", () => {
    assert.equal(
      claudeSessionIdentityTurnContext(humanEnvironment),
      senderIdentityText(humanEnvironment),
    );
    assert.equal(
      claudeSessionIdentityTurnContext(automationEnvironment),
      senderIdentityText(automationEnvironment),
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
    const environment = humanEnvironment;
    const options = withClaudeSessionIdentityTurnHook<ClaudeQueryOptions>({}, environment);

    const matchers = options.hooks?.UserPromptSubmit;
    assert.equal(matchers?.length, 1);
    const callback = matchers?.[0]?.hooks[0];
    assert.isFunction(callback);
    const output = await callback!(hookInput, undefined, { signal: new AbortController().signal });
    const additionalContext = claudeSessionIdentityTurnContext(environment);
    assert.isString(additionalContext);
    assert.include(additionalContext!, "- Name: Bob Example");
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
