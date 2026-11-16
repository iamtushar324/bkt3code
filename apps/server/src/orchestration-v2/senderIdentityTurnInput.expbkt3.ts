// T3-CUSTOM(expbkt3): every turn and steer carries the identity block of its own
// message on `message.senderIdentity`. Claude and Codex read that field through their
// native context channels; every other adapter gets it appended to the provider copy
// of a normal message. Identity text never enters a slash command.

import { ProviderDriverKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import type { ProviderSessionExecutionOptions } from "@t3tools/provider-core/server/sessionExecutionOptions.expbkt3";

import { describeMessageSender, humanSenderOf } from "../identity/messageSenderIdentity.ts";
import type { SessionIdentityEnvironmentService } from "../identity/SessionIdentityEnvironment.ts";
import { appendSenderIdentityText } from "../identity/senderIdentityText.ts";
import { isNativeMaintenanceCommand } from "./CommandPolicy.ts";

/**
 * Claude takes the block through its `UserPromptSubmit` hook, Codex as developer context.
 * A remote turn runs on another T3 server, which resolves its own sender, so local
 * identity must not leak into the remote user's message.
 */
const DRIVERS_WITH_OWN_IDENTITY_CHANNEL: ReadonlySet<ProviderDriverKind> = new Set([
  ProviderDriverKind.make("claudeAgent"),
  ProviderDriverKind.make("codex"),
  ProviderDriverKind.make("remote"),
]);

/** The sender a block names: a T3 user id, or automation. */
const AUTOMATION_SENDER = "automation";

export const SENDER_IDENTITY_REQUIRED_MESSAGE =
  "Send a normal message first so the agent knows who you are, then repeat the command.";

/**
 * A slash command on an adapter whose only channel is the message text, sent before the
 * agent was told who sends it. Templates and shells expand command arguments, so the
 * identity cannot ride inside the command.
 */
export class SenderIdentityRequiredError extends Schema.TaggedError<SenderIdentityRequiredError>()(
  "SenderIdentityRequiredError",
  {},
) {
  override get message(): string {
    return SENDER_IDENTITY_REQUIRED_MESSAGE;
  }
}

export interface PreparedSenderIdentity {
  readonly message: ProviderAdapter.ProviderAdapterV2TurnMessage;
  /** Set when this message delivers its sender to the model. */
  readonly delivers?: string;
  readonly rejected: boolean;
}

/**
 * Decides how one message carries its identity. `lastDelivered` is the sender whose
 * block this provider thread last received through the message text.
 */
export function prepareSenderIdentity(input: {
  readonly message: ProviderAdapter.ProviderAdapterV2TurnMessage;
  readonly driver: ProviderDriverKind;
  readonly identity: string | undefined;
  readonly sender: string;
  readonly lastDelivered: string | undefined;
}): PreparedSenderIdentity {
  const { message, identity } = input;
  if (identity === undefined) return { message, rejected: false };
  const identified = { ...message, senderIdentity: identity };
  if (DRIVERS_WITH_OWN_IDENTITY_CHANNEL.has(input.driver) || isNativeMaintenanceCommand(message)) {
    return { message: identified, rejected: false };
  }
  if (message.text.trimStart().startsWith("/")) {
    return { message: identified, rejected: input.lastDelivered !== input.sender };
  }
  return {
    message: { ...identified, text: appendSenderIdentityText(message.text, identity) },
    delivers: input.sender,
    rejected: false,
  };
}

/** Wraps a runtime's `startTurn` and `steerTurn` with the identity of each message. */
export function withSenderIdentityRuntime(
  runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime,
  executionOptions: ProviderSessionExecutionOptions,
  identityService: Option.Option<SessionIdentityEnvironmentService["Service"]>,
): Pick<ProviderAdapter.ProviderAdapterV2SessionRuntime, "startTurn" | "steerTurn"> {
  const lastDelivered = new Map<string, string>();
  const prepare = Effect.fn("SenderIdentity.prepare")(function* (
    message: ProviderAdapter.ProviderAdapterV2TurnMessage,
    providerThreadId: string,
  ) {
    if (Option.isNone(identityService)) return { message, rejected: false };
    const identity = yield* describeMessageSender(
      identityService.value,
      executionOptions.identityEnvironment,
      message,
    );
    if (identity === undefined) return { message, rejected: false };
    return prepareSenderIdentity({
      message,
      driver: runtime.driver,
      identity,
      sender: humanSenderOf(message) ?? AUTOMATION_SENDER,
      lastDelivered: lastDelivered.get(providerThreadId),
    });
  });
  const remember = (providerThreadId: string, prepared: PreparedSenderIdentity) =>
    Effect.sync(() => {
      if (prepared.delivers !== undefined) lastDelivered.set(providerThreadId, prepared.delivers);
    });
  return {
    startTurn: (input) =>
      prepare(input.message, input.providerThread.id).pipe(
        Effect.flatMap((prepared) =>
          prepared.rejected
            ? Effect.fail(
                new ProviderAdapter.ProviderAdapterTurnStartError({
                  driver: runtime.driver,
                  threadId: input.threadId,
                  providerThreadId: input.providerThread.id,
                  runId: input.runId,
                  cause: new SenderIdentityRequiredError(),
                }),
              )
            : Effect.andThen(
                runtime.startTurn({ ...input, message: prepared.message }),
                remember(input.providerThread.id, prepared),
              ),
        ),
      ),
    steerTurn: (input) =>
      prepare(input.message, input.providerThread.id).pipe(
        Effect.flatMap((prepared) =>
          prepared.rejected
            ? Effect.fail(
                new ProviderAdapter.ProviderAdapterSteerRunError({
                  driver: runtime.driver,
                  providerThreadId: input.providerThread.id,
                  providerTurnId: input.providerTurnId,
                  cause: new SenderIdentityRequiredError(),
                }),
              )
            : Effect.andThen(
                runtime.steerTurn({ ...input, message: prepared.message }),
                remember(input.providerThread.id, prepared),
              ),
        ),
      ),
  };
}
