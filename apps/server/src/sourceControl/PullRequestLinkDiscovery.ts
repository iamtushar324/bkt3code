import type {
  OrchestrationPullRequestLink,
  OrchestrationPullRequestLinkFailure,
  OrchestrationPullRequestLinksResult,
  OrchestrationShellSnapshot,
  ThreadId,
  VcsStatusInput,
  VcsStatusResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

interface PullRequestRepository {
  readonly canonicalKey: string;
  readonly owner: string;
  readonly name: string;
}

interface PullRequestLinkStatusError {
  readonly _tag: string;
}

function repositoryFromPullRequestUrl(url: string): PullRequestRepository | null {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/\d+(?:[/?#].*)?$/i.exec(
    url.trim(),
  );
  const owner = match?.[1]?.trim();
  const name = match?.[2]?.trim();
  if (!owner || !name) {
    return null;
  }
  return {
    canonicalKey: `github.com/${owner}/${name}`.toLowerCase(),
    owner,
    name,
  };
}

type DiscoveryEntry =
  | { readonly kind: "link"; readonly value: OrchestrationPullRequestLink }
  | { readonly kind: "failure"; readonly value: OrchestrationPullRequestLinkFailure }
  | { readonly kind: "none" };

export function discoverPullRequestLinks(input: {
  readonly snapshot: OrchestrationShellSnapshot;
  readonly getStatus: (
    input: VcsStatusInput,
  ) => Effect.Effect<VcsStatusResult, PullRequestLinkStatusError>;
}): Effect.Effect<OrchestrationPullRequestLinksResult> {
  const projects = new Map(input.snapshot.projects.map((project) => [project.id, project]));
  const candidates = input.snapshot.threads.filter(
    (thread) => thread.archivedAt === null && thread.branch !== null,
  );

  return Effect.forEach(
    candidates,
    (thread): Effect.Effect<DiscoveryEntry> =>
      Effect.gen(function* () {
        const branch = thread.branch;
        if (branch === null) {
          return { kind: "none" };
        }
        const project = projects.get(thread.projectId);
        if (!project) {
          return {
            kind: "failure",
            value: { threadId: thread.id, reason: "project_not_found" },
          };
        }
        const statusResult = yield* input
          .getStatus({ cwd: thread.worktreePath ?? project.workspaceRoot })
          .pipe(Effect.result);
        if (Result.isFailure(statusResult)) {
          return {
            kind: "failure",
            value: { threadId: thread.id, reason: "workspace_unavailable" },
          };
        }
        const status = statusResult.success;
        if (
          !status.isRepo ||
          status.sourceControlProvider?.kind !== "github" ||
          status.refName !== branch ||
          status.pr === null
        ) {
          return { kind: "none" };
        }
        const repository = repositoryFromPullRequestUrl(status.pr.url);
        if (!repository) {
          return {
            kind: "failure",
            value: { threadId: thread.id, reason: "repository_unresolved" },
          };
        }
        return {
          kind: "link",
          value: {
            threadId: thread.id,
            projectId: thread.projectId,
            threadTitle: thread.title,
            threadUpdatedAt: thread.updatedAt,
            branch,
            repository,
            pullRequest: {
              number: status.pr.number,
              title: status.pr.title,
              url: status.pr.url,
              baseRef: status.pr.baseRef,
              headRef: status.pr.headRef,
              state: status.pr.state,
            },
          },
        };
      }),
    { concurrency: 4 },
  ).pipe(
    Effect.map((entries) => ({
      snapshotSequence: input.snapshot.snapshotSequence,
      links: entries.flatMap((entry) => (entry.kind === "link" ? [entry.value] : [])),
      failures: entries.flatMap((entry) => (entry.kind === "failure" ? [entry.value] : [])),
    })),
  );
}
