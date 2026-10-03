// T3-CUSTOM(expbkt3): one durable outbox format across all clients.
import {
  decodeQueuedThreadMessage as decodeSharedQueuedThreadMessage,
  type QueuedThreadMessage as SharedQueuedThreadMessage,
  type QueuedThreadCreation as SharedQueuedThreadCreation,
} from "@t3tools/client-runtime/outbox";
import type { ComposerDispatchMode } from "@t3tools/client-runtime/state/composer-dispatch";
import type { DraftComposerAttachment } from "../lib/composerImages";
export * from "@t3tools/client-runtime/outbox";
export type QueuedThreadCreation = SharedQueuedThreadCreation;
export interface QueuedThreadMessage extends Omit<SharedQueuedThreadMessage, "attachments"> {
  readonly attachments: ReadonlyArray<DraftComposerAttachment>;
  readonly dispatchMode?: ComposerDispatchMode;
}
// T3-CUSTOM(expbkt3): recover native draft metadata from the shared durable schema.
export function decodeQueuedThreadMessage(value: unknown): QueuedThreadMessage {
  const message = decodeSharedQueuedThreadMessage(value);
  return {
    ...message,
    // Legacy drafts used "start" for the native automatic dispatch mode.
    dispatchMode: message.dispatchMode === "start" ? "auto" : message.dispatchMode,
    attachments: message.attachments.map((attachment): DraftComposerAttachment => {
      if (attachment.type === "file") {
        return { ...attachment, type: "file", fileUri: attachment.fileUri ?? "" };
      }
      if (attachment.type !== "image") {
        throw new Error(`Unsupported queued attachment type: ${attachment.type}`);
      }
      return {
        ...attachment,
        type: "image",
        previewUri:
          ("previewUri" in attachment ? attachment.previewUri : undefined) ??
          ("dataUrl" in attachment ? attachment.dataUrl : undefined) ??
          "",
      };
    }),
  };
}
