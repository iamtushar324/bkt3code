import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { PositiveInt, TrimmedNonEmptyString } from "@t3tools/contracts";
import { decodeJsonResult } from "@t3tools/shared/schemaJson";

export interface NormalizedGitHubPullRequestRecord {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly baseRefName: string;
  readonly headRefName: string;
  readonly state: "open" | "closed" | "merged";
  readonly isDraft?: boolean;
  readonly closedAt?: string | null;
  readonly mergedAt?: string | null;
  readonly updatedAt: Option.Option<DateTime.Utc>;
  readonly mergeability?: "mergeable" | "conflicting" | "unknown";
  readonly mergeStateStatus?: string;
  readonly reviewDecision?: "approved" | "changes-requested" | "review-required" | "unknown";
  readonly checksStatus?: "pass" | "fail" | "pending" | "unknown";
  readonly autoMergeEnabled?: boolean;
  readonly isCrossRepository?: boolean;
  readonly headRepositoryNameWithOwner?: string | null;
  readonly headRepositoryOwnerLogin?: string | null;
}

const GitHubPullRequestSchema = Schema.Struct({
  number: PositiveInt,
  title: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  baseRefName: TrimmedNonEmptyString,
  headRefName: TrimmedNonEmptyString,
  state: Schema.optional(Schema.NullOr(Schema.String)),
  isDraft: Schema.optional(Schema.Boolean),
  closedAt: Schema.optional(Schema.NullOr(Schema.String)),
  mergedAt: Schema.optional(Schema.NullOr(Schema.String)),
  updatedAt: Schema.optional(Schema.OptionFromNullOr(Schema.DateTimeUtcFromString)),
  mergeable: Schema.optional(Schema.NullOr(Schema.String)),
  mergeStateStatus: Schema.optional(Schema.NullOr(Schema.String)),
  reviewDecision: Schema.optional(Schema.NullOr(Schema.String)),
  statusCheckRollup: Schema.optional(Schema.NullOr(Schema.Array(Schema.Unknown))),
  autoMergeRequest: Schema.optional(Schema.NullOr(Schema.Unknown)),
  isCrossRepository: Schema.optional(Schema.Boolean),
  // gh < 2.47 exports headRepository as {id, name} only; nameWithOwner was
  // added later. Both fields stay optional so a version-drifted gh CLI can
  // never fail the decode and silently drop the PR from the list.
  headRepository: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        nameWithOwner: Schema.optional(Schema.NullOr(Schema.String)),
        name: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
  headRepositoryOwner: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        login: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
});

function normalizeMergeability(value: string | null | undefined) {
  const normalized = value?.trim().toUpperCase();
  return normalized === "MERGEABLE"
    ? ("mergeable" as const)
    : normalized === "CONFLICTING"
      ? ("conflicting" as const)
      : ("unknown" as const);
}

function normalizeReviewDecision(value: string | null | undefined) {
  switch (value?.trim().toUpperCase()) {
    case "APPROVED":
      return "approved" as const;
    case "CHANGES_REQUESTED":
      return "changes-requested" as const;
    case "REVIEW_REQUIRED":
      return "review-required" as const;
    default:
      return "unknown" as const;
  }
}

function normalizeChecksStatus(rollup: ReadonlyArray<unknown> | null | undefined) {
  if (!rollup) return "unknown" as const;
  if (rollup.length === 0) return "pass" as const;
  let pending = false;
  for (const entry of rollup) {
    if (!entry || typeof entry !== "object") return "unknown" as const;
    const item = entry as Record<string, unknown>;
    const value = String(item.conclusion ?? item.state ?? item.status ?? "").toUpperCase();
    if (["FAILURE", "ERROR", "TIMED_OUT", "ACTION_REQUIRED", "CANCELLED"].includes(value)) {
      return "fail" as const;
    }
    if (["PENDING", "QUEUED", "IN_PROGRESS", "EXPECTED", "WAITING"].includes(value)) {
      pending = true;
    }
  }
  return pending ? ("pending" as const) : ("pass" as const);
}

