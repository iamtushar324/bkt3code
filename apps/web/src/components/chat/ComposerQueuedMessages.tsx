import { Loader2, X } from "lucide-react";

import { ContextChip, ContextChipAction, ContextChipLabel } from "../ContextChip";
import { cn } from "~/lib/utils";

export interface ComposerQueuedMessage {
  readonly messageId: string;
  readonly text: string;
}

export function formatQueuedMessagesHeading(options: {
  count: number;
  environmentConnected: boolean;
}): string {
  if (options.environmentConnected) return "Sending queued messages...";
  return `Reconnecting — ${options.count} queued message${
    options.count === 1 ? "" : "s"
  } will send automatically.`;
}

interface ComposerQueuedMessagesProps {
  messages: ReadonlyArray<ComposerQueuedMessage>;
  environmentConnected: boolean;
  onDiscard: (messageId: string) => void;
  className?: string;
}

export function ComposerQueuedMessages({
  messages,
  environmentConnected,
  onDiscard,
  className,
}: ComposerQueuedMessagesProps) {
  if (messages.length === 0) return null;

  return (
    <div
      data-chat-composer-queued-messages="true"
      className={cn("flex flex-col gap-1.5 px-3 py-2", className)}
    >
      <div className="text-muted-foreground flex items-center gap-2 text-xs">
        <Loader2 className="size-3.5 animate-spin" aria-hidden />
        <span>{formatQueuedMessagesHeading({ count: messages.length, environmentConnected })}</span>
      </div>
      <div className="flex flex-col items-start gap-1">
        {messages.map((message) => (
          <ContextChip key={message.messageId} className="select-none pr-1">
            <ContextChipLabel className="select-none">
              {message.text.length > 0 ? message.text : "(attachments only)"}
            </ContextChipLabel>
            <ContextChipAction
              aria-label="Discard queued message"
              className="text-muted-foreground/72 hover:text-foreground"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onDiscard(message.messageId);
              }}
            >
              <X className="size-3" aria-hidden />
            </ContextChipAction>
          </ContextChip>
        ))}
      </div>
    </div>
  );
}
