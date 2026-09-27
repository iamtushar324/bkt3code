// T3-CUSTOM(expbkt3): shared durable delivery, with native draft attachment metadata.
import {
  decodeQueuedThreadMessage as decodeSharedQueuedThreadMessage,
  type QueuedThreadMessage as SharedQueuedThreadMessage,
} from "@t3tools/client-runtime/outbox";
import type { DraftComposerAttachment } from "../lib/composerImages";
export * from "@t3tools/client-runtime/outbox";

export interface QueuedThreadMessage extends Omit<SharedQueuedThreadMessage, "attachments"> {
  readonly attachments: ReadonlyArray<DraftComposerAttachment>;
}

// T3-CUSTOM(expbkt3): recover native draft metadata from the shared durable schema.
export function decodeQueuedThreadMessage(value: unknown): QueuedThreadMessage {
  const message = decodeSharedQueuedThreadMessage(value);
  return {
    ...message,
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
