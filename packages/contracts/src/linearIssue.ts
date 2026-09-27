/** T3-CUSTOM(expbkt3): Linear issue summaries shown beside lifecycle rows. */
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const LinearIssueStatusInput = Schema.Struct({
  identifiers: Schema.Array(TrimmedNonEmptyString),
});
export type LinearIssueStatusInput = typeof LinearIssueStatusInput.Type;

export const LinearIssueStatusSummary = Schema.Struct({
  identifier: TrimmedNonEmptyString,
  url: Schema.NullOr(TrimmedNonEmptyString),
  status: Schema.NullOr(TrimmedNonEmptyString),
  statusType: Schema.NullOr(TrimmedNonEmptyString),
  updatedAt: Schema.NullOr(TrimmedNonEmptyString),
  error: Schema.NullOr(TrimmedNonEmptyString),
});
export type LinearIssueStatusSummary = typeof LinearIssueStatusSummary.Type;

export const LinearIssueStatusResult = Schema.Struct({
  issues: Schema.Array(LinearIssueStatusSummary),
});
export type LinearIssueStatusResult = typeof LinearIssueStatusResult.Type;
