/**
 * T3-CUSTOM(expbkt3): Pure view-model helpers for the experimental Active
 * Projects settings surface. Keeping this logic outside upstream settings
 * components makes the customization straightforward to rebase or remove.
 */

export interface ActiveProjectSource {
  readonly environmentId: string;
  readonly id: string;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly updatedAt: string;
}

export interface ActiveProjectThreadSource {
  readonly environmentId: string;
  readonly id: string;
  readonly projectId: string;
  readonly updatedAt: string;
  readonly hasPendingApprovals: boolean;
  readonly hasPendingUserInput: boolean;
  readonly hasActionableProposedPlan: boolean;
  readonly latestTurn: { readonly state: string } | null;
  readonly session: { readonly status: string } | null;
  readonly execution?: { readonly activity: string } | null;
}

export interface ActiveProjectSettingsRow<
  TProject extends ActiveProjectSource,
  TThread extends ActiveProjectThreadSource,
> {
  readonly project: TProject;
  readonly environmentLabel: string;
  readonly sessionCount: number;
  readonly runningCount: number;
  readonly attentionCount: number;
  readonly latestThread: TThread | null;
  readonly lastActivityAt: string;
}

export function activeProjectKey(project: ActiveProjectSource): string {
  return `${project.environmentId}:${project.id}`;
}

export function suggestedProjectNickname(workspaceRoot: string): string {
  const normalized = workspaceRoot.trim().replace(/[\\/]+$/u, "");
  if (!normalized) return "";
  return normalized.split(/[\\/]/u).at(-1) ?? normalized;
}

export function normalizeProjectNickname(value: string): string | null {
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function threadNeedsAttention(thread: ActiveProjectThreadSource): boolean {
  return (
    thread.hasPendingApprovals || thread.hasPendingUserInput || thread.hasActionableProposedPlan
  );
}

function threadIsRunning(thread: ActiveProjectThreadSource): boolean {
  return (
    thread.execution?.activity === "active" ||
    thread.session?.status === "running" ||
    thread.latestTurn?.state === "running"
  );
}

function newestTimestamp(left: string, right: string): string {
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  if (!Number.isFinite(leftMs)) return right;
  if (!Number.isFinite(rightMs)) return left;
  return rightMs > leftMs ? right : left;
}

/**
 * Builds a stable, searchable project view. Projects needing attention sort
 * first, followed by currently running work and then most-recent activity.
 */
export function buildActiveProjectSettingsRows<
  TProject extends ActiveProjectSource,
  TThread extends ActiveProjectThreadSource,
>({
  projects,
  threads,
  environmentLabelById,
  query,
}: {
  readonly projects: ReadonlyArray<TProject>;
  readonly threads: ReadonlyArray<TThread>;
  readonly environmentLabelById: ReadonlyMap<string, string>;
  readonly query: string;
}): ReadonlyArray<ActiveProjectSettingsRow<TProject, TThread>> {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const threadsByProject = new Map<string, Array<TThread>>();

  for (const thread of threads) {
    const key = `${thread.environmentId}:${thread.projectId}`;
    const existing = threadsByProject.get(key);
    if (existing) {
      existing.push(thread);
    } else {
      threadsByProject.set(key, [thread]);
    }
  }

  return projects
    .flatMap((project) => {
      const environmentLabel = environmentLabelById.get(project.environmentId) ?? "Local";
      const matchesQuery =
        normalizedQuery.length === 0 ||
        project.title.toLocaleLowerCase().includes(normalizedQuery) ||
        project.workspaceRoot.toLocaleLowerCase().includes(normalizedQuery) ||
        environmentLabel.toLocaleLowerCase().includes(normalizedQuery);
      if (!matchesQuery) return [];

      const projectThreads = threadsByProject.get(activeProjectKey(project)) ?? [];
      let latestThread: TThread | null = null;
      let lastActivityAt = project.updatedAt;
      let runningCount = 0;
      let attentionCount = 0;

      for (const thread of projectThreads) {
        if (
          latestThread === null ||
          Date.parse(thread.updatedAt) > Date.parse(latestThread.updatedAt)
        ) {
          latestThread = thread;
        }
        lastActivityAt = newestTimestamp(lastActivityAt, thread.updatedAt);
        if (threadIsRunning(thread)) runningCount += 1;
        if (threadNeedsAttention(thread)) attentionCount += 1;
      }

      return [
        {
          project,
          environmentLabel,
          sessionCount: projectThreads.length,
          runningCount,
          attentionCount,
          latestThread,
          lastActivityAt,
        },
      ];
    })
    .sort(
      (left, right) =>
        right.attentionCount - left.attentionCount ||
        right.runningCount - left.runningCount ||
        Date.parse(right.lastActivityAt) - Date.parse(left.lastActivityAt) ||
        left.project.title.localeCompare(right.project.title),
    );
}
