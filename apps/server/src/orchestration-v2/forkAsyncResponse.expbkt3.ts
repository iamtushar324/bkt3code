// T3-CUSTOM(expbkt3): retained BK behavior at the native V2 boundary.
/** Native answers to BK questions use a normal message and an atomic activity resolution. */
import {
  UserInputRequestedPayload,
  type OrchestrationV2TurnItem,
  type ProviderUserInputAnswers,
  type UserInputAttachments,
} from "@t3tools/contracts";
import { OrchestrationThreadActivity } from "@t3tools/contracts/orchestration";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

export function findForkAsyncRequest(
  items: ReadonlyArray<OrchestrationV2TurnItem>,
  requestId: string,
): OrchestrationThreadActivity | undefined {
  for (const item of items.toSorted((a, b) => b.ordinal - a.ordinal || b.id.localeCompare(a.id))) {
    if (
      item.type !== "dynamic_tool" ||
      !Predicate.isObject(item.input) ||
      !("forkLegacyActivity" in item.input)
    )
      continue;
    const activity = Schema.decodeUnknownOption(OrchestrationThreadActivity)(
      item.input.forkLegacyActivity,
    );
    if (
      Option.isSome(activity) &&
      Predicate.isObject(activity.value.payload) &&
      activity.value.payload.requestId === requestId
    )
      return activity.value;
  }
  return undefined;
}

export function forkAsyncAnswer(
  request: OrchestrationThreadActivity | undefined,
  answers: ProviderUserInputAnswers | undefined,
  attachmentsByQuestionId: UserInputAttachments | undefined,
): Result.Result<
  { readonly text: string; readonly attachments: UserInputAttachments[string] },
  string
> {
  if (request?.kind !== "user-input.requested")
    return Result.fail("This question has already been answered.");
  const payload = Schema.decodeUnknownOption(UserInputRequestedPayload)(request.payload);
  if (Option.isNone(payload) || payload.value.responseMode !== "message")
    return Result.fail("This question is no longer pending.");
  const replies: string[] = [];
  for (const questionId of Object.keys(attachmentsByQuestionId ?? {})) {
    const question = payload.value.questions.find((question) => question.id === questionId);
    if (question === undefined || question.allowCustomAnswer === false)
      return Result.fail("This question does not accept file references.");
  }
  for (const question of payload.value.questions) {
    const answer = answers?.[question.id];
    const attachments = attachmentsByQuestionId?.[question.id] ?? [];
    if (typeof answer !== "string" || (answer.trim().length === 0 && attachments.length === 0))
      return Result.fail("Answer each question before sending.");
    const labels = attachments
      .map((attachment) => `Attached file: ${attachment.name} (${attachment.id})`)
      .join("\n");
    replies.push([`${question.question}\n${answer.trim()}`, labels].filter(Boolean).join("\n"));
  }
  return Result.succeed({
    text: replies.join("\n\n"),
    attachments: Object.values(attachmentsByQuestionId ?? {}).flat(),
  });
}
