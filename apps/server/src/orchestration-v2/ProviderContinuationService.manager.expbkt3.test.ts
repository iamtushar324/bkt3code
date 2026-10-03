// T3-CUSTOM(expbkt3): native wakes cannot turn a bounded grant into an ordinary prompt.
import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import {
  MessageId,
  NodeId,
  ProviderTurnId,
  ProviderDriverKind,
  ProviderThreadId,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as IdAllocator from "./IdAllocator.ts";
import * as ProviderContinuationRequests from "./ProviderContinuationRequests.ts";
import * as ProviderContinuationService from "./ProviderContinuationService.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

const cases = [
  ...[true, false].flatMap((background) =>
    [true, false].map((delegated) => ({ background, delegated, laterHuman: "none" as const })),
  ),
  ...(["queued", "preparing", "starting", "completed"] as const).map((laterHuman) => ({
    background: true,
    delegated: false,
    laterHuman,
  })),
];
it.effect.each(
  cases.map(({ background, delegated, laterHuman }) => {
    const suppressed = background && laterHuman !== "completed";
    return {
      background,
      delegated,
      laterHuman,
      suppressed,
      name: `${suppressed ? "suppresses" : "preserves"} ${delegated ? "delegated" : "adapter"} continuation from ${background ? "background" : "interactive"} runs with ${laterHuman} human successor`,
    };
  }),
)("$name", ({ background, delegated, laterHuman, suppressed }) =>
  Effect.gen(function* () {
    const handled = yield* Deferred.make<void>();
    const threadId = ThreadId.make("continuation-thread");
    const providerThreadId = ProviderThreadId.make("continuation-provider-thread");
    const runId = RunId.make("continuation-source-run");
    const messageId = MessageId.make("continuation-source-message");
    const deliveryId = MessageId.make("continuation-delivery");
    const commands: unknown[] = [];
    let clearCount = 0;
    const humanMessageId = MessageId.make("later-human-message");
    const rootNodeId = NodeId.make("original-root");
    const humanRootNodeId = NodeId.make("human-root");
    const now = DateTime.makeUnsafe("2026-10-03T00:00:00Z");
    const messages = [
      { id: messageId, ...(background ? { backgroundGrantHash: "grant" } : {}) },
      { id: humanMessageId },
    ];
    const projection = {
      thread: { archivedAt: null, deletedAt: null },
      runs: [
        {
          id: runId,
          userMessageId: messageId,
          providerThreadId,
          ordinal: 1,
          rootNodeId,
          status: "completed",
          startedAt: now,
          delegatedCompletion: {
            disposition: "open",
            nextGeneration: 2,
            delivery: { generation: 1, messageId: deliveryId, taskIds: ["task"] },
          },
        },
        ...(laterHuman === "none"
          ? []
          : [
              {
                id: RunId.make("later-human-run"),
                userMessageId: humanMessageId,
                providerThreadId,
                ordinal: 2,
                rootNodeId: humanRootNodeId,
                status: laterHuman,
                queueHeld: laterHuman === "queued",
                startedAt: laterHuman === "completed" ? now : null,
              },
            ]),
      ],
      messages,
      providerTurns: [
        {
          id: ProviderTurnId.make("original-native-turn"),
          nodeId: rootNodeId,
          providerThreadId,
          ordinal: 1,
          status: "completed",
          startedAt: now,
          nativeTurnRef: {
            driver: ProviderDriverKind.make("codex"),
            nativeId: "original",
            strength: "strong",
          },
        },
        ...(laterHuman === "starting" || laterHuman === "completed"
          ? [
              {
                id: ProviderTurnId.make("human-native-turn"),
                nodeId: humanRootNodeId,
                providerThreadId,
                ordinal: 2,
                status: laterHuman === "completed" ? "completed" : "pending",
                startedAt: laterHuman === "completed" ? now : null,
                nativeTurnRef:
                  laterHuman === "completed"
                    ? {
                        driver: ProviderDriverKind.make("codex"),
                        nativeId: "human",
                        strength: "strong",
                      }
                    : null,
              },
            ]
          : []),
      ],
    } as unknown as OrchestrationV2ThreadProjection;
    const threads = Layer.mock(ThreadManagementService.ThreadManagementService)({
      getThreadRecords: (_thread, _records, options) =>
        Effect.succeed({
          ...projection,
          messages: projection.messages.filter((message) =>
            options?.messageIds?.includes(message.id),
          ),
        }),
      dispatch: (command) =>
        Effect.sync(() => {
          commands.push(command);
        }).pipe(Effect.andThen(Deferred.succeed(handled, undefined)), Effect.as({} as never)),
    });
    const dependencies = Layer.mergeAll(
      IdAllocator.layer,
      ProviderContinuationRequests.layer,
      threads,
    );
    const layer = Layer.merge(
      ProviderContinuationRequests.layer,
      ProviderContinuationService.workerLive.pipe(Layer.provide(dependencies)),
    );
    yield* Effect.gen(function* () {
      const requests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
      yield* requests.offer({
        threadId,
        providerThreadId,
        driver: ProviderDriverKind.make("codex"),
        detail: "Wake",
        ...(delegated
          ? {
              delegatedCompletion: {
                parentRunId: runId,
                generation: 1,
                messageId: deliveryId,
              },
            }
          : {}),
        clearIfCurrent: () =>
          Effect.sync(() => {
            clearCount++;
          }).pipe(Effect.andThen(Deferred.succeed(handled, undefined)), Effect.asVoid),
      });
      yield* Deferred.await(handled);
      expect(commands).toHaveLength(suppressed ? 0 : 1);
      expect(clearCount).toBe(suppressed ? 1 : 0);
    }).pipe(Effect.provide(layer));
  }),
);
