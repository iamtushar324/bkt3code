import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  SourceControlProfileId,
  ThreadId,
  type OrchestrationReadModel,
  type OrchestrationSessionStatus,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-07-31T00:00:00.000Z";
const threadId = ThreadId.make("thread-source-control");

function makeReadModel(sessionStatus?: OrchestrationSessionStatus): OrchestrationReadModel {
  return {
    snapshotSequence: 1,
    projects: [],
    threads: [
      {
        // T3-CUSTOM(expbkt3): upstream's linked pull requests; empty on a fresh fixture.
        pullRequests: [],
        id: threadId,
        projectId: ProjectId.make("project-source-control"),
        title: "Source-control identity",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        sourceControlProfileId: null,
        latestTurn: null,
        ownerUserId: null,
        memberUserIds: [],
        createdAt: NOW,
        updatedAt: NOW,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        deletedAt: null,
        messages: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        session:
          sessionStatus === undefined
            ? null
            : {
                threadId,
                status: sessionStatus,
                providerName: "Codex",
                runtimeMode: "full-access",
                activeTurnId: null,
                lastError: null,
                updatedAt: NOW,
              },
      },
    ],
    updatedAt: NOW,
  };
}

it.layer(NodeServices.layer)("thread source-control owner decider", (it) => {
  it.effect("records the previous and next owner", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "thread.source-control-profile.set",
          commandId: CommandId.make("command-set-owner"),
          threadId,
          sourceControlProfileId: SourceControlProfileId.make("alice"),
          createdAt: NOW,
        },
        readModel: makeReadModel(),
      });

      const events = "type" in event ? [event] : event;
      expect(events).toHaveLength(1);
      const ownerChanged = events[0];
      expect(ownerChanged?.type).toBe("thread.source-control-profile-set");
      if (ownerChanged?.type === "thread.source-control-profile-set") {
        const payload = ownerChanged.payload as {
          readonly previousSourceControlProfileId: SourceControlProfileId | null;
          readonly sourceControlProfileId: SourceControlProfileId;
        };
        expect(payload.previousSourceControlProfileId).toBeNull();
        expect(payload.sourceControlProfileId).toBe("alice");
      }
    }),
  );

  it.effect("rejects ownership changes while the provider session is running", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        decideOrchestrationCommand({
          command: {
            type: "thread.source-control-profile.set",
            commandId: CommandId.make("command-set-owner-busy"),
            threadId,
            sourceControlProfileId: SourceControlProfileId.make("alice"),
            createdAt: NOW,
          },
          readModel: makeReadModel("running"),
        }),
      );

      expect(exit._tag).toBe("Failure");
    }),
  );
});
