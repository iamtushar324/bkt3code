/**
 * T3-CUSTOM(expbkt3): what every agent tool loads: the caller, the sessions it
 * may see, the projects they belong to, and the one session a reference means.
 *
 * Reads go through the V2 shell, one snapshot per call at most; a reference
 * that is an exact id reads only that session. Visibility is the team rule the
 * thread tools use (`ownsForkThread`): owner or tagged member, everything for
 * an operator or a client with no user.
 */
import {
  type OrchestrationV2ThreadShell,
  type Project as ProjectRecord,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as Project from "../../../project/ProjectService.ts";
import { ownsForkThread } from "../../forkAccess.expbkt3.ts";
import type * as McpInvocationContext from "../../McpInvocationContext.ts";
import { loadCaller, type Caller } from "../../threadAccess.ts";
import { AgentToolError } from "./tools.ts";
import { matchSessionRef, sessionStateOf, shortRef, type SessionShell } from "./view.ts";

export const fail = (code: string, message: string) => new AgentToolError({ code, message });

const unavailable = (what: string) =>
  fail("unavailable", `T3 Code could not read ${what} just now. Try again in a moment.`);

/** The caller, refused when its credential lacks `capability`. */
export const loadAgentCaller = Effect.fn("agentToolkit.loadCaller")(function* (
  capability: McpInvocationContext.McpCapability,
) {
  const caller = yield* loadCaller();
  if (!caller.scope.capabilities.has(capability)) {
    return yield* fail(
      "capability_denied",
      `This MCP credential does not grant ${capability}. Ask the person who approved this client for more access.`,
    );
  }
  return caller;
});

export interface VisibleSessions {
  /** Active sessions the caller may see, newest change first. */
  readonly active: ReadonlyArray<SessionShell>;
  /** Archived ones, loaded only when asked for. */
  readonly archived: ReadonlyArray<SessionShell>;
  /** The newest event the snapshot includes: a `t3_wait` cursor. */
  readonly sequence: number;
}

const byNewest = (left: SessionShell, right: SessionShell) =>
  right.updatedAt.epochMilliseconds - left.updatedAt.epochMilliseconds;

export const visibleTo =
  (scope: McpInvocationContext.McpInvocationScope) => (shell: OrchestrationV2ThreadShell) =>
    shell.deletedAt === null && ownsForkThread(shell, scope);

export const loadVisibleSessions = Effect.fn("agentToolkit.loadVisibleSessions")(function* (
  caller: Caller,
  options: { readonly archived: boolean },
) {
  const visible = visibleTo(caller.scope);
  const active = yield* caller.threads
    .getShellSnapshot()
    .pipe(Effect.mapError(() => unavailable("the session list")));
  const archived = options.archived
    ? yield* caller.threads
        .getShellSnapshot({ location: "archive" })
        .pipe(Effect.mapError(() => unavailable("the archived sessions")))
    : undefined;
  return {
    active: active.threads.filter(visible).toSorted(byNewest),
    archived: [...active.archivedThreads, ...(archived?.archivedThreads ?? [])]
      .filter(visible)
      .toSorted(byNewest),
    sequence: active.snapshotSequence,
  } satisfies VisibleSessions;
});

export type ProjectSummary = Pick<ProjectRecord, "id" | "title" | "workspaceRoot"> &
  Partial<Pick<ProjectRecord, "ownerUserId" | "memberUserIds">>;

export const loadProjects = Effect.fn("agentToolkit.loadProjects")(function* () {
  const projects = yield* Project.ProjectService;
  const snapshot = yield* projects.snapshot.pipe(Effect.mapError(() => unavailable("projects")));
  return new Map<string, ProjectSummary>(
    snapshot.projects
      .filter((project) => project.deletedAt === null)
      .map((project): [string, ProjectSummary] => [project.id, project]),
  );
});

/** The caller's own session, or a refusal that says how to name one. */
const ownSession = Effect.fn("agentToolkit.ownSession")(function* (caller: Caller) {
  if (caller.caller !== undefined) return caller.caller;
  return yield* fail(
    "session_required",
    "Pass session: this MCP client has no T3 session of its own. Find one with t3_inbox or t3_find_sessions.",
  );
});

const describeMatch = (shell: SessionShell, nowMs: number) =>
  `- \`${shortRef(shell.id)}\` ${shell.title} (${sessionStateOf(shell, nowMs)}, id ${shell.id})`;

/**
 * The one session `ref` names. An omitted ref, `me` or `self` is the caller's
 * own. An exact id is read directly; anything else is matched against the
 * sessions the caller may see, and several matches list the candidates.
 */
export const resolveSession = Effect.fn("agentToolkit.resolveSession")(function* (input: {
  readonly caller: Caller;
  readonly ref: string | undefined;
  readonly nowMs: number;
  readonly sessions?: VisibleSessions | undefined;
}) {
  const { caller } = input;
  const ref = input.ref?.trim() ?? "";
  if (ref.length === 0 || ref === "me" || ref === "self") return yield* ownSession(caller);
  const visible = visibleTo(caller.scope);
  if (caller.caller !== undefined && ref === caller.caller.id) return caller.caller;
  const direct = yield* caller.threads
    .getThreadShell(ThreadId.make(ref))
    .pipe(Effect.orElseSucceed(() => null));
  if (direct !== null && direct.deletedAt === null) {
    if (!visible(direct)) {
      return yield* fail(
        "session_not_visible",
        `Session ${ref} exists, but your user is not its owner or tagged on it. Ask its owner to tag you.`,
      );
    }
    return direct;
  }
  const sessions = input.sessions ?? (yield* loadVisibleSessions(caller, { archived: true }));
  const matches = matchSessionRef(ref, [...sessions.active, ...sessions.archived]);
  const [first] = matches;
  if (first !== undefined && matches.length === 1) return first;
  if (first === undefined) {
    return yield* fail(
      "session_not_found",
      `No session you can see matches "${ref}". Pass a session id, its first 8 characters, a T3 link, a Linear key or a title; t3_find_sessions lists them. An id from another T3 server, a message id or a provider transcript id does not work here.`,
    );
  }
  return yield* fail(
    "session_ambiguous",
    [
      `"${ref}" matches ${matches.length} sessions. Pass one of these ids:`,
      ...matches.slice(0, 8).map((shell) => describeMatch(shell, input.nowMs)),
      ...(matches.length > 8 ? [`- and ${matches.length - 8} more; use a longer reference.`] : []),
    ].join("\n"),
  );
});

/**
 * The project `ref` names, among those the caller may use: its id, its
 * workspace path, its title, or a title that contains the text.
 */
export function matchProjectRef(
  ref: string,
  projects: ReadonlyArray<ProjectSummary>,
): ReadonlyArray<ProjectSummary> {
  const trimmed = ref.trim().replace(/\/+$/, "");
  if (trimmed.length === 0) return [];
  const lower = trimmed.toLowerCase();
  const exact = projects.filter(
    (project) =>
      project.id === trimmed ||
      project.workspaceRoot.replace(/\/+$/, "") === trimmed ||
      project.title.toLowerCase() === lower,
  );
  if (exact.length > 0) return exact;
  const byFolder = projects.filter(
    (project) => project.workspaceRoot.split("/").at(-1)?.toLowerCase() === lower,
  );
  if (byFolder.length > 0) return byFolder;
  return projects.filter((project) => project.title.toLowerCase().includes(lower));
}

/** Projects the caller may use: owner or member, or holding a session it can see. */
export const usableProjects = (
  scope: McpInvocationContext.McpInvocationScope,
  projects: ReadonlyMap<string, ProjectSummary>,
  sessions: ReadonlyArray<SessionShell>,
): ReadonlyArray<ProjectSummary> => {
  const withSessions = new Set(sessions.map((shell) => shell.projectId));
  return [...projects.values()].filter(
    (project) =>
      withSessions.has(project.id) ||
      ownsForkThread(
        {
          ownerUserId: project.ownerUserId ?? null,
          memberUserIds: project.memberUserIds ?? [],
        },
        scope,
      ),
  );
};

export const resolveProject = (
  ref: string,
  projects: ReadonlyArray<ProjectSummary>,
): Effect.Effect<ProjectSummary, AgentToolError> => {
  const matches = matchProjectRef(ref, projects);
  const [first] = matches;
  if (first !== undefined && matches.length === 1) return Effect.succeed(first);
  const known = projects
    .map((project) => `- ${project.title} (${project.workspaceRoot})`)
    .slice(0, 30)
    .join("\n");
  return Effect.fail(
    first === undefined
      ? fail(
          "project_not_found",
          `No project you can use matches "${ref}". Your projects:\n${known}`,
        )
      : fail(
          "project_ambiguous",
          `"${ref}" matches ${matches.length} projects. Pass one of these paths:\n${matches
            .map((project) => `- ${project.title} (${project.workspaceRoot})`)
            .join("\n")}`,
        ),
  );
};
