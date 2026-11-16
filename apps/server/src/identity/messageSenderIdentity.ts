// T3-CUSTOM(expbkt3): attribution of the exact message being answered. The process
// environment names the credential actor, which a continuation or an owner-bound
// schedule reuses; only a message a person typed in a T3 client names a human sender.

import type {
  OrchestrationV2Actor,
  OrchestrationV2CreationSource,
  UserId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import {
  SESSION_IDENTITY_RUNTIME,
  SESSION_IDENTITY_RUNTIME_KEY,
  type SessionIdentityEnvironmentService,
} from "./SessionIdentityEnvironment.ts";
import { ownerFromEnvironment, senderIdentityBlock } from "./senderIdentityText.ts";

export interface MessageAttribution {
  readonly messageId: string;
  readonly sentByUserId?: UserId | null | undefined;
  readonly createdBy: OrchestrationV2Actor;
  readonly creationSource: OrchestrationV2CreationSource;
  readonly scheduledTaskId?: string | undefined;
  readonly senderThreadId?: string | undefined;
}

/**
 * The human who typed this message, or null. Schedules record their owner as sender,
 * agents and other sessions send through MCP, and the server writes continuations and
 * usage-limit resumes, so each of those is automation even with a sender id.
 */
export function humanSenderOf(message: MessageAttribution): UserId | null {
  if (message.sentByUserId == null || message.createdBy !== "user") return null;
  if (message.creationSource !== "web" && message.creationSource !== "mobile") return null;
  if (message.scheduledTaskId !== undefined || message.senderThreadId !== undefined) return null;
  return message.sentByUserId;
}

/** The identity block for one message; undefined outside T3 Code. */
export const describeMessageSender = Effect.fn("describeMessageSender")(function* (
  identity: SessionIdentityEnvironmentService["Service"],
  identityEnvironment: NodeJS.ProcessEnv | undefined,
  message: MessageAttribution,
) {
  if (identityEnvironment?.[SESSION_IDENTITY_RUNTIME_KEY] !== SESSION_IDENTITY_RUNTIME) {
    return undefined;
  }
  const human = humanSenderOf(message);
  const sender = human === null ? null : yield* identity.resolvePerson(human);
  return senderIdentityBlock({
    owner: ownerFromEnvironment(identityEnvironment),
    sender,
    messageId: message.messageId,
  });
});
