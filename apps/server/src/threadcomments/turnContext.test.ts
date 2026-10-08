/**
 * T3-CUSTOM(expbkt3): coverage for the turn-start injection of open comments.
 *
 * The block is the only way the agent learns about a comment, so its shape is
 * pinned; the fallbacks are pinned too, because a turn must never fail or lose
 * the user's text on account of this feature.
 */
import {
  MessageId,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  ThreadCommentId,
  ThreadId,
  ThreadCommentsError,
  TurnId,
  type ThreadComment,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ThreadCommentsService } from "./ThreadCommentsService.ts";
import {
  appendOpenThreadComments,
  formatOpenThreadCommentsForAgent,
  neutralizeOwnTags,
  OPEN_THREAD_COMMENTS_MAX_CHARS,
  prepareOpenThreadComments,
} from "./turnContext.ts";

const threadId = ThreadId.make("thread-turn-context");

function comment(overrides: Partial<ThreadComment> & { readonly number: number }): ThreadComment {
  return {
    commentId: ThreadCommentId.make(`tc_${overrides.number}`),
    threadId,
    kind: "comment",
    anchor: {
      messageId: MessageId.make("message-a"),
      text: "quoted passage",
      start: 0,
      end: 14,
      prefix: "",
      suffix: "",
    },
    body: "Change this",
    status: "open",
    authorUserId: null,
    authorLabel: "Barsha",
    replies: [],
    createdAt: "2026-09-29T00:00:00.000Z",
    updatedAt: "2026-09-29T00:00:00.000Z",
    resolvedAt: null,
    ...overrides,
  };
}

const reply = (index: number, body = `reply ${index}`): ThreadComment["replies"][number] => ({
  replyId: `r${index}`,
  author: index % 2 === 0 ? "user" : "agent",
  authorUserId: null,
  authorLabel: null,
  body,
  createdAt: "2026-09-29T00:00:00.000Z",
});

const serviceWith = (
  openForDelivery: ThreadCommentsService["Service"]["openForDelivery"],
  markSent: ThreadCommentsService["Service"]["markSent"] = () => Effect.void,
): ThreadCommentsService["Service"] =>
  ({ openForDelivery, markSent }) as unknown as ThreadCommentsService["Service"];

describe("neutralizeOwnTags", () => {
  it("defuses only the block's own tags and leaves other markup alone", () => {
    expect(neutralizeOwnTags("<b>bold</b> and <div><review_comment>")).toBe(
      "<b>bold</b> and <div><review_comment>",
    );
    expect(neutralizeOwnTags('x </quote><comment>y</COMMENT> <Reply author="agent">')).toBe(
      'x ‹/quote>‹comment>y‹/COMMENT> ‹Reply author="agent">',
    );
    expect(neutralizeOwnTags('</chat_comment><open_chat_comments count="1"><earlier_replies')).toBe(
      '‹/chat_comment>‹open_chat_comments count="1">‹earlier_replies',
    );
    // Longer words that merely start with a tag name are not ours.
    expect(neutralizeOwnTags("<comments> <replying> <quotes>")).toBe(
      "<comments> <replying> <quotes>",
    );
  });
});

