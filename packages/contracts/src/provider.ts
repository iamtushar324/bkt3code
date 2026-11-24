import * as Schema from "effect/Schema";
import { IsoDateTime, ProviderThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ThreadId } from "./baseSchemas.ts";
import {
  getProviderAttachmentLimitError,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  ChatAttachment,
} from "./chatAttachment.ts";
import { ModelSelection } from "./modelSelection.ts";
import { ProviderInteractionMode } from "./providerPolicy.ts";
import { SignInUrl } from "./providerSetup.ts";
// T3-CUSTOM(expbkt3): BEGIN — retained V1 provider session schema for fork provider-session
// readers (ForkProviderSessions, Claude account rotation); upstream removed it as unused.
import { TurnId } from "./baseSchemas.ts";
import { RuntimeMode } from "./providerPolicy.ts";
import { ProviderInstanceId, ProviderDriverKind } from "./providerInstance.ts";

const ProviderSessionStatus = Schema.Literals([
  "connecting",
  "ready",
  "running",
  "error",
  "closed",
]);

export const ProviderSession = Schema.Struct({
  provider: ProviderDriverKind,
  providerInstanceId: Schema.optional(ProviderInstanceId),
  status: ProviderSessionStatus,
  runtimeMode: RuntimeMode,
  cwd: Schema.optional(TrimmedNonEmptyString),
  model: Schema.optional(TrimmedNonEmptyString),
  threadId: ThreadId,
  resumeCursor: Schema.optional(Schema.Unknown),
  activeTurnId: Schema.optional(TurnId),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  lastError: Schema.optional(TrimmedNonEmptyString),
});
export type ProviderSession = typeof ProviderSession.Type;
// T3-CUSTOM(expbkt3): END

export const ProviderSendTurnInput = Schema.Struct({
  threadId: ThreadId,
  // T3-CUSTOM(expbkt3): BEGIN — stable durable dispatch/adoption correlation.
  clientExecutionId: Schema.optional(TrimmedNonEmptyString),
  // T3-CUSTOM(expbkt3): END
  /** Internal recovery: permits empty turns only for adapters supporting promptless continuation. */
  continuation: Schema.optional(Schema.Boolean),
  input: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_INPUT_CHARS)),
  ),
  attachments: Schema.optional(
    Schema.Array(ChatAttachment).check(
      Schema.makeFilter((attachments) => getProviderAttachmentLimitError(attachments) ?? true),
    ),
  ),
  modelSelection: Schema.optional(ModelSelection),
  interactionMode: Schema.optional(ProviderInteractionMode),
});
export type ProviderSendTurnInput = typeof ProviderSendTurnInput.Type;

export const ProviderUploadFeedbackInput = Schema.Struct({
  threadId: ThreadId,
  reason: Schema.optional(TrimmedNonEmptyString),
});
export type ProviderUploadFeedbackInput = typeof ProviderUploadFeedbackInput.Type;

export const ProviderUploadFeedbackResult = Schema.Struct({
  feedbackId: TrimmedNonEmptyString,
});
export type ProviderUploadFeedbackResult = typeof ProviderUploadFeedbackResult.Type;

const McpServerName = TrimmedNonEmptyString.check(Schema.isMaxLength(256));

/** One of an agent's MCP servers, in the thread whose session asked for a sign-in. */
export const ProviderMcpSignInStartInput = Schema.Struct({
  threadId: ThreadId,
  providerThreadId: ProviderThreadId,
  server: McpServerName,
});
export type ProviderMcpSignInStartInput = typeof ProviderMcpSignInStartInput.Type;

export const ProviderMcpSignInStartResult = Schema.Struct({
  /** The page to approve the sign-in on; null when the server needs none any more. */
  authorizationUrl: Schema.NullOr(SignInUrl),
  /** The environment's time when it found the server already signed in. */
  signedInAt: Schema.NullOr(IsoDateTime),
});
export type ProviderMcpSignInStartResult = typeof ProviderMcpSignInStartResult.Type;

export const ProviderMcpSignInCompleteInput = Schema.Struct({
  ...ProviderMcpSignInStartInput.fields,
  /** The address the browser was sent to after approving, usually a localhost page. */
  callbackUrl: TrimmedNonEmptyString.check(Schema.isMaxLength(16_384)),
});
export type ProviderMcpSignInCompleteInput = typeof ProviderMcpSignInCompleteInput.Type;

export const ProviderMcpSignInCompleteResult = Schema.Struct({
  /** The environment's time, so a later notice that needs a sign-in again offers one. */
  signedInAt: IsoDateTime,
});
export type ProviderMcpSignInCompleteResult = typeof ProviderMcpSignInCompleteResult.Type;

/** Safe to show: never carries the callback URL, codes or tokens. */
export class ProviderMcpSignInError extends Schema.TaggedError<ProviderMcpSignInError>()(
  "ProviderMcpSignInError",
  {
    server: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export class ProviderUploadFeedbackError extends Schema.TaggedError<ProviderUploadFeedbackError>()(
  "ProviderUploadFeedbackError",
  {
    threadId: ThreadId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to upload feedback for thread ${this.threadId}.`;
  }
}
