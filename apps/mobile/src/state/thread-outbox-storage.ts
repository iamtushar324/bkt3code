import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { writeFileAtomically } from "../lib/atomic-file";
// T3-CUSTOM(expbkt3): BEGIN — identity-scoped durable outbox files.
import {
  ANONYMOUS_OUTBOX_IDENTITY,
  decodeQueuedThreadMessage,
  encodeQueuedThreadMessage,
  type QueuedThreadMessage,
} from "./thread-outbox-model";
// T3-CUSTOM(expbkt3): END

const THREAD_OUTBOX_DIRECTORY = "thread-outbox";

const inFlightWrites = new Set<Promise<void>>();

function trackInFlightWrite(operation: Promise<void>): Promise<void> {
  inFlightWrites.add(operation);
  void operation.catch(() => undefined).finally(() => inFlightWrites.delete(operation));
  return operation;
}

/**
 * Awaits queued-message writes so an app update restart cannot tear down the
 * runtime while one is mid-file.
 */
export async function flushThreadOutboxWrites(): Promise<void> {
  while (inFlightWrites.size > 0) {
    await Promise.allSettled(inFlightWrites);
  }
}

export class ThreadOutboxStorageError extends Schema.TaggedError<ThreadOutboxStorageError>()(
  "ThreadOutboxStorageError",
  {
    operation: Schema.Literals(["load", "read-message", "write", "remove"]),
    environmentId: Schema.NullOr(EnvironmentId),
    threadId: Schema.NullOr(ThreadId),
    messageId: Schema.NullOr(MessageId),
    fileName: Schema.NullOr(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Thread outbox storage operation ${this.operation} failed for environment ${this.environmentId ?? "unknown"}, thread ${this.threadId ?? "unknown"}, message ${this.messageId ?? "unknown"}, file ${this.fileName ?? "unknown"}.`;
  }
}

export interface ThreadOutboxLoadResult {
  readonly messages: ReadonlyArray<QueuedThreadMessage>;
  readonly errors: ReadonlyArray<ThreadOutboxStorageError>;
}

// T3-CUSTOM(expbkt3): BEGIN — environment/account namespaced storage keys.
export interface ThreadOutboxStorage {
  readonly load: () => Promise<ThreadOutboxLoadResult>;
  readonly write: (message: QueuedThreadMessage) => Promise<void>;
  readonly remove: (
    message: Pick<QueuedThreadMessage, "environmentId" | "identityKey" | "messageId">,
  ) => Promise<void>;
}

function messageFileName(
  message: Pick<QueuedThreadMessage, "environmentId" | "identityKey" | "messageId">,
): string {
  return `${encodeURIComponent(message.environmentId)}--${encodeURIComponent(message.identityKey ?? ANONYMOUS_OUTBOX_IDENTITY)}--${encodeURIComponent(message.messageId)}.json`;
}

async function getOutboxDirectory() {
  const { Directory, Paths } = await import("expo-file-system");
  const directory = new Directory(Paths.document, THREAD_OUTBOX_DIRECTORY);
  directory.create({ idempotent: true, intermediates: true });
  return directory;
}

async function getMessageFile(
  message: Pick<QueuedThreadMessage, "environmentId" | "identityKey" | "messageId">,
) {
  const { File } = await import("expo-file-system");
  return new File(await getOutboxDirectory(), messageFileName(message));
}
// T3-CUSTOM(expbkt3): END

export const expoThreadOutboxStorage: ThreadOutboxStorage = {
  load: async () => {
    const messages: QueuedThreadMessage[] = [];
    const errors: ThreadOutboxStorageError[] = [];
    try {
      const { File } = await import("expo-file-system");
      const directory = await getOutboxDirectory();

      for (const entry of directory.list()) {
        if (!(entry instanceof File) || !entry.name.endsWith(".json")) {
          continue;
        }
        try {
          messages.push(decodeQueuedThreadMessage(JSON.parse(await entry.text()) as unknown));
        } catch (cause) {
          // Recover readable messages without treating their attachment
          // owners as the complete inventory needed for cleanup.
          errors.push(
            new ThreadOutboxStorageError({
              operation: "read-message",
              environmentId: null,
              threadId: null,
              messageId: null,
              fileName: entry.name,
              cause,
            }),
          );
        }
      }
    } catch (cause) {
      throw new ThreadOutboxStorageError({
        operation: "load",
        environmentId: null,
        threadId: null,
        messageId: null,
        fileName: null,
        cause,
      });
    }
    return { messages, errors };
  },
  // T3-CUSTOM(expbkt3): BEGIN — write the namespaced file.
  write: async (message) => {
    const fileName = messageFileName(message);
    try {
      await trackInFlightWrite(
        (async () => {
          // T3-CUSTOM(expbkt3): identity-scoped file name resolves from the whole message.
          const file = await getMessageFile(message);
          await writeFileAtomically(file, JSON.stringify(encodeQueuedThreadMessage(message)));
        })(),
      );
    } catch (cause) {
      throw new ThreadOutboxStorageError({
        operation: "write",
        environmentId: message.environmentId,
        threadId: message.threadId,
        messageId: message.messageId,
        fileName,
        cause,
      });
    }
  },
  // T3-CUSTOM(expbkt3): END
  // T3-CUSTOM(expbkt3): BEGIN — remove current and one-release legacy keys.
  remove: async (message) => {
    const fileName = messageFileName(message);
    try {
      const file = await getMessageFile(message);
      if (file.exists) {
        file.delete();
      }
      // One-release migration cleanup for the previous message-id-only layout.
      const { File } = await import("expo-file-system");
      const legacy = new File(
        await getOutboxDirectory(),
        `${encodeURIComponent(message.messageId)}.json`,
      );
      if (legacy.exists) legacy.delete();
    } catch (cause) {
      throw new ThreadOutboxStorageError({
        operation: "remove",
        environmentId: message.environmentId,
        threadId: null,
        messageId: message.messageId,
        fileName,
        cause,
      });
    }
  },
  // T3-CUSTOM(expbkt3): END
};
