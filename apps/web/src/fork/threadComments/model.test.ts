import { describe, expect, it } from "vite-plus/test";
import type { ThreadComment } from "@t3tools/contracts";

import {
  allowsEmptySend,
  buildCommentAnchor,
  commentsForMessage,
  composerStripText,
  countComments,
  deriveCommentDisplayState,
  filterComments,
  formatCommentsHeader,
  groupCommentsByMessage,
  highlightNameForComment,
  quotePreview,
  THREAD_COMMENT_ACTIVE_HIGHLIGHT,
  THREAD_COMMENT_HIGHLIGHT_NAMES,
} from "./model";

let nextNumber = 1;

function comment(overrides: Partial<ThreadComment> & { messageId?: string } = {}): ThreadComment {
  const number = overrides.number ?? nextNumber++;
  const { messageId, ...rest } = overrides;
  return {
    commentId: `c${number}` as ThreadComment["commentId"],
    threadId: "thread-1" as ThreadComment["threadId"],
    number,
    kind: "comment",
    anchor: {
      messageId: (messageId ?? "m1") as ThreadComment["anchor"]["messageId"],
      text: "quoted text",
      start: 0,
      end: 11,
      prefix: "",
      suffix: "",
    },
    body: "change this",
    status: "open",
    authorUserId: null,
    authorLabel: null,
    replies: [],
    createdAt: "2026-09-29T10:00:00.000Z",
    updatedAt: "2026-09-29T10:00:00.000Z",
    resolvedAt: null,
    ...rest,
  };
}

const reply = (author: "user" | "agent") => ({
  replyId: `r-${author}-${Math.random()}`,
  author,
  authorUserId: null,
  authorLabel: null,
  body: "reply",
  createdAt: "2026-09-29T10:01:00.000Z",
});

describe("deriveCommentDisplayState", () => {
  it("is open until someone replies or the agent addresses it", () => {
    expect(deriveCommentDisplayState(comment())).toBe("open");
    expect(deriveCommentDisplayState(comment({ replies: [reply("user")] }))).toBe("open");
  });

  it("reads 'agent replied' only when the agent spoke last", () => {
    expect(deriveCommentDisplayState(comment({ replies: [reply("agent")] }))).toBe("agent-replied");
    expect(deriveCommentDisplayState(comment({ replies: [reply("agent"), reply("user")] }))).toBe(
      "open",
    );
  });

  it("puts addressed and resolved ahead of the reply heuristic", () => {
    expect(deriveCommentDisplayState(comment({ status: "addressed" }))).toBe("addressed");
    expect(
      deriveCommentDisplayState(comment({ status: "resolved", replies: [reply("agent")] })),
    ).toBe("resolved");
  });
});

describe("counts, filter and header", () => {
  const comments = [
    comment({ status: "open" }),
    comment({ status: "addressed" }),
    comment({ status: "resolved" }),
    comment({ status: "open" }),
  ];

  it("counts open, addressed and resolved separately; only open are delivered", () => {
    expect(countComments(comments)).toEqual({
      open: 2,
      addressed: 1,
      resolved: 1,
      deliverable: 2,
    });
  });

  it("'open' keeps addressed comments visible because the user still owes a resolve", () => {
    expect(filterComments(comments, "open").map((entry) => entry.status)).toEqual([
      "open",
      "addressed",
      "open",
    ]);
    expect(filterComments(comments, "resolved")).toHaveLength(1);
    expect(filterComments(comments, "all")).toHaveLength(4);
  });

  it("formats the header and hides the addressed count when it is zero", () => {
    expect(formatCommentsHeader(countComments(comments))).toBe("2 open · 1 addressed · 1 resolved");
    expect(formatCommentsHeader(countComments([comment(), comment({ status: "resolved" })]))).toBe(
      "1 open · 1 resolved",
    );
  });
});

