// T3-CUSTOM(expbkt3): collapse the new-thread project list to one row per nickname.
//
// A project registered on several machines produced one indistinguishable row
// per machine ("bks", "bks"), so the picker asked the operator to choose
// between rows that looked identical. Nicknames are collapsed here instead, and
// the machine becomes a second, explicit question asked only when the nickname
// actually resolves to more than one place.
//
// Kept separate from the dialog so the collapsing rule — which decides whether
// the operator is asked that second question at all — is testable on its own.
import type { EnvironmentId } from "@t3tools/contracts";

import type { Project } from "../../types";
import { resolveEnvironmentOptionLabel } from "../BranchToolbar.logic";

/**
 * One place a nickname resolves to. Usually one machine, but a single machine
 * holding two checkouts of the same name contributes two hosts, told apart by
 * `workspaceRoot`.
 */
export interface NewThreadProjectHost {
  readonly project: Project;
  readonly environmentId: EnvironmentId;
  /** "This device" for the primary environment, else its nickname. */
  readonly label: string;
  readonly workspaceRoot: string;
  readonly isPrimary: boolean;
  readonly isActive: boolean;
}

export interface NewThreadProjectOption {
  /** Stable across renders: the normalized nickname the bucket was keyed on. */
  readonly key: string;
  /** Shown to the operator, in the casing of the first project that used it. */
  readonly title: string;
  readonly hosts: readonly NewThreadProjectHost[];
  /**
   * Where the thread starts when the operator picks this row without being
   * asked anything further. Only meaningful on its own when `hosts` has one
   * entry; otherwise it seeds the host overlay's focus.
   */
  readonly defaultHost: NewThreadProjectHost;
  /** True when the picker should ask which host before starting the thread. */
  readonly requiresHostChoice: boolean;
  readonly containsActiveProject: boolean;
}

function projectNickname(project: Project): string {
  const title = project.title.trim();
  if (title.length > 0) return title;
  // Untitled projects would otherwise all collapse into one bucket, hiding
  // real projects behind each other — fall back to something per-project.
  const segments = project.workspaceRoot.split("/").filter((segment) => segment.length > 0);
  return segments[segments.length - 1] ?? project.workspaceRoot;
}

function isSameProject(left: Project, right: Project): boolean {
  return left.environmentId === right.environmentId && left.id === right.id;
}

/**
 * Group `projects` by nickname, newest bucket last, preserving the caller's
 * ordering by first appearance so an already-sorted list keeps its sort.
 *
 * Hosts within a bucket are ordered primary-first, then by label, then by
 * workspace path, so the overlay's row order is stable across renders and does
 * not depend on the order environments happened to connect in.
 */
export function buildNewThreadProjectOptions(input: {
  readonly projects: ReadonlyArray<Project>;
  readonly activeProject: Project | null;
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly resolveEnvironmentLabel: (environmentId: EnvironmentId) => string | null;
}): readonly NewThreadProjectOption[] {
  const buckets = new Map<string, { title: string; projects: Project[] }>();

  for (const project of input.projects) {
    const title = projectNickname(project);
    const key = title.toLocaleLowerCase();
    const bucket = buckets.get(key);
    if (!bucket) {
      buckets.set(key, { title, projects: [project] });
      continue;
    }
    // The same project reaching us twice must not become two host rows.
    if (bucket.projects.some((existing) => isSameProject(existing, project))) continue;
    bucket.projects.push(project);
  }

  return [...buckets.entries()].map(([key, bucket]): NewThreadProjectOption => {
    const hosts = bucket.projects
      .map((project): NewThreadProjectHost => {
        const isPrimary =
          input.primaryEnvironmentId !== null &&
          project.environmentId === input.primaryEnvironmentId;
        return {
          project,
          environmentId: project.environmentId,
          label: resolveEnvironmentOptionLabel({
            isPrimary,
            environmentId: project.environmentId,
            runtimeLabel: input.resolveEnvironmentLabel(project.environmentId),
          }),
          workspaceRoot: project.workspaceRoot,
          isPrimary,
          isActive: input.activeProject !== null && isSameProject(project, input.activeProject),
        };
      })
      .toSorted(
        (left, right) =>
          Number(right.isPrimary) - Number(left.isPrimary) ||
          left.label.localeCompare(right.label) ||
          left.workspaceRoot.localeCompare(right.workspaceRoot) ||
          String(left.project.id).localeCompare(String(right.project.id)),
      );

    // Non-null: every bucket was created from at least one project.
    const defaultHost =
      hosts.find((host) => host.isActive) ?? hosts.find((host) => host.isPrimary) ?? hosts[0]!;

    return {
      key,
      title: bucket.title,
      hosts,
      defaultHost,
      requiresHostChoice: hosts.length > 1,
      containsActiveProject: hosts.some((host) => host.isActive),
    };
  });
}

/**
 * The option the host overlay is showing, re-read from freshly built options.
 *
 * Environments connect and drop while the overlay is open, so the selection is
 * held as a nickname key rather than a captured option: a stale copy would go
 * on offering a machine that has since gone away.
 */
export function findNewThreadProjectOption(
  options: readonly NewThreadProjectOption[],
  key: string | null,
): NewThreadProjectOption | null {
  if (key === null) return null;
  return options.find((option) => option.key === key) ?? null;
}
