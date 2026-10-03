// T3-CUSTOM(expbkt3): team sender attribution must survive native feed projection.
import {
  MessageId,
  ThreadId,
  TurnItemId,
  UserId,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { expect, it } from "vite-plus/test";
import { buildThreadFeed } from "./threadActivity";

const sentByUserId = UserId.make("sender");
const threadId = ThreadId.make("thread");
const timestamp = "2026-10-03T00:00:00.000Z";

it("keeps the sender of a persisted native user message", () => {
  const at = DateTime.makeUnsafe(timestamp);
  const item: OrchestrationV2TurnItem = {
    id: TurnItemId.make("item"),
    threadId,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 0,
    status: "completed",
    title: null,
    startedAt: at,
    completedAt: at,
    updatedAt: at,
    type: "user_message",
    messageId: MessageId.make("message"),
    createdBy: "user",
    creationSource: "mobile",
    inputIntent: "turn_start",
    text: "Run checks",
    attachments: [],
    sentByUserId,
  };
  const entry = buildThreadFeed([
    { position: 0, visibility: "local", sourceThreadId: threadId, sourceItemId: item.id, item },
  ])[0];
  expect(entry).toMatchObject({ type: "message", message: { sentByUserId } });
});

it("keeps the sender before the server acknowledges a local message", () => {
  const entry = buildThreadFeed([], {
    anchoredMessages: [
      {
        id: MessageId.make("local-message"),
        role: "user",
        text: "Run checks",
        streaming: false,
        createdAt: timestamp,
        updatedAt: timestamp,
        sentByUserId,
      },
    ],
  })[0];
  expect(entry).toMatchObject({ type: "message", message: { sentByUserId } });
});
