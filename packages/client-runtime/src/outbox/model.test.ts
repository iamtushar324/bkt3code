import { describe, expect, it } from "@effect/vitest";
import { CommandId, EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";

import {
  decodeQueuedThreadMessage,
  encodeQueuedThreadMessage,
  outboxIdentityNamespace,
  resolveThreadOutboxDeliveryAction,
  retryQueuedThreadMessage,
  ThreadOutboxPersistenceError,
  type QueuedThreadMessage,
} from "./model.ts";

const queued = (identityKey: string): QueuedThreadMessage => ({
  environmentId: EnvironmentId.make("environment-1"),
  identityKey,
  threadId: ThreadId.make("thread-1"),
  messageId: MessageId.make("message-1"),
  commandId: "command-1" as never,
  text: "continue",
  attachments: [
    {
      id: "attachment-1",
      previewUri: "data:image/png;base64,AA==",
      type: "image",
      name: "proof.png",
      mimeType: "image/png",
      sizeBytes: 1,
      dataUrl: "data:image/png;base64,AA==",
    },
  ],
  createdAt: "2026-08-03T00:00:00.000Z",
});

describe("shared durable thread outbox", () => {
  it("states clearly that persistence failure prevented network delivery", () => {
    expect(new ThreadOutboxPersistenceError({ operation: "save-before-send" }).message).toBe(
      "Message could not be saved locally, so it was not sent.",
    );
  });

  it("round-trips exact ids, identity, and attachment bytes", () => {
    const message = queued("user_123");
    expect(decodeQueuedThreadMessage(encodeQueuedThreadMessage(message))).toEqual(message);
  });

  it("separates pending work by environment and authenticated identity", () => {
    expect(outboxIdentityNamespace(queued("user_123"))).not.toBe(
      outboxIdentityNamespace(queued("user_456")),
    );
  });

  it("turns an explicitly retried rejection into a fresh command for the same message", () => {
    const failed = {
      ...queued("user_123"),
      deliveryState: "failed",
      failureDetail: "The selected model is no longer available.",
    } satisfies QueuedThreadMessage;

    expect(retryQueuedThreadMessage(failed, CommandId.make("command-2"))).toMatchObject({
      messageId: failed.messageId,
      commandId: "command-2",
      deliveryState: "pending",
    });
    expect("failureDetail" in retryQueuedThreadMessage(failed, CommandId.make("command-2"))).toBe(
      false,
    );
  });

  it("allows a busy thread to send because the durable server queues or steers it", () => {
    expect(
      resolveThreadOutboxDeliveryAction({
        isCreation: false,
        threadExists: true,
        shellStatus: "live",
        environmentConnected: true,
        threadBusy: true,
      }),
    ).toBe("send");
  });

  // T3-CUSTOM(expbkt3): upstream #6543 steers active turns by default, so a busy
  // thread no longer holds a queued send back even without durable recovery. Only
  // a disconnected environment waits.
  it("sends to a busy thread even without durable recovery, and waits only when disconnected", () => {
    expect(
      resolveThreadOutboxDeliveryAction({
        isCreation: false,
        threadExists: true,
        shellStatus: "live",
        environmentConnected: true,
        threadBusy: true,
      }),
    ).toBe("send");
    expect(
      resolveThreadOutboxDeliveryAction({
        isCreation: false,
        threadExists: true,
        shellStatus: "live",
        environmentConnected: false,
        threadBusy: true,
      }),
    ).toBe("wait");
  });
  it("round-trips upstream file-backed uploads alongside fork identity and failure state", () => {
    const message: QueuedThreadMessage = {
      ...queued("user_123"),
      deliveryState: "failed",
      failureDetail: "retry explicitly",
      attachments: [
        {
          id: "file-1",
          type: "file",
          name: "report.pdf",
          mimeType: "application/pdf",
          sizeBytes: 42,
          fileUri: "file:///documents/report.pdf",
          uploadedAttachmentId: "pending-report",
          uploadEnvironmentId: EnvironmentId.make("environment-1"),
        },
      ],
    };
    expect(decodeQueuedThreadMessage(encodeQueuedThreadMessage(message))).toEqual(message);
  });
});
