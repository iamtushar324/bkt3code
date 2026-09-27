/**
 * T3-CUSTOM(expbkt3): what this session would cost at API list prices.
 *
 * A compact pill in the thread header — just the dollar figure — that opens a
 * breakdown: tokens in / cached / out, per-model rows, per-day rows, and the
 * provenance of the price. We run on subscriptions, so the number is an
 * estimate of what the same tokens would bill through the API; that is still
 * the honest yardstick for "how expensive is this session".
 *
 * Hidden on servers that predate threadUsage.get, and while the thread has no
 * provider session yet (a fresh thread has nothing to price).
 */
import type { EnvironmentId, ThreadId, ThreadUsage } from "@t3tools/contracts";
import { formatTokens, formatUsd } from "@t3tools/shared/usageFormat";
import { useAtomValue } from "@effect/atom-react";
import { CoinsIcon, RefreshCwIcon } from "lucide-react";
import { useEffect, useMemo } from "react";

import { cn } from "~/lib/utils";
import { useThreadShell } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { threadUsageEnvironment } from "../../state/threadUsage";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** Under a cent still reads as money, not as "free". */
export function formatThreadCost(costUsd: number): string {
  if (costUsd > 0 && costUsd < 0.01) return "<$0.01";
  return formatUsd(costUsd);
}

function costSourceLabel(usage: ThreadUsage): string {
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

function TokenStat(props: { readonly label: string; readonly value: number }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground/60">
        {props.label}
      </span>
      <span className="font-mono text-xs tabular-nums text-foreground">
        {formatTokens(props.value)}
      </span>
    </div>
  );
}

export function ThreadCostControl({
  environmentId,
  threadId,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const shell = useThreadShell(scopeThreadRef(environmentId, threadId));
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const supported = config?.environment.capabilities.threadUsage === true;
  const timeZone = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone, []);
  const hasSession = shell?.session?.providerThreadId != null;
  const { data, isPending, refresh } = useEnvironmentQuery<ThreadUsage, unknown>(
    supported && hasSession
      ? threadUsageEnvironment.usage({ environmentId, input: { threadId, timeZone } })
      : null,
  );
  // A finished turn changes the figure; refetch on that cadence rather than
  // polling. `latestTurn.completedAt` moves once per turn.
  const completedAt = shell?.latestTurn?.completedAt ?? null;
  useEffect(() => {
    if (completedAt !== null) refresh();
  }, [completedAt, refresh]);

  if (!supported || !hasSession) return null;

  const label = data === null ? "…" : formatThreadCost(data.costUsd);
  const inputTokens =
    data === null
      ? 0
      : data.totals.uncachedInputTokens +
        data.totals.cachedInputTokens +
        data.totals.cacheCreationTokens;

  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <Button
                  variant="outline"
                  size="sm"
                  className={cn(
                    "h-7 gap-1 px-2 font-mono text-xs tabular-nums",
                    isPending && "opacity-70",
                  )}
                  aria-label={`Session cost ${label}`}
                  data-testid="thread-cost-trigger"
                />
              }
            >
              <CoinsIcon className="size-3.5 text-muted-foreground" />
              {label}
            </PopoverTrigger>
          }
        />
        <TooltipPopup side="bottom">Estimated API cost of this session</TooltipPopup>
      </Tooltip>
      <PopoverPopup align="end" className="w-80" padding="none">
        <div className="space-y-3 p-3" data-testid="thread-cost-popup">
          <div className="flex items-start justify-between gap-2">
            <div>
              <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
                Session cost
              </div>
              <div className="font-mono text-2xl font-semibold tabular-nums">{label}</div>
              <div className="text-[11px] text-muted-foreground">
                {data === null ? "Reading transcripts…" : costSourceLabel(data)}
              </div>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              aria-label="Refresh cost"
              onClick={() => refresh()}
            >
              <RefreshCwIcon className={cn("size-3.5", isPending && "animate-spin")} />
            </Button>
          </div>

          {data === null ? null : (
            <>
              <div className="grid grid-cols-4 gap-2 rounded-md border border-border/60 bg-muted/30 p-2">
                <TokenStat label="Input" value={data.totals.uncachedInputTokens} />
                <TokenStat label="Cached" value={data.totals.cachedInputTokens} />
                <TokenStat label="Output" value={data.totals.outputTokens} />
                <TokenStat label="Total in" value={inputTokens} />
              </div>
              {data.cacheSavingsUsd > 0 ? (
                <p className="text-[11px] text-muted-foreground">
                  Prompt caching saved about{" "}
                  <span className="font-mono tabular-nums text-foreground">
                    {formatThreadCost(data.cacheSavingsUsd)}
                  </span>{" "}
                  against full input rates.
                </p>
              ) : null}

              {data.models.length > 0 ? (
                <section>
                  <h3 className="mb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
                    By model
                  </h3>
                  <ul className="space-y-0.5">
                    {data.models.map((row) => (
                      <li
                        key={`${row.provider}:${row.model}`}
                        className="flex items-center justify-between gap-2 text-xs"
                      >
                        <span className="min-w-0 truncate">
                          <span className="text-muted-foreground/60 uppercase">{row.provider}</span>{" "}
                          {row.model}
                        </span>
                        <span className="shrink-0 font-mono tabular-nums text-muted-foreground">
                          {formatTokens(
                            row.totals.uncachedInputTokens +
                              row.totals.cachedInputTokens +
                              row.totals.outputTokens,
                          )}{" "}
                          · <span className="text-foreground">{formatThreadCost(row.costUsd)}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}

              {data.days.length > 1 ? (
                <section>
                  <h3 className="mb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
                    By day
                  </h3>
                  <ul className="space-y-0.5">
                    {data.days.map((row) => (
                      <li key={row.day} className="flex items-center justify-between gap-2 text-xs">
                        <span className="font-mono text-muted-foreground">{row.day}</span>
                        <span className="font-mono tabular-nums">
                          {formatThreadCost(row.costUsd)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}

              <p className="text-[10px] leading-relaxed text-muted-foreground/70">
                {data.records} assistant turn{data.records === 1 ? "" : "s"} from the provider
                transcript. Estimate at API list prices; a subscription bills differently.
              </p>
            </>
          )}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
