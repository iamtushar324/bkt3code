// T3-CUSTOM(expbkt3): one thread's API-level cost, for the header pill and the
// detail sheet. Gated on the server capability and on the thread having a
// provider session; refetched when a turn completes, never polled.
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId, ThreadUsage } from "@t3tools/contracts";
import { formatUsd } from "@t3tools/shared/usageFormat";
import { useAtomValue } from "@effect/atom-react";
import { useEffect, useMemo } from "react";

import { useThreadShell } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { threadUsageEnvironment } from "../../state/threadUsage";

/** Under a cent still reads as money, not as "free". */
export function formatThreadCost(costUsd: number): string {
  if (costUsd > 0 && costUsd < 0.01) return "<$0.01";
  return formatUsd(costUsd);
}

export function costSourceLabel(usage: ThreadUsage): string {
  switch (usage.costSource) {
    case "providerReported":
      return "Reported by the provider";
    case "modelPriced":
      return "Priced from LiteLLM list rates";
    case "unpriced":
      return usage.records === 0
        ? "No usage recorded yet"
        : "Model not in the rate table — tokens only";
  }
}

export function useThreadUsage(environmentId: EnvironmentId | null, threadId: ThreadId | null) {
  const shell = useThreadShell(
    environmentId !== null && threadId !== null ? scopeThreadRef(environmentId, threadId) : null,
  );
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId ?? NO_ENVIRONMENT));
  const supported = environmentId !== null && config?.environment.capabilities.threadUsage === true;
  const hasSession = shell?.session?.providerThreadId != null;
  const timeZone = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone, []);
  const query = useEnvironmentQuery<ThreadUsage, unknown>(
    supported && hasSession && environmentId !== null && threadId !== null
      ? threadUsageEnvironment.usage({ environmentId, input: { threadId, timeZone } })
      : null,
  );
  const completedAt = shell?.latestTurn?.completedAt ?? null;
  const { refresh } = query;
  useEffect(() => {
    if (completedAt !== null) refresh();
  }, [completedAt, refresh]);

  return {
    /** False when the pill should not render at all. */
    available: supported && hasSession,
    usage: query.data,
    isPending: query.isPending,
    refresh,
    label: query.data === null ? "…" : formatThreadCost(query.data.costUsd),
  };
}

// Atom families are keyed; a stable placeholder avoids minting one per render.
const NO_ENVIRONMENT = "__thread-usage-no-environment__" as EnvironmentId;
