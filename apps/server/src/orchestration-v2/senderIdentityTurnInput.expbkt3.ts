// T3-CUSTOM(expbkt3): every turn and steer carries the identity block of its own
// message on `message.senderIdentity`. Claude and Codex read that field through their
// native context channels; every other adapter gets it appended to the provider copy
// of the text. The stored message and the chat UI keep the user's text.

import { ProviderDriverKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import type { ProviderSessionExecutionOptions } from "@t3tools/provider-core/server/sessionExecutionOptions.expbkt3";

import { describeMessageSender } from "../identity/messageSenderIdentity.ts";
import type { SessionIdentityEnvironmentService } from "../identity/SessionIdentityEnvironment.ts";
import { appendSenderIdentityText } from "../identity/senderIdentityText.ts";

/**
 * Claude takes the block through its `UserPromptSubmit` hook, Codex as developer context.
 * A remote turn runs on another T3 server, which resolves its own sender, so local
 * identity must not leak into the remote user's message.
 */
const DRIVERS_WITHOUT_APPENDED_IDENTITY: ReadonlySet<ProviderDriverKind> = new Set([
  ProviderDriverKind.make("claudeAgent"),
  ProviderDriverKind.make("codex"),
  ProviderDriverKind.make("remote"),
]);

/**
 * Sets the block on the message and, for adapters without a native channel, appends it
 * to the text. A slash command keeps its text, so the adapter still parses the command.
 */
export function withSenderIdentityMessage(
  message: ProviderAdapter.ProviderAdapterV2TurnMessage,
  driver: ProviderDriverKind,
  identity: string | undefined,
): ProviderAdapter.ProviderAdapterV2TurnMessage {
  if (identity === undefined) return message;
  const appends =
    !DRIVERS_WITHOUT_APPENDED_IDENTITY.has(driver) && !message.text.trimStart().startsWith("/");
  return {
    ...message,
    senderIdentity: identity,
    ...(appends ? { text: appendSenderIdentityText(message.text, identity) } : {}),
  };
}

type WithMessage = { readonly message: ProviderAdapter.ProviderAdapterV2TurnMessage };

/** Wraps a runtime's `startTurn` and `steerTurn` with the identity of each message. */
export function withSenderIdentityRuntime(
  runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime,
  executionOptions: ProviderSessionExecutionOptions,
  identityService: Option.Option<SessionIdentityEnvironmentService["Service"]>,
): Pick<ProviderAdapter.ProviderAdapterV2SessionRuntime, "startTurn" | "steerTurn"> {
  const identified = <Input extends WithMessage>(input: Input): Effect.Effect<Input> =>
    Effect.gen(function* () {
      if (Option.isNone(identityService)) return input;
      const identity = yield* describeMessageSender(
        identityService.value,
        executionOptions.identityEnvironment,
        input.message,
      );
      return {
        ...input,
        message: withSenderIdentityMessage(input.message, runtime.driver, identity),
      };
    });
  return {
    startTurn: (input) => identified(input).pipe(Effect.flatMap(runtime.startTurn)),
    steerTurn: (input) => identified(input).pipe(Effect.flatMap(runtime.steerTurn)),
  };
}
