import { describe, expect, it } from "vite-plus/test";
import type { ThreadComment } from "@t3tools/contracts";

import {
  allowsEmptySend,
  buildCommentAnchor,
  commentsForMessage,
  composerChipLabel,
  composerChipTone,
  composerStripText,
  countCommentDelivery,
  countComments,
  deriveCommentDisplayState,
  filterComments,
  filterCount,
  formatCommentsHeader,
  groupCommentsByMessage,
  highlightNameForComment,
  matchesCommentsFilter,
  messageMarkerState,
  mostUrgentComment,
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
    expect(filterComments(comments, "unaddressed").map((entry) => entry.status)).toEqual([
      "open",
      "open",
    ]);
    expect(filterComments(comments, "addressed").map((entry) => entry.status)).toEqual([
      "addressed",
    ]);
    expect(filterComments(comments, "resolved")).toHaveLength(1);
    expect(filterComments(comments, "all")).toHaveLength(4);
    expect(matchesCommentsFilter({ status: "addressed" }, "unaddressed")).toBe(false);
  });

  it("badges each filter with the count it would show", () => {
    const counts = countComments(comments);
    expect(filterCount(counts, "open")).toBe(3);
    expect(filterCount(counts, "unaddressed")).toBe(2);
    expect(filterCount(counts, "addressed")).toBe(1);
    expect(filterCount(counts, "resolved")).toBe(1);
    expect(filterCount(counts, "all")).toBe(4);
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
  it("hides the strip without unsent comments and pluralises", () => {
    expect(composerStripText({ unsentCount: 0, deliveryPaused: false })).toBeNull();
    expect(composerStripText({ unsentCount: 1, deliveryPaused: false })).toBe(
      "1 comment not sent yet",
    );
    expect(composerStripText({ unsentCount: 3, deliveryPaused: false })).toBe(
      "3 comments not sent yet",
    );
  });

  it("says so when delivery is paused", () => {
    expect(composerStripText({ unsentCount: 2, deliveryPaused: true })).toBe(
      "2 comments paused — not sent",
    );
  });

  it("allows an empty send only when unsent comments will travel on an idle thread", () => {
    const idle = { enabled: true, unsentCount: 1, deliveryPaused: false, running: false };
    expect(allowsEmptySend(idle)).toBe(true);
    expect(allowsEmptySend({ ...idle, unsentCount: 0 })).toBe(false);
    expect(allowsEmptySend({ ...idle, deliveryPaused: true })).toBe(false);
    expect(allowsEmptySend({ ...idle, enabled: false })).toBe(false);
    // While a turn runs an empty Enter keeps upstream's meaning: nothing is queued.
    expect(allowsEmptySend({ ...idle, running: true })).toBe(false);
  });
});

// T3-CUSTOM(expbkt3): a comment goes once; the chip says where the rest stand.
describe("comment delivery counts and chip", () => {
  const at = "2026-10-08T00:00:00.000Z";

  it("splits unresolved comments into unsent, sent and addressed", () => {
    expect(
      countCommentDelivery([
        { status: "open", lastSentAt: null },
        { status: "open" },
        { status: "open", lastSentAt: at },
        { status: "addressed", lastSentAt: at },
        { status: "resolved", lastSentAt: at },
      ]),
    ).toEqual({ unsent: 2, sent: 1, addressed: 1 });
  });

  it("labels the chip by what the agent has done", () => {
    expect(composerChipLabel({ unsent: 2, sent: 0, addressed: 0 })).toBeNull();
    expect(composerChipLabel({ unsent: 0, sent: 2, addressed: 0 })).toBe("2 sent");
    expect(composerChipLabel({ unsent: 0, sent: 1, addressed: 1 })).toBe("1 addressed · 1 open");
    expect(composerChipLabel({ unsent: 0, sent: 0, addressed: 2 })).toBe("2 addressed");
    expect(composerChipTone({ unsent: 0, sent: 2, addressed: 0 })).toBe("sent");
    expect(composerChipTone({ unsent: 0, sent: 0, addressed: 1 })).toBe("addressed");
  });
});

describe("message marker", () => {
  it("counts unresolved comments and takes the most urgent colour", () => {
    expect(
      messageMarkerState([comment({ status: "addressed" }), comment({ status: "resolved" })]),
    ).toEqual({ urgency: "addressed", count: 1 });
    expect(
      messageMarkerState([
        comment({ status: "addressed" }),
        comment({ status: "open" }),
        comment({ status: "open" }),
      ]),
    ).toEqual({ urgency: "open", count: 3 });
    expect(messageMarkerState([comment({ status: "resolved" })])).toBeNull();
  });

  it("opens the oldest open comment, else the oldest addressed one", () => {
    const addressedOld = comment({ number: 1, status: "addressed" });
    const openNew = comment({ number: 3, status: "open" });
    const openNewer = comment({ number: 4, status: "open" });
    expect(mostUrgentComment([openNewer, addressedOld, openNew])).toBe(openNew);
    expect(mostUrgentComment([comment({ number: 9, status: "resolved" }), addressedOld])).toBe(
      addressedOld,
    );
    expect(mostUrgentComment([comment({ status: "resolved" })])).toBeNull();
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
