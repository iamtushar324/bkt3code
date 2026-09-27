/**
 * accessRules - Pure per-user visibility rules for team mode.
 *
 * These operate purely on the ownership/membership fields already carried by
 * thread/project (shells), so assembled snapshots can be post-filtered in
 * memory (fine at a handful of users) without extra queries.
 *
 * Visibility model:
 * - A thread is visible iff the user owns it or is tagged on it directly.
 *   Project membership does NOT reveal a project's threads — sharing is explicit
 *   per thread.
 * - A project appears iff the user owns/is tagged on it, OR it contains at least
 *   one visible thread (so a directly-tagged thread is grouped under its
 *   project). A project tag therefore grants workspace access — the project
 *   shows up and the user can create their own threads in it — without exposing
 *   other people's existing threads.
 * - "Assigned to me" equals thread visibility here: owned or directly tagged.
 *
 * @module accessRules
 */
import type {
  OrchestrationProject,
  OrchestrationProjectShell,
  OrchestrationReadModel,
  OrchestrationShellSnapshot,
  OrchestrationThread,
  OrchestrationThreadShell,
  UserId,
} from "@t3tools/contracts";

interface OwnableEntity {
  readonly ownerUserId: UserId | null;
  readonly memberUserIds: ReadonlyArray<UserId>;
}

interface ThreadLike extends OwnableEntity {
  readonly projectId: string;
}

/** True when the user owns or is a tagged member of the entity. */
export const isOwnerOrMember = (entity: OwnableEntity, userId: UserId): boolean =>
  entity.ownerUserId === userId || entity.memberUserIds.includes(userId);

/** "Assigned to me" — owned or directly tagged on the thread (not via project). */
export const isThreadAssignedToUser = (thread: OwnableEntity, userId: UserId): boolean =>
  isOwnerOrMember(thread, userId);

/**
 * Filter a collection of projects + threads to what `userId` may see, returning
 * the visible subset. Generic over shells and full read-model entities since
 * both carry `ownerUserId` / `memberUserIds` / `projectId`.
 */
const filterProjectsAndThreads = <
  P extends OwnableEntity & { readonly id: string },
  T extends ThreadLike,
>(
  projects: ReadonlyArray<P>,
  threads: ReadonlyArray<T>,
  userId: UserId,
): { readonly projects: ReadonlyArray<P>; readonly threads: ReadonlyArray<T> } => {
  const directlyVisibleProjectIds = new Set(
    projects.filter((project) => isOwnerOrMember(project, userId)).map((project) => project.id),
  );
  // A thread is visible ONLY if the user owns it or is tagged on it directly.
  // Being tagged on the parent project does NOT reveal its threads — a project
  // tag grants workspace access (the project shows up; you can create your own
  // threads there), but existing threads must be shared individually.
  const visibleThreads = threads.filter((thread) => isOwnerOrMember(thread, userId));
  const projectIdsWithVisibleThread = new Set(visibleThreads.map((thread) => thread.projectId));
  const visibleProjects = projects.filter(
    (project) =>
      directlyVisibleProjectIds.has(project.id) || projectIdsWithVisibleThread.has(project.id),
  );
  return { projects: visibleProjects, threads: visibleThreads };
};

export const filterShellSnapshot = (
  snapshot: OrchestrationShellSnapshot,
  userId: UserId,
): OrchestrationShellSnapshot => {
  const filtered = filterProjectsAndThreads<OrchestrationProjectShell, OrchestrationThreadShell>(
    snapshot.projects,
    snapshot.threads,
    userId,
  );
  return { ...snapshot, projects: filtered.projects, threads: filtered.threads };
};

export const filterReadModel = (
  readModel: OrchestrationReadModel,
  userId: UserId,
): OrchestrationReadModel => {
  const filtered = filterProjectsAndThreads<OrchestrationProject, OrchestrationThread>(
    readModel.projects,
    readModel.threads,
    userId,
  );
  return { ...readModel, projects: filtered.projects, threads: filtered.threads };
};

/**
 * True when a thread is visible to the user: they own it or are tagged on it
 * directly. Project membership does not grant thread visibility.
 */
export const isThreadVisible = (thread: ThreadLike, userId: UserId): boolean =>
  isOwnerOrMember(thread, userId);
