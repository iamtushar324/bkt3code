// T3-CUSTOM(expbkt3): composer display of persisted turns; the root coordinator owns delivery.
import { useAtomValue } from "@effect/atom-react";
import type { ScopedThreadRef, ChatAttachment, UploadChatAttachment } from "@t3tools/contracts";
import type { QueuedThreadMessage } from "@t3tools/client-runtime/outbox";
import { Atom } from "effect/unstable/reactivity";
import { useCallback, useMemo } from "react";
import { durableThreadOutbox, threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { dataUrlToFile } from "../lib/imageCompression";
import {
  awaitAttachmentUploads,
  getUploadedAttachments,
  readAttachmentUpload,
  retryAttachmentUpload,
  startAttachmentUpload,
} from "../lib/attachmentUploadQueue";
import type { ComposerFileAttachment } from "../composerDraftStore";

const emptyItems = Atom.make<ReadonlyArray<QueuedThreadMessage>>([]);
export async function outboxAttachments(
  message: QueuedThreadMessage,
): Promise<ReadonlyArray<(ChatAttachment | UploadChatAttachment) & { readonly id: string }>> {
  return Promise.all(
    message.attachments.map(
      async (
        attachment,
      ): Promise<(ChatAttachment | UploadChatAttachment) & { readonly id: string }> => {
        const id =
          "uploadedAttachmentId" in attachment ? attachment.uploadedAttachmentId : undefined;
        const source = "source" in attachment ? attachment.source : undefined;
        const snapShotSource = source && "kind" in source ? { source } : {};
        const pastedTextSource = source && "_tag" in source ? { source } : {};
        if (id !== undefined) {
          const uploaded = {
            id,
            type: attachment.type,
            name: attachment.name,
            mimeType: attachment.mimeType,
            sizeBytes: attachment.sizeBytes,
          };
          if (attachment.type === "image") return { ...uploaded, type: "image", ...snapShotSource };
          if (attachment.type === "file") return { ...uploaded, type: "file", ...pastedTextSource };
          return uploaded;
        }
        const dataUrl = "dataUrl" in attachment ? attachment.dataUrl : undefined;
        if (attachment.type === "image" && typeof dataUrl === "string")
          return {
            id: attachment.id,
            type: "image",
            name: attachment.name,
            mimeType: attachment.mimeType,
            sizeBytes: attachment.sizeBytes,
            dataUrl,
            ...snapShotSource,
          };
        if (attachment.type === "file" && typeof dataUrl === "string") {
          const file: ComposerFileAttachment = {
            id: `outbox:${message.messageId}:${attachment.id}`,
            type: "file",
            name: attachment.name,
            mimeType: attachment.mimeType,
            sizeBytes: attachment.sizeBytes,
            file: dataUrlToFile(dataUrl, attachment.name, attachment.mimeType),
            ...pastedTextSource,
          };
          const input = { environmentId: message.environmentId, image: file };
          if (readAttachmentUpload(file.id)?.status === "failed") retryAttachmentUpload(input);
          else startAttachmentUpload(input);
          await awaitAttachmentUploads([file.id]);
          const uploaded = getUploadedAttachments({
            environmentId: message.environmentId,
            images: [file],
          });
          if (uploaded?.[0]) return uploaded[0];
          throw new Error(`Could not upload ${attachment.name}. Retry the saved message.`);
        }
        throw new Error(`Reattach ${attachment.name} before sending this saved message.`);
      },
    ),
  );
}
export function useDurableThreadOutbox(ref: ScopedThreadRef | null, identityKey: string) {
  const allItems = useAtomValue(
    ref === null ? emptyItems : durableThreadOutbox.itemsValueAtom(ref.environmentId, identityKey),
  );
  const items = useMemo(
    () => allItems.filter((item) => item.threadId === ref?.threadId),
    [allItems, ref?.threadId],
  );
  const discard = useAtomCommand(threadEnvironment.discardOutbox);
  const queue = useAtomCommand(threadEnvironment.queueOutbox, { reportFailure: false });
  const remove = useCallback(
    (messageId: string) => {
      const message = items.find((item) => item.messageId === messageId);
      if (message) void discard(message);
    },
    [discard, items],
  );
  return { items, remove, queue };
}