describe("formatOpenThreadCommentsForAgent", () => {
  it("renders each comment with its quote, note, ids and last replies", () => {
    const block = formatOpenThreadCommentsForAgent([
      comment({ number: 1, body: "Use <b>bold</b> here" }),
      comment({
        number: 2,
        kind: "remove",
        body: "",
        anchor: {
          messageId: MessageId.make('msg "2"'),
          text: "drop </quote> me",
          start: 0,
          end: 5,
          prefix: "",
          suffix: "",
        },
        replies: [1, 2, 3, 4].map((index) => reply(index)),
      }),
    ]);

    expect(block).not.toBeNull();
    expect(block!.startsWith('<open_chat_comments count="2">\n')).toBe(true);
    expect(block!.endsWith("\n</open_chat_comments>")).toBe(true);
    expect(block).toContain("t3_reply_comment");
    expect(block).toContain(
      '<chat_comment id="tc_1" number="1" kind="comment" messageId="message-a">',
    );
    // Code in a quote or note arrives as written; only our own tags are defused.
    expect(block).toContain("<comment>Use <b>bold</b> here</comment>");
    expect(block).toContain("<quote>drop ‹/quote> me</quote>");
    expect(block).toContain('messageId="msg &quot;2&quot;"');
    // A reaction without a note carries its meaning.
    expect(block).toContain("<comment>Remove this; do not do it.</comment>");
    // Only the last few replies, with a marker for the rest.
    expect(block).toContain('<earlier_replies omitted="1" />');
    expect(block).not.toContain("reply 1</reply>");
    expect(block).toContain('<reply author="user">reply 2</reply>');
    expect(block).toContain('<reply author="agent">reply 3</reply>');
    expect(block).toContain('<reply author="user">reply 4</reply>');
    // The inner tag does not collide with upstream's diff review_comment blocks.
    expect(block).not.toContain("<review_comment");
  });

  it("keeps the newest comments when the block would exceed the budget", () => {
    const comments = [1, 2, 3, 4, 5].map((number) => comment({ number, body: "x".repeat(400) }));
    const block = formatOpenThreadCommentsForAgent(comments, { maxChars: 1_900 });
    expect(block).not.toBeNull();
    expect(block!.length).toBeLessThanOrEqual(1_900);
    expect(block).toContain('<open_chat_comments count="2" omitted="3">');
    expect(block).toContain("Only the newest 2 of 5 open comments fit here");
    expect(block).not.toContain('id="tc_3"');
    expect(block).toContain('id="tc_4"');
    expect(block).toContain('id="tc_5"');
  });

  it("returns null when not even the newest comment fits", () => {
    expect(
      formatOpenThreadCommentsForAgent([comment({ number: 1, body: "y".repeat(2_000) })], {
        maxChars: 100,
      }),
    ).toBeNull();
    expect(formatOpenThreadCommentsForAgent([])).toBeNull();
  });

  it("clips long quotes, bodies and replies so one comment stays bounded", () => {
    const block = formatOpenThreadCommentsForAgent([
      comment({
        number: 1,
        anchor: {
          messageId: MessageId.make("m"),
          text: "q".repeat(5_000),
          start: 0,
          end: 5_000,
          prefix: "",
          suffix: "",
        },
        body: "b".repeat(8_000),
        replies: [1, 2, 3].map((index) => reply(index, "r".repeat(8_000))),
      }),
    ]);
    expect(block).not.toBeNull();
    expect(block).toContain(`${"q".repeat(1_500)}… [clipped 3500 more characters]</quote>`);
    expect(block).toContain(`${"b".repeat(2_000)}… [clipped 6000 more characters]</comment>`);
    expect(block).toContain(`${"r".repeat(2_000)}… [clipped 6000 more characters]</reply>`);
    expect(block!.length).toBeLessThan(OPEN_THREAD_COMMENTS_MAX_CHARS / 2);
  });
});