function trimOptionalString(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeGitHubPullRequestState(input: {
  state?: string | null | undefined;
  mergedAt?: string | null | undefined;
}): "open" | "closed" | "merged" {
  const normalizedState = input.state?.trim().toUpperCase();
  if (
    (typeof input.mergedAt === "string" && input.mergedAt.trim().length > 0) ||
    normalizedState === "MERGED"
  ) {
    return "merged";
  }
  if (normalizedState === "CLOSED") {
    return "closed";
  }
  return "open";
}

function normalizeGitHubPullRequestRecord(
  raw: Schema.Schema.Type<typeof GitHubPullRequestSchema>,
): NormalizedGitHubPullRequestRecord {
  const explicitNameWithOwner = trimOptionalString(raw.headRepository?.nameWithOwner);
  const headRepositoryName = trimOptionalString(raw.headRepository?.name);
  const headRepositoryOwnerLogin =
    trimOptionalString(raw.headRepositoryOwner?.login) ??
    (explicitNameWithOwner?.includes("/") ? (explicitNameWithOwner.split("/")[0] ?? null) : null);
  const headRepositoryNameWithOwner =
    explicitNameWithOwner ??
    (headRepositoryOwnerLogin && headRepositoryName
      ? `${headRepositoryOwnerLogin}/${headRepositoryName}`
      : null);

  return {
    number: raw.number,
    title: raw.title,
    url: raw.url,
    baseRefName: raw.baseRefName,
    headRefName: raw.headRefName,
    state: normalizeGitHubPullRequestState(raw),
    closedAt: raw.closedAt ?? null,
    mergedAt: raw.mergedAt ?? null,
    updatedAt: raw.updatedAt ?? Option.none(),
    ...(typeof raw.isDraft === "boolean" ? { isDraft: raw.isDraft } : {}),
    ...(raw.mergeable !== undefined ? { mergeability: normalizeMergeability(raw.mergeable) } : {}),
    ...(trimOptionalString(raw.mergeStateStatus)
      ? { mergeStateStatus: trimOptionalString(raw.mergeStateStatus)! }
      : {}),
    ...(raw.reviewDecision !== undefined
      ? { reviewDecision: normalizeReviewDecision(raw.reviewDecision) }
      : {}),
    ...(raw.statusCheckRollup !== undefined
      ? { checksStatus: normalizeChecksStatus(raw.statusCheckRollup) }
      : {}),
    ...(raw.autoMergeRequest !== undefined
      ? { autoMergeEnabled: raw.autoMergeRequest !== null }
      : {}),
    ...(typeof raw.isCrossRepository === "boolean"
      ? { isCrossRepository: raw.isCrossRepository }
      : {}),
    ...(headRepositoryNameWithOwner ? { headRepositoryNameWithOwner } : {}),
    ...(headRepositoryOwnerLogin ? { headRepositoryOwnerLogin } : {}),
  };
}

const decodeGitHubPullRequestList = decodeJsonResult(Schema.Array(Schema.Unknown));
const decodeGitHubPullRequest = decodeJsonResult(GitHubPullRequestSchema);
const decodeGitHubPullRequestEntry = Schema.decodeUnknownExit(GitHubPullRequestSchema);

export function decodeGitHubPullRequestListJson(
  raw: string,
): Result.Result<
  ReadonlyArray<NormalizedGitHubPullRequestRecord>,
  Cause.Cause<Schema.SchemaError>
> {
  const result = decodeGitHubPullRequestList(raw);
  if (Result.isSuccess(result)) {
    const pullRequests: NormalizedGitHubPullRequestRecord[] = [];
    for (const entry of result.success) {
      const decodedEntry = decodeGitHubPullRequestEntry(entry);
      if (Exit.isFailure(decodedEntry)) {
        continue;
      }
      pullRequests.push(normalizeGitHubPullRequestRecord(decodedEntry.value));
    }
    return Result.succeed(pullRequests);
  }
  return Result.fail(result.failure);
}

export function decodeGitHubPullRequestJson(
  raw: string,
): Result.Result<NormalizedGitHubPullRequestRecord, Cause.Cause<Schema.SchemaError>> {
  const result = decodeGitHubPullRequest(raw);
  if (Result.isSuccess(result)) {
    return Result.succeed(normalizeGitHubPullRequestRecord(result.success));
  }
  return Result.fail(result.failure);
}
