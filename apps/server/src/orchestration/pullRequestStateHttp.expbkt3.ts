/**
 * T3-CUSTOM(expbkt3): `POST /api/orchestration/pull-request-state` — pull-request
 * state pushed by an external syncer (the Linear bridge, fed by GitHub webhooks).
 *
 * bkt3 makes no outside calls here. A write applies to:
 *   (a) threads already linked to host/repository/number: their link snapshot is
 *       replaced (`thread.pull-request-link.sync`), keeping the stored stack;
 *   (b) unarchived threads on `snapshot.headBranch` whose project repository is
 *       this PR's repository: their branch pull request is set
 *       (`thread.pull-request.sync`), as upstream's branch discovery would.
 * These are the commands `PullRequestSyncReactor` and `ThreadPullRequestReactor`
 * dispatch, so the UI and settlement behave the same whichever side produced
 * them. With `T3_EXTERNAL_PR_SYNC=1` those reactors are off and this is the only
 * writer.
 *
 * Not reproduced: stack discovery (`thread.pull-request.link` with source
 * "stack") needs host reads the payload does not carry, and upstream's
 * "replace a terminal legacy linked PR" step needs the old PR's state.
 *
 * Writes are idempotent per delivery and thread: command ids derive from
 * `deliveryId`, and an identical snapshot is reported `unchanged`. A snapshot
 * whose `updatedAt` is older than the stored one is `stale`, as is a closed or
 * merged PR that would replace a different branch PR.
 *
 * Contract: ~/perf-audit-bkt3/80-api-contract.md, section 2.
 */
