// T3-CUSTOM(expbkt3): proves the Claude query hook names each prompt's own sender, and
// automation for a native wake (task notification, auto-continuation) that T3 never sent.
import type { HookInput, UserPromptSubmitHookInput } from "@anthropic-ai/claude-agent-sdk";
import { ProviderInstanceId, type ModelSelection } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";

import { buildSessionIdentityEnvironment } from "../../identity/SessionIdentityEnvironment.ts";
import { senderIdentityBlock } from "../../identity/senderIdentityText.ts";
import { makeClaudeTurnIdentity } from "../../provider/claudeSessionIdentity.expbkt3.ts";
import * as ClaudeAdapterV2 from "./ClaudeAdapterV2.ts";

const MODEL_SELECTION = {
  instanceId: ProviderInstanceId.make(ClaudeAdapterV2.CLAUDE_PROVIDER),
  model: "claude-sonnet-4-6",
} satisfies ModelSelection;
const alice = { userId: "user_clerk_alice", name: "Alice Example", email: "alice@example.com" };

const prompt = (
  text: string,
  source: UserPromptSubmitHookInput["source"],
): UserPromptSubmitHookInput => ({
  hook_event_name: "UserPromptSubmit",
  session_id: "session-1",
  transcript_path: "/tmp/transcript.jsonl",
  cwd: "/workspace",
  prompt: text,
  ...(source === undefined ? {} : { source }),
});

it("names the human for a T3 prompt and automation for a native wake that follows it", async () => {
  const environment = buildSessionIdentityEnvironment({ owner: alice, sender: alice });
  const turnIdentity = makeClaudeTurnIdentity();
  const options = ClaudeAdapterV2.makeClaudeQueryOptions({
    modelSelection: MODEL_SELECTION,
    nativeThreadId: "native-identity",
    resume: false,
    cwd: "/workspace",
    environment,
    turnIdentity,
  });
  const hooks = (options.hooks?.UserPromptSubmit ?? []).flatMap((matcher) => matcher.hooks);
  assert.equal(hooks.length, 1);
  const run = async (input: HookInput) => {
    const output = (await hooks[0]!(input, undefined, { signal: AbortSignal.abort() })) as {
      readonly hookSpecificOutput?: { readonly additionalContext?: string };
    };
    return output.hookSpecificOutput?.additionalContext;
  };

  const human = senderIdentityBlock({ owner: alice, sender: alice, messageId: "message-1" });
  turnIdentity.record("Run the tests in the background.", human);
  assert.equal(await run(prompt("Run the tests in the background.", "sdk")), human);

  const automation = senderIdentityBlock({ owner: alice, sender: null });
  for (const source of ["system", "loop_wakeup", "schedule_wakeup", "poll_event"] as const) {
    const wake = prompt("<task-notification>tests passed</task-notification>", source);
    const context = await run(wake);
    assert.equal(context, automation);
    assert.notInclude(context!, '- Name: "Alice Example"');
  }
});
