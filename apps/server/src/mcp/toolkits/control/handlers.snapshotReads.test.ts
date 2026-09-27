import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { __testing } from "./handlers.ts";

it.effect("lists sessions without materializing the full projection snapshot", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread-session-list");
    const projectId = ProjectId.make("project-session-list");
    const query = {
      getSnapshot: () => Effect.die("full projection snapshot materialized"),
      getShellSnapshot: () =>
        Effect.succeed({
          snapshotSequence: 1,
          projects: [
            {
              id: projectId,
              title: "Project",
              workspaceRoot: "/tmp/project",
              repositoryIdentity: null,
              defaultModelSelection: null,
              threadCreationDefaults: { baseRef: null, setupScript: null },
              scripts: [],
              ownerUserId: null,
              memberUserIds: [],
              createdAt: "2026-08-05T00:00:00.000Z",
              updatedAt: "2026-08-05T00:00:00.000Z",
            },
          ],
          threads: [
            {
              id: threadId,
              projectId,
              title: "Session",
              modelSelection: {
                instanceId: ProviderInstanceId.make("codex"),
                model: "gpt-5.6-sol",
              },
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: null,
              sourceControlProfileId: null,
              latestTurn: null,
              ownerUserId: null,
              memberUserIds: [],
              createdAt: "2026-08-05T00:00:00.000Z",
              updatedAt: "2026-08-05T00:00:03.000Z",
              archivedAt: null,
              settledOverride: null,
              settledAt: null,
              snoozedUntil: null,
              snoozedAt: null,
              titleRegeneration: null,
              priority: null,
              linearIssueUrl: null,
              session: null,
              latestUserMessageAt: null,
              hasPendingApprovals: false,
              hasPendingUserInput: false,
              hasActionableProposedPlan: false,
            },
          ],
          updatedAt: "2026-08-05T00:00:03.000Z",
        }),
      getArchivedShellSnapshot: () => Effect.die("archived shell should not be read"),
    } as unknown as ProjectionSnapshotQuery["Service"];
    const invocation: McpInvocationContext.McpInvocationScope = {
      principal: "external-operator",
      actorUserId: null,
      environmentId: EnvironmentId.make("environment-session-list"),
      threadId,
      providerSessionId: "provider-session-list",
      providerInstanceId: ProviderInstanceId.make("codex"),
      capabilities: new Set(["t3.read"]),
      issuedAt: 1,
    };

    const result = yield* __testing
      .listSessions({})
      .pipe(
        Effect.provideService(ProjectionSnapshotQuery, query),
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
      );

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]?.sessionId).toBe(threadId);
  }),
);
