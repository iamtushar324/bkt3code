// T3-CUSTOM(expbkt3): TEC-1818. t3_list_sessions pages with an opaque cursor
// in its newest-change-first order (ties by id), resumes strictly after the
// last session it returned, and drops each session's linearLinks list to a
// count unless detail is "full".
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId, UserId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { OrchestrationAccessControl } from "../../../orchestration-v2/Services/AccessControl.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration-v2/Services/ProjectionSnapshotQuery.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { T3ControlToolError } from "./tools.ts";
import { __testing } from "./handlers.ts";

const actorUserId = UserId.make("user-pager");
const projectId = ProjectId.make("project-pages");

const invocation: McpInvocationContext.McpInvocationScope = {
  principal: "provider-session",
  actorUserId,
  environmentId: EnvironmentId.make("environment-pages"),
  requestNamespace: "provider-session-pages",
  thread: {
    threadId: ThreadId.make("thread-caller"),
    providerSessionId: "provider-session-pages",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["t3.read"]),
  issuedAt: 1,
};

const accessControl = OrchestrationAccessControl.of({
  actorFor: () => Option.some(actorUserId),
  canAccessThread: () => Effect.succeed(true),
  canAccessProject: () => Effect.succeed(true),
  canTransferThreadOwnership: () => Effect.succeed(false),
  canTransferProjectOwnership: () => Effect.succeed(false),
});

const ISSUE = "https://linear.app/beknown/issue/TEC-1818/compact";

function makeThread(index: number | string, updatedSecond: number) {
  return {
    id: ThreadId.make(`thread-${index}`),
    projectId,
    title: `Session ${index}`,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-sol" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    sourceControlProfileId: null,
    latestTurn: null,
    ownerUserId: actorUserId,
    memberUserIds: [],
    createdAt: "2026-10-28T00:00:00.000Z",
    updatedAt: `2026-10-28T00:00:${String(updatedSecond).padStart(2, "0")}.000Z`,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    titleRegeneration: null,
    priority: null,
    customGroup: null,
    linearIssueUrl: ISSUE,
    linearLinks: [{ url: ISSUE, kind: "issue" }],
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  };
}

let threads = [1, 2, 3, 4, 5].map((index) => makeThread(index, index));

const query = {
  getSnapshot: () => Effect.die("full projection snapshot materialized"),
  getShellSnapshot: () =>
    Effect.sync(() => ({
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
          createdAt: "2026-10-28T00:00:00.000Z",
          updatedAt: "2026-10-28T00:00:00.000Z",
        },
      ],
      threads,
      updatedAt: "2026-10-28T00:00:09.000Z",
    })),
  getArchivedShellSnapshot: () => Effect.die("archived shell should not be read"),
} as unknown as ProjectionSnapshotQuery["Service"];

const list = (input: Parameters<typeof __testing.listSessions>[0]) =>
  __testing
    .listSessions(input)
    .pipe(
      Effect.provideService(ProjectionSnapshotQuery, query),
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
      Effect.provideService(OrchestrationAccessControl, accessControl),
    );

const ids = (result: { readonly sessions: ReadonlyArray<{ readonly sessionId: string }> }) =>
  result.sessions.map((session) => session.sessionId);

it.effect("pages through every session once, newest change first", () =>
  Effect.gen(function* () {
    threads = [1, 2, 3, 4, 5].map((index) => makeThread(index, index));
    const first = yield* list({ limit: 2 });
    expect(ids(first)).toEqual(["thread-5", "thread-4"]);
    expect(typeof first.nextCursor).toBe("string");

    const second = yield* list({ limit: 2, cursor: first.nextCursor ?? undefined });
    expect(ids(second)).toEqual(["thread-3", "thread-2"]);

    const third = yield* list({ limit: 2, cursor: second.nextCursor ?? undefined });
    expect(ids(third)).toEqual(["thread-1"]);
    expect(third.nextCursor).toBeNull();
  }),
);

it.effect("returns no cursor when everything fits, as callers that pass nothing expect", () =>
  Effect.gen(function* () {
    threads = [1, 2, 3].map((index) => makeThread(index, index));
    const all = yield* list({});
    expect(ids(all)).toEqual(["thread-3", "thread-2", "thread-1"]);
    expect(all.nextCursor).toBeNull();
  }),
);

it.effect("resumes after the last session shown when a newer one arrives", () =>
  Effect.gen(function* () {
    threads = [1, 2, 3, 4].map((index) => makeThread(index, index));
    const first = yield* list({ limit: 2 });
    expect(ids(first)).toEqual(["thread-4", "thread-3"]);
    threads = [...threads, makeThread(9, 9)];
    const second = yield* list({ limit: 2, cursor: first.nextCursor ?? undefined });
    expect(ids(second)).toEqual(["thread-2", "thread-1"]);
  }),
);

it.effect("skips nothing when the last session shown is deleted", () =>
  Effect.gen(function* () {
    threads = [1, 2, 3, 4, 5].map((index) => makeThread(index, index));
    const first = yield* list({ limit: 2 });
    expect(ids(first)).toEqual(["thread-5", "thread-4"]);
    threads = threads.filter((thread) => thread.id !== "thread-4");
    const second = yield* list({ limit: 2, cursor: first.nextCursor ?? undefined });
    expect(ids(second)).toEqual(["thread-3", "thread-2"]);
  }),
);

it.effect("neither repeats nor skips when the last session shown moves to the front", () =>
  Effect.gen(function* () {
    threads = [1, 2, 3, 4, 5].map((index) => makeThread(index, index));
    const first = yield* list({ limit: 2 });
    expect(ids(first)).toEqual(["thread-5", "thread-4"]);
    threads = threads.map((thread) => (thread.id === "thread-4" ? makeThread(4, 9) : thread));
    const second = yield* list({ limit: 2, cursor: first.nextCursor ?? undefined });
    expect(ids(second)).toEqual(["thread-3", "thread-2"]);
    const third = yield* list({ limit: 2, cursor: second.nextCursor ?? undefined });
    expect(ids(third)).toEqual(["thread-1"]);
    expect(third.nextCursor).toBeNull();
  }),
);

it.effect("pages through equal change times by id", () =>
  Effect.gen(function* () {
    threads = ["c", "a", "e", "b", "d"].map((key) => makeThread(key, 1));
    const seen: Array<string> = [];
    let cursor: string | undefined;
    for (let round = 0; round < 5; round += 1) {
      const page = yield* list({ limit: 2, cursor });
      seen.push(...ids(page));
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
    expect(seen).toEqual(["thread-a", "thread-b", "thread-c", "thread-d", "thread-e"]);
  }),
);

it.effect("refuses a cursor it did not make", () =>
  Effect.gen(function* () {
    const error = yield* list({ cursor: "not-a-cursor" }).pipe(Effect.flip);
    expect(error).toBeInstanceOf(T3ControlToolError);
    expect(error.message).toContain("nextCursor");
    expect(__testing.decodeListSessionsCursor("not-a-cursor")).toBeNull();
  }),
);

it.effect("counts Linear tags by default and lists them at detail full", () =>
  Effect.gen(function* () {
    threads = [makeThread(1, 1)];
    const compact = yield* list({});
    const [session] = compact.sessions;
    expect(session && "linearLinks" in session).toBe(false);
    expect(session && "linearLinkCount" in session && session.linearLinkCount).toBe(1);

    const full = yield* list({ detail: "full" });
    const [detailed] = full.sessions;
    const links = detailed !== undefined && "linearLinks" in detailed ? detailed.linearLinks : null;
    expect(links).toEqual([{ url: ISSUE, kind: "issue" }]);
  }),
);
