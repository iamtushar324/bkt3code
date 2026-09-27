import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ComposerQueuedMessages, formatQueuedMessagesHeading } from "./ComposerQueuedMessages";

const noop = () => undefined;

describe("formatQueuedMessagesHeading", () => {
  it("announces the reconnect wait with a count while disconnected", () => {
    expect(formatQueuedMessagesHeading({ count: 1, environmentConnected: false })).toBe(
      "Reconnecting — 1 queued message will send automatically.",
    );
    expect(formatQueuedMessagesHeading({ count: 3, environmentConnected: false })).toBe(
      "Reconnecting — 3 queued messages will send automatically.",
    );
  });

  it("switches to the draining copy once connected", () => {
    expect(formatQueuedMessagesHeading({ count: 2, environmentConnected: true })).toBe(
      "Sending queued messages...",
    );
  });
});

describe("ComposerQueuedMessages", () => {
  it("renders nothing without queued messages", () => {
    const markup = renderToStaticMarkup(
      <ComposerQueuedMessages messages={[]} environmentConnected={false} onDiscard={noop} />,
    );
    expect(markup).toBe("");
  });

  it("renders each queued message with a discard control, oldest first", () => {
    const markup = renderToStaticMarkup(
      <ComposerQueuedMessages
        messages={[
          { messageId: "m1", text: "first message" },
          { messageId: "m2", text: "second message" },
        ]}
        environmentConnected={false}
        onDiscard={noop}
      />,
    );

    expect(markup).toContain('data-chat-composer-queued-messages="true"');
    expect(markup).toContain("Reconnecting — 2 queued messages will send automatically.");
    expect(markup.indexOf("first message")).toBeLessThan(markup.indexOf("second message"));
    expect(markup.match(/aria-label="Discard queued message"/g)).toHaveLength(2);
  });

  it("labels attachment-only messages", () => {
    const markup = renderToStaticMarkup(
      <ComposerQueuedMessages
        messages={[{ messageId: "m1", text: "" }]}
        environmentConnected={false}
        onDiscard={noop}
      />,
    );
    expect(markup).toContain("(attachments only)");
  });
});
