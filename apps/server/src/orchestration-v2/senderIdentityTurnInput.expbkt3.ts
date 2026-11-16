// T3-CUSTOM(expbkt3): every adapter without a native identity channel gets the sender
// block appended to the provider input of each turn. The stored message and the chat
// UI keep the user's text; only the copy handed to the adapter carries the block.

import { ProviderDriverKind } from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import type { ProviderSessionExecutionOptions } from "@t3tools/provider-core/server/sessionExecutionOptions.expbkt3";

import { appendSenderIdentityText, senderIdentityText } from "../identity/senderIdentityText.ts";

/**
 * Claude takes the block through its system prompt and `UserPromptSubmit` hook, Codex
 * as developer context. A remote turn runs on another T3 server, which resolves its own
 * sender, so local identity must not leak into the remote user's message.
 */
const DRIVERS_WITHOUT_APPENDED_IDENTITY: ReadonlySet<ProviderDriverKind> = new Set([
  ProviderDriverKind.make("claudeAgent"),
  ProviderDriverKind.make("codex"),
  ProviderDriverKind.make("remote"),
]);

export function withSenderIdentityTurnInput(
  input: ProviderAdapter.ProviderAdapterV2TurnInput,
  driver: ProviderDriverKind,
  identityEnvironment: NodeJS.ProcessEnv | undefined,
): ProviderAdapter.ProviderAdapterV2TurnInput {
  if (identityEnvironment === undefined || DRIVERS_WITHOUT_APPENDED_IDENTITY.has(driver)) {
    return input;
  }
  const text = appendSenderIdentityText(
    input.message.text,
    senderIdentityText(identityEnvironment),
  );
  return text === input.message.text ? input : { ...input, message: { ...input.message, text } };
}

/** Wraps a runtime's `startTurn` with the identity captured when its process opened. */
export function withSenderIdentityStartTurn(
  runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime,
  executionOptions: ProviderSessionExecutionOptions,
): ProviderAdapter.ProviderAdapterV2SessionRuntime["startTurn"] {
  return (input) =>
    runtime.startTurn(
      withSenderIdentityTurnInput(input, runtime.driver, executionOptions.identityEnvironment),
    );
}
