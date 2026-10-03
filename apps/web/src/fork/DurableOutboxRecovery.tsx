// T3-CUSTOM(expbkt3): failed sends retain their attachments and context during edits.
import { CommandId } from "@t3tools/contracts";
import { retryQueuedThreadMessage, type QueuedThreadMessage } from "@t3tools/client-runtime/outbox";
import { useState } from "react";
import { Alert, AlertDescription } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import { Textarea } from "../components/ui/textarea";
import { randomUUID } from "../lib/utils";

export function DurableOutboxRecovery({
  items,
  queue,
  remove,
}: {
  readonly items: ReadonlyArray<QueuedThreadMessage>;
  readonly queue: (message: QueuedThreadMessage) => Promise<{ readonly _tag: string }>;
  readonly remove: (messageId: string) => void;
}) {
  const [edit, setEdit] = useState<{ messageId: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const retry = async (message: QueuedThreadMessage, text = message.text) => {
    setBusy(true);
    try {
      const result = await queue({
        ...retryQueuedThreadMessage(message, CommandId.make(randomUUID())),
        text,
      });
      if (result._tag === "Success") setEdit(null);
    } finally {
      setBusy(false);
    }
  };
  return items
    .filter((item) => item.deliveryState === "failed")
    .map((message) => (
      <div
        key={message.messageId}
        className="pointer-events-auto mx-auto w-full max-w-[min(48rem,calc(100%-2rem))] pt-3"
      >
        <Alert variant="error" surface="glass">
          <AlertDescription>
            <p>{message.failureDetail ?? "This message could not be sent."}</p>
            {edit?.messageId === message.messageId ? (
              <Textarea
                value={edit.text}
                onChange={(event) => setEdit({ ...edit, text: event.target.value })}
                aria-label="Edit failed message"
              />
            ) : (
              <p className="line-clamp-2">{message.text}</p>
            )}
            <div className="mt-2 flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() =>
                  void retry(
                    message,
                    edit?.messageId === message.messageId ? edit.text : message.text,
                  )
                }
              >
                Retry
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => setEdit({ messageId: message.messageId, text: message.text })}
              >
                Edit
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => remove(message.messageId)}
              >
                Discard
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      </div>
    ));
}
