/**
 * T3-CUSTOM(expbkt3): the agent's side of review comments through MCP.
 *
 * Both tools act on the caller's own session only, so the tests pin that the
 * scope's thread is the one read and written, and that the agent-facing shape
 * carries what the agent needs to act (quote, note, status, replies) and
 * nothing it should not see (anchor offsets, author ids).
 */
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  MessageId,
  ProviderInstanceId,
  ThreadCommentId,
  ThreadCommentsError,
  ThreadId,
  UserId,
  type ThreadComment,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { ThreadCommentsService } from "../../../threadcomments/ThreadCommentsService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { T3ControlToolError } from "./tools.ts";
import { __testing } from "./handlers.ts";

const ownThreadId = ThreadId.make("thread-own");
const invocation: McpInvocationContext.McpInvocationScope = {
  principal: "provider-session",
  actorUserId: UserId.make("user-agent-owner"),
  environmentId: EnvironmentId.make("environment-comments-test"),
  requestNamespace: "provider-session-comments-test",
  thread: {
    threadId: ownThreadId,
    providerSessionId: "provider-session-comments-test",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["t3.read"]),
  issuedAt: 1,
};

function comment(overrides: Partial<ThreadComment> & { readonly number: number }): ThreadComment {
  return {
    commentId: ThreadCommentId.make(`tc_${overrides.number}`),
    threadId: ownThreadId,
    kind: "comment",
    anchor: {
      messageId: MessageId.make("message-a"),
      text: "quoted passage",
      start: 3,
      end: 17,
      prefix: "pre",
      suffix: "post",
    },
    body: "Change this",
    status: "open",
    authorUserId: UserId.make("user-reviewer"),
    authorLabel: "Barsha",
    replies: [],
    createdAt: "2026-09-29T00:00:00.000Z",
    updatedAt: "2026-09-29T00:00:00.000Z",
    resolvedAt: null,
    ...overrides,
  };
}

const comments = [
  comment({ number: 1 }),
  comment({ number: 2, status: "addressed", kind: "good", body: "" }),
  comment({ number: 3, status: "resolved", resolvedAt: "2026-09-29T01:00:00.000Z" }),
];

function makeService() {
  const agentReplies: Array<unknown> = [];
  const snapshots: Array<ThreadId> = [];
  const service = {
    snapshot: (threadId: ThreadId) => {
      snapshots.push(threadId);
      return Effect.succeed({ threadId, comments, deliveryPaused: false });
    },
    agentReply: (input: unknown) => {
      agentReplies.push(input);
      const target = comments.find(
        (candidate) => candidate.commentId === (input as { commentId: string }).commentId,
      );
      return target === undefined
        ? Effect.fail(
            new ThreadCommentsError({
              operation: "agentReply",
              reason: "not-found",
              detail: "missing",
            }),
          )
        : Effect.succeed({
            ...target,
            status: "addressed" as const,
            replies: [
              {
                replyId: "r1",
                author: "agent" as const,
                authorUserId: null,
                authorLabel: null,
                body: "done",
                createdAt: "2026-09-29T02:00:00.000Z",
              },
            ],
          });
    },
  } as unknown as ThreadCommentsService["Service"];
  return { service, agentReplies, snapshots };
}

const provide =
  (service: ThreadCommentsService["Service"]) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
      Effect.provideService(ThreadCommentsService, service),
    );

it.effect("lists open comments of the caller's own session by default", () =>
  Effect.gen(function* () {
    const { service, snapshots } = makeService();
    const result = (yield* provide(service)(__testing.listComments({}))) as {
      status: string;
      count: number;
      comments: ReadonlyArray<Record<string, unknown>>;
    };
    expect(snapshots).toEqual([ownThreadId]);
    expect(result.status).toBe("open");
    expect(result.count).toBe(1);
    expect(result.comments[0]).toEqual({
      id: "tc_1",
      number: 1,
      kind: "comment",
      status: "open",
      messageId: "message-a",
      quote: "quoted passage",
      body: "Change this",
      author: "Barsha",
      createdAt: "2026-09-29T00:00:00.000Z",
      replies: [],
    });
    expect(result.comments[0]).not.toHaveProperty("anchor");
    expect(result.comments[0]).not.toHaveProperty("authorUserId");
  }),
);

it.effect("filters by status, including all", () =>
  Effect.gen(function* () {
    const { service } = makeService();
    const addressed = (yield* provide(service)(
      __testing.listComments({ status: "addressed" }),
    )) as { comments: ReadonlyArray<{ id: string }> };
    expect(addressed.comments.map((entry) => entry.id)).toEqual(["tc_2"]);
    const all = (yield* provide(service)(__testing.listComments({ status: "all" }))) as {
      count: number;
    };
    expect(all.count).toBe(3);
  }),
);

it.effect("replies on the caller's own session and reports the updated comment", () =>
  Effect.gen(function* () {
    const { service, agentReplies } = makeService();
    const result = (yield* provide(service)(
      __testing.replyComment({ commentId: "tc_1", body: "done", addressed: true }),
    )) as { recorded: boolean; comment: { status: string; replies: ReadonlyArray<unknown> } };
    expect(agentReplies).toEqual([
      { threadId: ownThreadId, commentId: "tc_1", body: "done", addressed: true },
    ]);
    expect(result.recorded).toBe(true);
    expect(result.comment.status).toBe("addressed");
    expect(result.comment.replies).toEqual([
      { author: "agent", body: "done", createdAt: "2026-09-29T02:00:00.000Z" },
    ]);
  }),
);

it.effect("surfaces a missing comment as a tool error", () =>
  Effect.gen(function* () {
    const { service } = makeService();
    const error = yield* provide(service)(
      __testing.replyComment({ commentId: "tc_404", body: "x" }),
    ).pipe(Effect.flip);
    expect(error).toBeInstanceOf(T3ControlToolError);
    expect((error as T3ControlToolError).operation).toBe("reply-comment");
  }),
);

it.effect("refuses without the read capability", () =>
  Effect.gen(function* () {
    const { service } = makeService();
    const error = yield* __testing.listComments({}).pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, {
        ...invocation,
        capabilities: new Set<McpInvocationContext.McpCapability>(),
      }),
      Effect.provideService(ThreadCommentsService, service),
      Effect.flip,
    );
    expect(error).toBeInstanceOf(T3ControlToolError);
  }),
);
