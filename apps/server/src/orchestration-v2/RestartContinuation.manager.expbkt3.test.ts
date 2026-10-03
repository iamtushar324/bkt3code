// T3-CUSTOM(expbkt3): a recovered background run must return to its bridge owner.
import { it } from "@effect/vitest";
import { expect, vi } from "vite-plus/test";
import {
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  UserId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ServerSettings from "../serverSettings.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import { continueRestartedRun } from "./RestartContinuation.ts";

it.effect.each([true, false])(
  "preserves restart continuation policy for background=%s",
  (background) =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("restart-managed-thread");
      const runId = RunId.make("restart-managed-run");
      const messageId = MessageId.make("original-message");
      const instanceId = ProviderInstanceId.make("codex");
      const original = {
        id: messageId,
        role: "user",
        sentByUserId: UserId.make("original-actor"),
        ...(background ? { backgroundGrantHash: "original-grant" } : {}),
      };
      const dispatch = vi.fn(() => Effect.succeed({} as never));
      const records = vi.fn((_threadId, fields, filter) =>
        Effect.succeed({
          thread: {
            id: threadId,
            projectId: ProjectId.make("project"),
            providerInstanceId: instanceId,
            archivedAt: null,
            deletedAt: null,
          },
          messages: filter?.messageIds?.includes(messageId) ? [original] : [],
          ...(fields.includes("runs")
            ? {
                runs: [
                  {
                    id: runId,
                    userMessageId: messageId,
                    ordinal: 1,
                    status: "cancelled",
                    providerInstanceId: instanceId,
                    modelSelection: { instanceId, model: "test" },
                  },
                ],
                providerTurns: [],
              }
            : {}),
        } as never),
      );
      yield* continueRestartedRun({ threadId, sourceRunId: runId }).pipe(
        Effect.provide(
          Layer.merge(
            Layer.mock(ThreadManagementService.ThreadManagementService)({
              getThreadRecords: records,
              dispatch,
            }),
            ServerSettings.layerTest({ continueThreadsAfterServerUpdate: true }),
          ),
        ),
      );
      if (background) {
        expect(dispatch).not.toHaveBeenCalled();
      } else {
        expect(dispatch).toHaveBeenCalledOnce();
        expect(dispatch).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "message.dispatch",
            restartContinuationOfRunId: runId,
          }),
        );
      }
    }),
);
