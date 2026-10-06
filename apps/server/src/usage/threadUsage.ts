// T3-CUSTOM(expbkt3): folds one thread's transcript records into the
// ThreadUsage shape. Pure, so it is tested without a filesystem.
// @effect-diagnostics globalDate:off -- formats record timestamps already read from disk.
import type {
  ThreadId,
  ThreadUsage,
  ThreadUsageDayRow,
  ThreadUsageModelRow,
  UsageCostSource,
  UsageDay,
  UsageProviderKind,
  UsageTokenTotals,
} from "@t3tools/contracts";

import { makeDayFormatter } from "./usageAggregation.ts";
import { cacheSavingsUsd, priceUsage, type RateTable } from "./usagePricing.ts";
import type { UsageRecord } from "./usageTranscripts.ts";

const EMPTY_TOTALS: UsageTokenTotals = {
  uncachedInputTokens: 0,
  cachedInputTokens: 0,
  cacheCreationTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
};

interface MutableRow {
  // Summed in place, as usageAggregation.ts does since upstream dropped addTotals (#15149).
  totals: { -readonly [K in keyof UsageTokenTotals]: number };
  costUsd: number;
  cacheSavingsUsd: number;
  records: number;
  unpriced: number;
  reported: number;
}

interface MutableModelRow extends MutableRow {
  readonly provider: UsageProviderKind;
  readonly model: string;
  lastMs: number;
}

function emptyRow(): MutableRow {
  return {
    totals: { ...EMPTY_TOTALS },
    costUsd: 0,
    cacheSavingsUsd: 0,
    records: 0,
    unpriced: 0,
    reported: 0,
  };
}

/** The weakest provenance among the records wins, as the usage page does. */
function costSourceOf(row: MutableRow): UsageCostSource {
  if (row.records === 0 || row.unpriced === row.records) return "unpriced";
  if (row.reported === row.records) return "providerReported";
  return "modelPriced";
}

export function aggregateThreadUsage(input: {
  readonly threadId: ThreadId;
  readonly sessionIds: ReadonlyArray<string>;
  readonly records: Iterable<UsageRecord>;
  readonly rates: RateTable;
  readonly priceOverrides?: RateTable;
  readonly timeZone: string;
  readonly readAt: string;
  readonly pricing: ThreadUsage["pricing"];
}): ThreadUsage {
  const wanted = new Set(input.sessionIds);
  const toDay = makeDayFormatter(input.timeZone);
  const seen = new Set<string>();
  const total = emptyRow();
  const byModel = new Map<string, MutableModelRow>();
  const byDay = new Map<string, MutableRow>();
  let firstMs = Number.POSITIVE_INFINITY;
  let lastMs = Number.NEGATIVE_INFINITY;

  for (const record of input.records) {
    if (!wanted.has(record.sessionId)) continue;
    // Same cross-file dedupe the usage page applies: a resumed session copies
    // earlier messages into a new transcript file.
    if (record.dedupeKey !== null) {
      if (seen.has(record.dedupeKey)) continue;
      seen.add(record.dedupeKey);
    }
    const priced = priceUsage(input.rates, record, input.priceOverrides);
    const savings = cacheSavingsUsd(input.rates, record, input.priceOverrides);
    const apply = (row: MutableRow) => {
      const totals = row.totals;
      totals.uncachedInputTokens += record.totals.uncachedInputTokens;
      totals.cachedInputTokens += record.totals.cachedInputTokens;
      totals.cacheCreationTokens += record.totals.cacheCreationTokens;
      totals.outputTokens += record.totals.outputTokens;
      totals.reasoningTokens += record.totals.reasoningTokens;
      row.costUsd += priced.costUsd;
      row.cacheSavingsUsd += savings;
      row.records += 1;
      if (priced.costSource === "unpriced") row.unpriced += 1;
      if (priced.costSource === "providerReported") row.reported += 1;
    };
    apply(total);

    const modelKey = `${record.provider} ${record.model}`;
    let modelRow = byModel.get(modelKey);
    if (modelRow === undefined) {
      modelRow = { ...emptyRow(), provider: record.provider, model: record.model, lastMs: 0 };
      byModel.set(modelKey, modelRow);
    }
    apply(modelRow);
    modelRow.lastMs = Math.max(modelRow.lastMs, record.timestampMs);

    const day = toDay(record.timestampMs);
    let dayRow = byDay.get(day);
    if (dayRow === undefined) {
      dayRow = emptyRow();
      byDay.set(day, dayRow);
    }
    apply(dayRow);

    firstMs = Math.min(firstMs, record.timestampMs);
    lastMs = Math.max(lastMs, record.timestampMs);
  }

  const models: ThreadUsageModelRow[] = [...byModel.values()]
    .sort((a, b) => b.lastMs - a.lastMs)
    .map((row) => ({
      provider: row.provider,
      model: row.model,
      totals: row.totals,
      costUsd: row.costUsd,
      cacheSavingsUsd: row.cacheSavingsUsd,
      costSource: costSourceOf(row),
      records: row.records,
    }));
  const days: ThreadUsageDayRow[] = [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, row]) => ({
      day: day as UsageDay,
      totals: row.totals,
      costUsd: row.costUsd,
      records: row.records,
    }));

  return {
    contractVersion: 1,
    threadId: input.threadId,
    readAt: input.readAt,
    sessionIds: [...wanted],
    totals: total.totals,
    costUsd: total.costUsd,
    cacheSavingsUsd: total.cacheSavingsUsd,
    costSource: costSourceOf(total),
    records: total.records,
    models,
    days,
    firstRecordAt: Number.isFinite(firstMs) ? new Date(firstMs).toISOString() : null,
    lastRecordAt: Number.isFinite(lastMs) ? new Date(lastMs).toISOString() : null,
    pricing: input.pricing,
  };
}