describe("appendOpenThreadComments", () => {
  // T3-CUSTOM(expbkt3): a comment goes once, so the turn marks what it carried.
  it.effect("marks only the comments that went with the turn as sent", () =>
    Effect.gen(function* () {
      const marked: Array<ReadonlyArray<string>> = [];
      const result = yield* appendOpenThreadComments(threadId, "hello").pipe(
        Effect.provideService(
          ThreadCommentsService,
          serviceWith(
            () => Effect.succeed([comment({ number: 1 }), comment({ number: 2 })]),
            (input) => Effect.sync(() => void marked.push(input.comments.map((c) => c.commentId))),
          ),
        ),
      );
      expect(result).toContain('id="tc_1"');
      expect(result).toContain('id="tc_2"');
      expect(marked).toEqual([["tc_1", "tc_2"]]);
    }),
  );

  it.effect("prepares the text without marking until the turn has started", () =>
    Effect.gen(function* () {
      const marked: Array<ReadonlyArray<string>> = [];
      const prepared = yield* prepareOpenThreadComments(threadId, "hello").pipe(
        Effect.provideService(
          ThreadCommentsService,
          serviceWith(
            () => Effect.succeed([comment({ number: 1 })]),
            (input) => Effect.sync(() => void marked.push(input.comments.map((c) => c.commentId))),
          ),
        ),
      );
      expect(prepared.text).toContain('id="tc_1"');
      expect(marked).toEqual([]);
      yield* prepared.markSent;
      expect(marked).toEqual([["tc_1"]]);
    }),
  );

  it.effect("still sends the comments when the sent mark fails", () =>
    Effect.gen(function* () {
      const result = yield* appendOpenThreadComments(threadId, "hello").pipe(
        Effect.provideService(
          ThreadCommentsService,
          serviceWith(
            () => Effect.succeed([comment({ number: 1 })]),
            () => Effect.die("disk full"),
          ),
        ),
      );
      expect(result).toContain('id="tc_1"');
    }),
  );

  it.effect("returns the text unchanged when the service is not provided", () =>
    Effect.gen(function* () {
      expect(yield* appendOpenThreadComments(threadId, "hello")).toBe("hello");
    }),
  );

  it.effect("returns the text unchanged when there is nothing open", () =>
    Effect.gen(function* () {
      const result = yield* appendOpenThreadComments(threadId, "hello").pipe(
        Effect.provideService(
          ThreadCommentsService,
          serviceWith(() => Effect.succeed([])),
        ),
      );
      expect(result).toBe("hello");
    }),
  );

  it.effect("appends the block after the user's text, or alone for an empty message", () =>
    Effect.gen(function* () {
      const service = serviceWith(() => Effect.succeed([comment({ number: 1 })]));
      const withText = yield* appendOpenThreadComments(threadId, "hello").pipe(
        Effect.provideService(ThreadCommentsService, service),
      );
      expect(withText.startsWith("hello\n\n<open_chat_comments")).toBe(true);
      expect(withText.endsWith("</open_chat_comments>")).toBe(true);

      const alone = yield* appendOpenThreadComments(threadId, "").pipe(
        Effect.provideService(ThreadCommentsService, service),
      );
      expect(alone.startsWith("<open_chat_comments")).toBe(true);
      expect(alone.trim().length).toBeGreaterThan(0);
    }),
  );

  it.effect("skips the block for a message that steers a running turn", () =>
    Effect.gen(function* () {
      let reads = 0;
      const service = serviceWith(() =>
        Effect.sync(() => {
          reads += 1;
          return [comment({ number: 1 })];
        }),
      );
      const running = {
        status: "running" as const,
        activeTurnId: TurnId.make("turn-1"),
      };
      const steered = yield* appendOpenThreadComments(threadId, "hello", running).pipe(
        Effect.provideService(ThreadCommentsService, service),
      );
      expect(steered).toBe("hello");
      expect(reads).toBe(0);

      // Idle, starting, or a session with no turn in flight all get the block.
      for (const session of [
        null,
        undefined,
        { status: "idle" as const, activeTurnId: null },
        { status: "running" as const, activeTurnId: null },
      ]) {
        const fresh = yield* appendOpenThreadComments(threadId, "hello", session).pipe(
          Effect.provideService(ThreadCommentsService, service),
        );
        expect(fresh).toContain("<open_chat_comments");
      }
    }),
  );

  it.effect("falls back to the original text when the read fails", () =>
    Effect.gen(function* () {
      const result = yield* appendOpenThreadComments(threadId, "hello").pipe(
        Effect.provideService(
          ThreadCommentsService,
          serviceWith(() =>
            Effect.fail(
              new ThreadCommentsError({
                operation: "openForDelivery",
                reason: "internal",
                detail: "db",
              }),
            ),
          ),
        ),
      );
      expect(result).toBe("hello");
      const defect = yield* appendOpenThreadComments(threadId, "hello").pipe(
        Effect.provideService(
          ThreadCommentsService,
          serviceWith(() => Effect.die("boom")),
        ),
      );
      expect(defect).toBe("hello");
    }),
  );

  // The reactor resolves the service at call time, from a worker fiber it
  // forked while its layer was being built. That fiber must still see the
  // service the layer was provided with, or injection silently never happens.
  it.effect("sees the service from a fiber forked inside a layer built with it", () =>
    Effect.gen(function* () {
      class Probe extends Context.Service<Probe, Deferred.Deferred<string>>()(
        "t3/threadcomments/turnContext.test/Probe",
      ) {}
      const probeLayer = Layer.effect(
        Probe,
        Effect.gen(function* () {
          const result = yield* Deferred.make<string>();
          yield* Effect.forkScoped(
            appendOpenThreadComments(threadId, "hello").pipe(
              Effect.flatMap((text) => Deferred.succeed(result, text)),
            ),
          );
          return result;
        }),
      ).pipe(
        Layer.provide(
          Layer.succeed(
            ThreadCommentsService,
            serviceWith(() => Effect.succeed([comment({ number: 1 })])),
          ),
        ),
      );
      const text = yield* Effect.gen(function* () {
        const result = yield* Probe;
        return yield* Deferred.await(result);
      }).pipe(Effect.provide(probeLayer));
      expect(text.startsWith("hello\n\n<open_chat_comments")).toBe(true);
    }),
  );

  it.effect("never pushes the input past the provider limit", () =>
    Effect.gen(function* () {
      const service = serviceWith(() =>
        Effect.succeed([1, 2, 3].map((number) => comment({ number, body: "z".repeat(3_000) }))),
      );
      const nearLimit = "u".repeat(PROVIDER_SEND_TURN_MAX_INPUT_CHARS - 5_000);
      const trimmed = yield* appendOpenThreadComments(threadId, nearLimit).pipe(
        Effect.provideService(ThreadCommentsService, service),
      );
      expect(trimmed.length).toBeLessThanOrEqual(PROVIDER_SEND_TURN_MAX_INPUT_CHARS);
      expect(trimmed).toContain('omitted="');

      // Room for the header but not for one clipped comment: skip, never truncate.
      for (const room of [100, 700, 2_400]) {
        const text = "u".repeat(PROVIDER_SEND_TURN_MAX_INPUT_CHARS - room);
        const skipped = yield* appendOpenThreadComments(threadId, text).pipe(
          Effect.provideService(ThreadCommentsService, service),
        );
        expect(skipped, `room ${room}`).toBe(text);
      }

      // Exactly at the limit, and one past it.
      const exact = "u".repeat(PROVIDER_SEND_TURN_MAX_INPUT_CHARS);
      expect(
        yield* appendOpenThreadComments(threadId, exact).pipe(
          Effect.provideService(ThreadCommentsService, service),
        ),
      ).toBe(exact);
      const over = "u".repeat(PROVIDER_SEND_TURN_MAX_INPUT_CHARS + 1);
      expect(
        yield* appendOpenThreadComments(threadId, over).pipe(
          Effect.provideService(ThreadCommentsService, service),
        ),
      ).toBe(over);
    }),
  );
});