import {
  AuthExternalSyncWriteScope,
  CommandId,
  PositiveInt,
  ThreadId,
  type ThreadLinkedPullRequest,
  ThreadPullRequestSnapshot,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import {
  canonicalRepositoryKey,
  sourceControlRepositorySelector,
} from "@t3tools/shared/sourceControl";
import {
  normalizeThreadPullRequestKey,
  threadPullRequestKeysEqual,
  visibleThreadPullRequests,
} from "@t3tools/shared/threadPullRequests";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { authenticateForkRoute, catchForkRouteAuthErrors } from "./forkRouteAuth.expbkt3.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";

export const PULL_REQUEST_STATE_PATH = "/api/orchestration/pull-request-state";

export const PullRequestStateWrite = Schema.Struct({
  deliveryId: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  host: TrimmedNonEmptyString,
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
  url: TrimmedNonEmptyString,
  snapshot: ThreadPullRequestSnapshot,
});
export type PullRequestStateWrite = typeof PullRequestStateWrite.Type;

export interface PullRequestStateResult {
  readonly applied: ReadonlyArray<string>;
  readonly ignored: ReadonlyArray<{ readonly threadId: string; readonly reason: IgnoreReason }>;
}

type IgnoreReason = "stale" | "unchanged";
type Outcome = "applied" | IgnoreReason;

type Snapshot = typeof ThreadPullRequestSnapshot.Type;

/** Same comparison as upstream's PullRequestSyncReactor: every field but `syncedAt`. */
const snapshotFieldsEqual = (left: Snapshot, right: Snapshot): boolean =>
  left.state === right.state &&
  left.title === right.title &&
  left.headBranch === right.headBranch &&
  left.baseBranch === right.baseBranch &&
  left.isDraft === right.isDraft &&
  left.updatedAt === right.updatedAt &&
  (left.closedAt ?? null) === (right.closedAt ?? null) &&
  (left.mergedAt ?? null) === (right.mergedAt ?? null) &&
  (left.author?.login ?? null) === (right.author?.login ?? null) &&
  (left.author?.avatarUrl ?? null) === (right.author?.avatarUrl ?? null) &&
  left.additions === right.additions &&
  left.deletions === right.deletions &&
  left.changedFiles === right.changedFiles &&
  (left.reviewDecision ?? null) === (right.reviewDecision ?? null) &&
  (left.checksState ?? null) === (right.checksState ?? null) &&
  left.mergeability === right.mergeability;

const isOlder = (incoming: string | null, stored: string | null | undefined): boolean =>
  incoming !== null &&
  stored !== null &&
  stored !== undefined &&
  Date.parse(incoming) < Date.parse(stored);

const samePullRequest = (
  left: ThreadLinkedPullRequest | null | undefined,
  right: ThreadLinkedPullRequest,
): boolean =>
  left != null &&
  left.projectId === right.projectId &&
  left.repository.toLowerCase() === right.repository.toLowerCase() &&
  left.number === right.number &&
  left.url === right.url;

/** Combines the outcomes of one thread's link and branch updates. */
const combine = (outcomes: ReadonlyArray<Outcome>): Outcome | null =>
  outcomes.length === 0
    ? null
    : outcomes.includes("applied")
      ? "applied"
      : outcomes.includes("stale")
        ? "stale"
        : "unchanged";

/**
 * The thread moved on between the read and the dispatch, so its own events win.
 * A retried delivery reuses the same command id, and the engine answers a
 * command it already rejected with `OrchestrationCommandPreviouslyRejectedError`;
 * both are a lost race ("stale"), never a failed delivery the syncer would
 * retry forever.
 */
const ignoreRaceLoss = Effect.catchTags({
  OrchestrationCommandInvariantError: () => Effect.succeed("stale" as const),
  OrchestrationCommandPreviouslyRejectedError: () => Effect.succeed("stale" as const),
});

export const applyPullRequestState = Effect.fn("orchestration.pullRequestState.apply")(function* (
  write: PullRequestStateWrite,
) {
  const sql = yield* SqlClient.SqlClient;
  const engine = yield* OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery;
  const key = normalizeThreadPullRequestKey({
    host: write.host,
    repository: write.repository,
    number: write.number,
    url: write.url,
  });
  const repositoryKey = canonicalRepositoryKey(`${key.host}/${key.repository}`);
  const commandId = (threadId: string, kind: string) =>
    CommandId.make(`bridge:pr-state:${write.deliveryId}:${threadId}:${kind}`);

  const candidates = yield* sql<{ readonly threadId: string }>`
    SELECT thread_id AS "threadId"
    FROM projection_thread_pull_requests
    WHERE lower(host) = ${key.host} AND lower(repository) = ${key.repository} AND number = ${key.number}
    UNION
    SELECT thread_id AS "threadId"
    FROM projection_threads
    WHERE branch = ${write.snapshot.headBranch} AND archived_at IS NULL AND deleted_at IS NULL
  `;

  const applied: string[] = [];
  const ignored: Array<{ threadId: string; reason: IgnoreReason }> = [];
  for (const { threadId } of candidates) {
    const thread = Option.getOrUndefined(
      yield* snapshots.getThreadShellById(ThreadId.make(threadId)),
    );
    if (thread === undefined || thread.archivedAt !== null) continue;
    const outcomes: Outcome[] = [];

    // (a) Linked threads: refresh the stored snapshot.
    const link = visibleThreadPullRequests(thread.pullRequests).find((candidate) =>
      threadPullRequestKeysEqual(candidate, key),
    );
    if (link !== undefined) {
      if (isOlder(write.snapshot.updatedAt, link.snapshot?.updatedAt)) {
        outcomes.push("stale");
      } else if (link.snapshot != null && snapshotFieldsEqual(link.snapshot, write.snapshot)) {
        outcomes.push("unchanged");
      } else {
        const outcome = yield* engine
          .dispatch({
            type: "thread.pull-request-link.sync",
            commandId: commandId(thread.id, "link"),
            threadId: thread.id,
            host: key.host,
            repository: link.repository,
            number: link.number,
            snapshot: write.snapshot,
            stack: link.stack ?? null,
          })
          .pipe(Effect.as("applied" as const), ignoreRaceLoss);
        outcomes.push(outcome);
      }
    }

    // (b) Threads on the PR's head branch in the same repository: branch PR.
    if (thread.branch === write.snapshot.headBranch) {
      const project = Option.getOrUndefined(yield* snapshots.getProjectShellById(thread.projectId));
      const repository = sourceControlRepositorySelector(project?.repositoryIdentity);
      if (
        project !== undefined &&
        repository !== null &&
        project.repositoryIdentity != null &&
        canonicalRepositoryKey(project.repositoryIdentity.canonicalKey.toLowerCase()) ===
          repositoryKey
      ) {
        const branchPullRequest = {
          projectId: project.id,
          repository,
          number: write.number,
          url: write.url,
        } satisfies ThreadLinkedPullRequest;
        if (samePullRequest(thread.branchPullRequest, branchPullRequest)) {
          outcomes.push("unchanged");
        } else if (thread.branchPullRequest != null && write.snapshot.state !== "open") {
          // A closed or merged PR never displaces the branch's current one.
          outcomes.push("stale");
        } else {
          const outcome = yield* engine
            .dispatch({
              type: "thread.pull-request.sync",
              commandId: commandId(thread.id, "branch"),
              threadId: thread.id,
              projectId: project.id,
              snapshotSequence: yield* engine.latestSequence,
              expected: {
                workspaceRoot: project.workspaceRoot,
                branch: thread.branch,
                worktreePath: thread.worktreePath,
                linkedPullRequest: thread.linkedPullRequest ?? null,
                branchPullRequest: thread.branchPullRequest ?? null,
              },
              branchPullRequest,
            })
            .pipe(Effect.as("applied" as const), ignoreRaceLoss);
          outcomes.push(outcome);
        }
      }
    }

    const outcome = combine(outcomes);
    if (outcome === "applied") applied.push(thread.id);
    else if (outcome !== null) ignored.push({ threadId: thread.id, reason: outcome });
  }
  return { applied, ignored } satisfies PullRequestStateResult;
});

const decodeWrite = Schema.decodeUnknownEffect(PullRequestStateWrite);

const jsonResponse = (status: number, body: unknown) =>
  HttpServerResponse.jsonUnsafe(body, { status });

export const pullRequestStateRouteLayer = HttpRouter.add(
  "POST",
  PULL_REQUEST_STATE_PATH,
  Effect.gen(function* () {
    yield* authenticateForkRoute(AuthExternalSyncWriteScope);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const write = yield* request.json.pipe(Effect.flatMap(decodeWrite), Effect.option);
    if (Option.isNone(write)) {
      return jsonResponse(400, { error: "invalid-request" });
    }
    const result = yield* applyPullRequestState(write.value);
    yield* Effect.logInfo("pull request state applied", {
      deliveryId: write.value.deliveryId,
      pullRequest: `${write.value.repository}#${write.value.number}`,
      applied: result.applied.length,
      ignored: result.ignored.length,
    });
    return jsonResponse(200, result);
  }).pipe(
    catchForkRouteAuthErrors,
    Effect.catch((error) =>
      Effect.logWarning("pull request state write failed", { error }).pipe(
        Effect.as(jsonResponse(500, { error: "internal-error" })),
      ),
    ),
  ),
);
