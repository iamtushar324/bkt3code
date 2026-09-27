// T3-CUSTOM(expbkt3): API-level cost of ONE thread.
//
// The usage page answers "what did this machine spend this week"; this answers
// "what is the session I am looking at costing". Same source of truth — the
// provider transcripts the usage service already parses and prices — narrowed
// to the provider session(s) behind one thread, and broken down by model and
// by day so a long-running session shows where the money went.
//
// Costs are estimates: we run on subscriptions, so the dollar figure is what
// the same tokens would cost at API list prices, priced from the same LiteLLM
// table the usage page uses.
import * as Schema from "effect/Schema";

import { NonNegativeInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import {
  UsageCostSource,
  UsageDay,
  UsagePricing,
  UsageProviderKind,
  UsageTokenTotals,
} from "./usage.ts";

export const THREAD_USAGE_CONTRACT_VERSION = 1 as const;

export const ThreadUsageInput = Schema.Struct({
  threadId: ThreadId,
  /** IANA zone the per-day rows are bucketed in. */
  timeZone: TrimmedNonEmptyString,
});
export type ThreadUsageInput = typeof ThreadUsageInput.Type;

/** One model's share of the thread. */
export const ThreadUsageModelRow = Schema.Struct({
  provider: UsageProviderKind,
  model: TrimmedNonEmptyString,
  totals: UsageTokenTotals,
  costUsd: Schema.Number,
  cacheSavingsUsd: Schema.Number,
  costSource: UsageCostSource,
  /** Transcript records (roughly, assistant turns) that contributed. */
  records: NonNegativeInt,
});
export type ThreadUsageModelRow = typeof ThreadUsageModelRow.Type;

/** One calendar day's share, for the "how is it trending" strip. */
export const ThreadUsageDayRow = Schema.Struct({
  day: UsageDay,
  totals: UsageTokenTotals,
  costUsd: Schema.Number,
  records: NonNegativeInt,
});
export type ThreadUsageDayRow = typeof ThreadUsageDayRow.Type;

export const ThreadUsage = Schema.Struct({
  contractVersion: Schema.Number,
  threadId: ThreadId,
  readAt: Schema.String,
  /** Provider session ids the figures were gathered from; empty = not linked yet. */
  sessionIds: Schema.Array(TrimmedNonEmptyString),
  totals: UsageTokenTotals,
  costUsd: Schema.Number,
  cacheSavingsUsd: Schema.Number,
  costSource: UsageCostSource,
  records: NonNegativeInt,
  /** Most recently used model first. */
  models: Schema.Array(ThreadUsageModelRow),
  /** Oldest day first. */
  days: Schema.Array(ThreadUsageDayRow),
  firstRecordAt: Schema.NullOr(Schema.String),
  lastRecordAt: Schema.NullOr(Schema.String),
  pricing: UsagePricing,
});
export type ThreadUsage = typeof ThreadUsage.Type;