describe("groupCommentsByMessage", () => {
  const messages = [
    { id: "u1", role: "user" },
    { id: "a1", role: "assistant" },
    { id: "u2", role: "user" },
    { id: "a2", role: "assistant" },
  ];

  it("groups under the quoted message, in thread order, labelled by turn", () => {
    const groups = groupCommentsByMessage(
      [
        comment({ number: 1, messageId: "a2" }),
        comment({ number: 2, messageId: "a1" }),
        comment({ number: 3, messageId: "a2" }),
      ],
      messages,
    );
    expect(groups.map((group) => [group.messageId, group.label])).toEqual([
      ["a1", "Turn 1"],
      ["a2", "Turn 2"],
    ]);
    expect(groups[1]!.comments.map((entry) => entry.number)).toEqual([1, 3]);
  });

  it("appends the provider to the label when known", () => {
    const [group] = groupCommentsByMessage([comment({ messageId: "a1" })], messages, "Claude");
    expect(group!.label).toBe("Turn 1 · Claude");
  });

  it("sorts comments on unloaded messages last with an id label", () => {
    const groups = groupCommentsByMessage(
      [
        comment({ number: 1, messageId: "missing-message" }),
        comment({ number: 2, messageId: "a1" }),
      ],
      messages,
    );
    expect(groups.map((group) => group.messageId)).toEqual(["a1", "missing-message"]);
    expect(groups[1]!.label).toBe("Message missing-");
  });
});

describe("composer strip and empty send", () => {
  it("hides the strip without open comments and pluralises", () => {
    expect(composerStripText({ openCount: 0, deliveryPaused: false })).toBeNull();
    expect(composerStripText({ openCount: 1, deliveryPaused: false })).toBe(
      "1 open comment will be sent with your next message",
    );
    expect(composerStripText({ openCount: 3, deliveryPaused: false })).toBe(
      "3 open comments will be sent with your next message",
    );
  });

  it("says so when delivery is paused", () => {
    expect(composerStripText({ openCount: 2, deliveryPaused: true })).toBe(
      "2 open comments paused — not sent",
    );
  });

  it("allows an empty send only when open comments will actually travel on an idle thread", () => {
    const idle = { enabled: true, openCount: 1, deliveryPaused: false, running: false };
    expect(allowsEmptySend(idle)).toBe(true);
    expect(allowsEmptySend({ ...idle, openCount: 0 })).toBe(false);
    expect(allowsEmptySend({ ...idle, deliveryPaused: true })).toBe(false);
    expect(allowsEmptySend({ ...idle, enabled: false })).toBe(false);
    // While a turn runs an empty Enter keeps upstream's meaning: nothing is queued.
    expect(allowsEmptySend({ ...idle, running: true })).toBe(false);
  });
});

describe("highlights and anchors", () => {
  it("maps each kind to its own highlight and resolved comments to the faint one", () => {
    expect(highlightNameForComment({ kind: "comment", status: "open" })).toBe(
      "t3-thread-comment-comment",
    );
    expect(highlightNameForComment({ kind: "remove", status: "addressed" })).toBe(
      "t3-thread-comment-remove",
    );
    expect(highlightNameForComment({ kind: "good", status: "resolved" })).toBe(
      "t3-thread-comment-resolved",
    );
    for (const name of ["comment", "good", "okay", "remove"]) {
      expect(THREAD_COMMENT_HIGHLIGHT_NAMES).toContain(`t3-thread-comment-${name}`);
    }
    expect(THREAD_COMMENT_HIGHLIGHT_NAMES).toContain(THREAD_COMMENT_ACTIVE_HIGHLIGHT);
  });

  it("selects the comments of one message, oldest first", () => {
    const snapshot = {
      comments: [
        comment({ number: 1, messageId: "a1" }),
        comment({ number: 2, messageId: "a2" }),
        comment({ number: 3, messageId: "a1" }),
      ],
    };
    expect(commentsForMessage(snapshot, "a1").map((entry) => entry.number)).toEqual([1, 3]);
    expect(commentsForMessage(null, "a1")).toEqual([]);
  });

  it("copies only the selector fields into the anchor", () => {
    const anchor = buildCommentAnchor("m9" as ThreadComment["anchor"]["messageId"], {
      text: "quote",
      start: 4,
      end: 9,
      prefix: "pre",
      suffix: "suf",
      // A citation carries more than the anchor stores.
      ...({ comment: "note", version: 1 } as object),
    });
    expect(anchor).toEqual({
      messageId: "m9",
      text: "quote",
      start: 4,
      end: 9,
      prefix: "pre",
      suffix: "suf",
    });
  });

  it("collapses whitespace and clips a quote preview", () => {
    expect(quotePreview("  a\n  b   c ")).toBe("a b c");
    expect(quotePreview("x".repeat(200), 10)).toBe(`${"x".repeat(9)}…`);
  });
});
