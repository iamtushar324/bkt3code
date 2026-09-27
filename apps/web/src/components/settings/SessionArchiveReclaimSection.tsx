/**
 * T3-CUSTOM(expbkt3): Reclaim disk from archived sessions' worktrees.
 *
 * Upstream removes a worktree only when a thread is *deleted*, so archived
 * worktrees accumulate until the only way to free the disk is to destroy the
 * history. This panel offers the middle path: every action exports the
 * session's history first, then either slims the worktree (deleting only what a
 * package manager can rebuild) or removes it outright.
 *
 * The scan is behind a button rather than run on mount because it walks the
 * filesystem — on a busy host that is seconds of IO nobody asked for.
 */
import {
  isForceableBlockedReason,
  type EnvironmentId,
  type SessionArchiveEntry,
  type SessionArchiveScanResult,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { HardDriveIcon, LoaderIcon, RefreshCwIcon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { sessionArchiveEnvironment } from "../../state/sessionArchive";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { cn } from "../../lib/utils";
import {
  advanceProgress,
  applySelectionScope,
  describeProgress,
  describeReclaimResult,
  describeReclaimState,
  describeScanSummary,
  estimateActionBytes,
  formatBytes,
  initialProgress,
  isEntryActionable,
  progressPercent,
  projectGroups,
  selectionTargets,
  sortEntriesForDisplay,
  stateGroups,
  summarizeSelection,
  type ReclaimProgress,
  type SelectionScope,
} from "./SessionArchiveReclaimSection.logic";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsRow, SettingsSection } from "./settingsLayout";

/** Entries rendered before the list is truncated. */
const VISIBLE_ENTRY_LIMIT = 25;

export function SessionArchiveReclaimSection({
  environmentIds,
  onReclaimed,
}: {
  readonly environmentIds: ReadonlyArray<EnvironmentId>;
  readonly onReclaimed: () => void;
}) {
  const [scanResult, setScanResult] = useState<SessionArchiveScanResult | null>(null);
  const [selectedThreadIds, setSelectedThreadIds] = useState<ReadonlySet<string>>(new Set());
  const [isBusy, setIsBusy] = useState(false);
  const [showOrphans, setShowOrphans] = useState(false);
  // Null except while a reclaim is running, and for the summary immediately
  // after it finishes — cleared by the next scan.
  const [progress, setProgress] = useState<ReclaimProgress | null>(null);

  const scan = useAtomCommand(sessionArchiveEnvironment.scan, {
    label: "session archive scan",
  });
  const reclaim = useAtomCommand(sessionArchiveEnvironment.reclaim, {
    label: "session archive reclaim",
  });

  // The panel is single-environment on purpose: reclaim is a disk operation on
  // the machine hosting that server, and mixing hosts in one list would make
  // "3.6 GB to free" mean nothing in particular.
  const environmentId = environmentIds[0] ?? null;

  const entries = useMemo(
    () => (scanResult === null ? [] : sortEntriesForDisplay(scanResult.entries)),
    [scanResult],
  );
  const selection = useMemo(
    () => summarizeSelection(entries, selectedThreadIds),
    [entries, selectedThreadIds],
  );

  const reportFailure = useCallback((title: string, result: unknown) => {
    if (isAtomCommandInterrupted(result as never)) {
      return;
    }
    const error = squashAtomCommandFailure(result as never);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title,
        description: error instanceof Error ? error.message : "An error occurred.",
      }),
    );
  }, []);

  const runScan = useCallback(async () => {
    if (environmentId === null) {
      return;
    }
    setIsBusy(true);
    // The previous run's summary describes numbers this scan is about to
    // replace, so it goes before the new results arrive.
    setProgress(null);
    const result = await scan({ environmentId, input: {} });
    setIsBusy(false);
    if (result._tag === "Success") {
      setScanResult(result.value);
      // A stale selection would point at threads the new scan may not contain.
      setSelectedThreadIds(new Set());
      return;
    }
    reportFailure("Could not scan archived sessions", result);
  }, [environmentId, reportFailure, scan]);

  const runReclaim = useCallback(
    async (action: "slim" | "remove" | "force-remove") => {
      if (environmentId === null) {
        return;
      }
      const targetIds = selectionTargets(entries, selectedThreadIds, action);
      if (targetIds.length === 0) {
        return;
      }
      const mode = action === "slim" ? "slim" : "remove";
      const force = action === "force-remove";

      // A forced remove is the only action here that destroys work the operator
      // cannot get back, so its confirmation names the count and what is lost
      // rather than describing the action in general terms.
      const forcedCount = force ? selection.forceableCount : 0;
      const confirmed = globalThis.confirm(
        action === "slim"
          ? `Delete regenerable directories (node_modules, build output, caches) from ${targetIds.length} session worktree(s)?\n\nEach session's history is exported first. The checkouts and branches stay intact.`
          : action === "remove"
            ? `Remove ${targetIds.length} session worktree(s) entirely?\n\nEach session's history is exported first. Reopening one of these sessions will have to re-create its worktree.`
            : `Force-remove ${targetIds.length} session worktree(s)?\n\n${forcedCount} of them have uncommitted changes, untracked files, or commits that are not on any remote. That work will be PERMANENTLY LOST — only the exported history digest and transcript will remain.\n\nWorktrees in use by a live or active session are never removed, forced or not.`,
      );
      if (!confirmed) {
        return;
      }

      setIsBusy(true);

      // One call per session rather than one for the batch. The RPC answers
      // only when it is finished, so a single batched call would show nothing
      // at all until every worktree was gone; per-session calls are what make
      // the progress bar — and a meaningful partial result — possible. The
      // server re-checks its safety gates on every call, so this is no less
      // safe, only chattier.
      const byThreadId = new Map(entries.map((item) => [item.threadId, item] as const));
      const base = initialProgress({
        action,
        total: targetIds.length,
        estimatedBytes: estimateActionBytes(entries, targetIds, action),
      });
      // Folded through `advanceProgress` but held in one binding rather than
      // rebuilt per iteration, so the loop does not spread an accumulator.
      let running: ReclaimProgress = base;
      const publish = (next: ReclaimProgress) => {
        running = next;
        setProgress(next);
      };
      publish(base);

      let firstSkipReason: string | null = null;
      let failureCount = 0;

      for (const threadId of targetIds) {
        publish({ ...running, currentTitle: byThreadId.get(threadId)?.title ?? null });

        const step = await reclaim({
          environmentId,
          input: { threadIds: [threadId], mode, force },
        });

        if (step._tag !== "Success") {
          failureCount += 1;
          publish(advanceProgress(running, { reclaimed: false, freedBytes: 0 }));
          continue;
        }

        const outcome = step.value.outcomes[0];
        publish(
          advanceProgress(running, {
            reclaimed: outcome?.reclaimed ?? false,
            freedBytes: step.value.totalFreedBytes,
          }),
        );
        if (firstSkipReason === null && outcome?.skippedReason != null) {
          firstSkipReason = outcome.skippedReason;
        }
      }

      publish({ ...running, currentTitle: null, finished: true });
      setIsBusy(false);

      if (failureCount === running.total) {
        reportFailure("Reclaim failed", { _tag: "Failure" });
        return;
      }

      toastManager.add(
        stackedThreadToast({
          type: running.reclaimedCount === 0 ? "error" : "success",
          title: "Archived sessions reclaimed",
          description: [
            describeReclaimResult({
              mode,
              reclaimedCount: running.reclaimedCount,
              skippedCount: running.skippedCount,
              freedBytes: running.freedBytes,
            }),
            // The first skip reason is far more useful than a count alone.
            firstSkipReason ?? "",
          ]
            .filter(Boolean)
            .join(" "),
        }),
      );

      onReclaimed();
      await runScan();
    },
    [
      entries,
      environmentId,
      onReclaimed,
      reclaim,
      reportFailure,
      runScan,
      selectedThreadIds,
      selection.forceableCount,
    ],
  );

  const toggleEntry = useCallback((threadId: string) => {
    setSelectedThreadIds((current) => {
      const next = new Set(current);
      if (next.has(threadId)) {
        next.delete(threadId);
      } else {
        next.add(threadId);
      }
      return next;
    });
  }, []);

  const selectScope = useCallback(
    (scope: SelectionScope) => {
      setSelectedThreadIds(applySelectionScope(entries, scope));
    },
    [entries],
  );

  const projectOptions = useMemo(() => projectGroups(entries), [entries]);
  const stateOptions = useMemo(() => stateGroups(entries), [entries]);

  if (environmentId === null) {
    return null;
  }

  const visibleEntries = entries.slice(0, VISIBLE_ENTRY_LIMIT);

  return (
    <SettingsSection
      title="Worktree disk"
      headerAction={
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 shrink-0 cursor-pointer gap-1.5 px-2.5"
          disabled={isBusy}
          onClick={() => void runScan()}
        >
          {isBusy ? (
            <LoaderIcon className="size-3.5 animate-spin" />
          ) : (
            <RefreshCwIcon className="size-3.5" />
          )}
          <span>{scanResult === null ? "Scan" : "Rescan"}</span>
        </Button>
      }
    >
      {scanResult === null ? (
        <SettingsRow
          title={
            <span className="inline-flex items-center gap-2">
              <HardDriveIcon className="size-3.5 text-muted-foreground" />
              Reclaim disk from archived sessions
            </span>
          }
          description="Archived sessions keep their worktree on disk indefinitely. Scanning measures what each one still occupies and what can be given back. Every reclaim exports the session's history first, so nothing you did is lost."
        />
      ) : (
        <>
          {progress !== null ? <ReclaimProgressRow progress={progress} /> : null}
          <SettingsRow
            title="Scan results"
            description={describeScanSummary(scanResult)}
            status={`History is written to ${scanResult.historyDir}`}
            control={
              <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 cursor-pointer px-2.5"
                  disabled={isBusy || !selection.canSlim}
                  onClick={() => void runReclaim("slim")}
                >
                  Slim ({formatBytes(selection.reclaimableBytes)})
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  className="h-7 cursor-pointer px-2.5"
                  disabled={isBusy || !selection.canRemove}
                  onClick={() => void runReclaim("remove")}
                >
                  Remove worktree
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  className="h-7 cursor-pointer px-2.5"
                  disabled={isBusy || !selection.canForceRemove}
                  onClick={() => void runReclaim("force-remove")}
                  title="Remove worktrees even when they hold uncommitted or unpushed work. Live and shared worktrees are still never removed."
                >
                  Force remove ({selection.forceRemoveCount})
                </Button>
              </div>
            }
          />

          {/* Bulk selection lives on its own row: with hundreds of archived
              sessions, picking a set is a distinct step from acting on it. */}
          <SettingsRow
            title="Select"
            description={
              selection.selectedCount === 0
                ? "Nothing selected."
                : `${selection.selectedCount} selected · ${selection.eligibleCount} slimmable · ${selection.canRemove ? selectionTargets(entries, selectedThreadIds, "remove").length : 0} removable${selection.forceableCount > 0 ? ` · ${selection.forceableCount} need force` : ""}`
            }
            control={
              <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 cursor-pointer px-2.5"
                  disabled={isBusy || entries.length === 0}
                  onClick={() => selectScope({ kind: "all" })}
                >
                  All ({entries.length})
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 cursor-pointer px-2.5"
                  disabled={isBusy || selection.selectedCount === 0}
                  onClick={() => selectScope({ kind: "none" })}
                >
                  None
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 cursor-pointer px-2.5"
                  disabled={isBusy || entries.length === 0}
                  onClick={() => selectScope({ kind: "reclaimable" })}
                >
                  Reclaimable
                </Button>
                <Select
                  aria-label="Select all worktrees in a project"
                  disabled={isBusy || projectOptions.length === 0}
                  value=""
                  onValueChange={(value) => {
                    if (typeof value === "string" && value.length > 0) {
                      selectScope({ kind: "project", projectId: value });
                    }
                  }}
                >
                  <SelectTrigger className="h-7 w-40">
                    <SelectValue placeholder="By project…" />
                  </SelectTrigger>
                  <SelectPopup>
                    {projectOptions.map((group) => (
                      <SelectItem key={group.id} value={group.id}>
                        {group.label} ({group.count})
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
                <Select
                  aria-label="Select all worktrees in a state"
                  disabled={isBusy || stateOptions.length === 0}
                  value=""
                  onValueChange={(value) => {
                    if (
                      value === "present" ||
                      value === "slimmed" ||
                      value === "removed" ||
                      value === "missing"
                    ) {
                      selectScope({ kind: "state", state: value });
                    }
                  }}
                >
                  <SelectTrigger className="h-7 w-40">
                    <SelectValue placeholder="By state…" />
                  </SelectTrigger>
                  <SelectPopup>
                    {stateOptions.map((group) => (
                      <SelectItem key={group.id} value={group.id}>
                        {group.label} ({group.count})
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>
            }
          />

          {visibleEntries.map((entry) => (
            <SettingsRow
              key={entry.threadId}
              title={
                <span className="inline-flex items-center gap-2">
                  <Checkbox
                    checked={selectedThreadIds.has(entry.threadId)}
                    // Selectable whenever *some* action applies. An entry a
                    // plain slim refuses may still be force-removable, and a
                    // checkbox that cannot be ticked would hide that.
                    disabled={isBusy || !isEntryActionable(entry)}
                    onCheckedChange={() => toggleEntry(entry.threadId)}
                    aria-label={`Select ${entry.title}`}
                  />
                  <span className="truncate">{entry.title}</span>
                </span>
              }
              description={
                <>
                  {formatBytes(entry.worktreeBytes)} on disk
                  {entry.reclaimableBytes !== null && entry.reclaimableBytes > 0
                    ? ` · ${formatBytes(entry.reclaimableBytes)} reclaimable`
                    : ""}
                  {entry.branch ? ` · ${entry.branch}` : ""}
                  {entry.projectName ? ` · ${entry.projectName}` : ""}
                </>
              }
              status={
                entry.blockedReason !== null
                  ? blockedText(entry.blockedReason)
                  : isForceableBlockedReason(entry.removeBlockedReason)
                    ? `${describeReclaimState(entry)} · ${blockedText(entry.removeBlockedReason)} Force remove overrides this.`
                    : describeReclaimState(entry)
              }
              control={<Badge {...entryBadge(entry)} />}
            />
          ))}

          {entries.length > VISIBLE_ENTRY_LIMIT ? (
            <SettingsRow
              title={`${entries.length - VISIBLE_ENTRY_LIMIT} more archived sessions`}
              description="Only the largest are listed. Reclaim these, then rescan to see the rest."
            />
          ) : null}

          {scanResult.orphanedWorktrees.length > 0 ? (
            <SettingsRow
              title={`${scanResult.orphanedWorktrees.length} orphaned worktrees`}
              description="Worktree directories on disk that no session points at. They are never reclaimed automatically, because nothing in the database can say what is safe about them — inspect and remove these by hand."
              status={
                showOrphans
                  ? scanResult.orphanedWorktrees
                      .slice(0, 10)
                      .map((orphan) => orphan.worktreePath)
                      .join("\n")
                  : undefined
              }
              control={
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 shrink-0 cursor-pointer px-2.5"
                  onClick={() => setShowOrphans((current) => !current)}
                >
                  {showOrphans ? "Hide paths" : "Show paths"}
                </Button>
              }
            />
          ) : null}
        </>
      )}
    </SettingsSection>
  );
}

/**
 * Live progress of a running reclaim.
 *
 * A horizontal bar rather than a radial one: this sits in a full-width settings
 * row where the bar pairs naturally with a text line beside it, and it matches
 * the meter idiom already used elsewhere in the app. A radial gauge would suit
 * a square dashboard tile, not a list row.
 *
 * The freed figure is the headline because it is the question being asked —
 * how much space is coming back — and it is real, summed from what the server
 * reported actually deleting, not from the estimate.
 */
function ReclaimProgressRow({ progress }: { readonly progress: ReclaimProgress }) {
  const percent = progressPercent(progress);
  return (
    <SettingsRow
      title={
        <span className="inline-flex items-center gap-2">
          {progress.finished ? (
            <HardDriveIcon className="size-3.5 text-muted-foreground" />
          ) : (
            <LoaderIcon className="size-3.5 animate-spin text-muted-foreground" />
          )}
          <span className="tabular-nums">{formatBytes(progress.freedBytes)} freed</span>
          {progress.estimatedBytes !== null && !progress.finished ? (
            <span className="text-muted-foreground">
              of ~{formatBytes(progress.estimatedBytes)} expected
            </span>
          ) : null}
        </span>
      }
      description={
        <div className="flex flex-col gap-1.5 pt-0.5">
          <div
            className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(percent)}
            aria-label="Reclaim progress"
          >
            <div
              className={cn(
                "h-full rounded-full transition-[width] duration-300 ease-out",
                progress.finished ? "bg-success" : "bg-primary/70",
              )}
              style={{ width: `${percent}%` }}
            />
          </div>
          <span className="truncate tabular-nums text-muted-foreground">
            {describeProgress(progress)}
          </span>
        </div>
      }
    />
  );
}

/**
 * Badge for one row.
 *
 * Three states, not two: an entry a plain remove refuses but a forced one would
 * take reads as "Needs force", so the list distinguishes work-at-risk from a
 * worktree that is genuinely untouchable.
 */
function entryBadge(entry: SessionArchiveEntry): {
  readonly variant: "success" | "warning" | "error";
  readonly className: string;
  readonly children: string;
} {
  if (entry.blockedReason !== null) {
    return { variant: "warning", className: "shrink-0", children: "Held" };
  }
  if (isForceableBlockedReason(entry.removeBlockedReason)) {
    return { variant: "error", className: "shrink-0", children: "Needs force" };
  }
  return { variant: "success", className: "shrink-0", children: "Reclaimable" };
}

/** Mirrors the server's `describeBlockedReason`, phrased for this list. */
function blockedText(reason: string): string {
  switch (reason) {
    case "worktree-shared":
      return "Held — another active session uses this worktree.";
    case "worktree-live":
      return "Held — a session is running out of this worktree.";
    case "dirty-worktree":
      return "Held — uncommitted or untracked changes.";
    case "unpushed-commits":
      return "Held — commits are not on any remote.";
    case "retention-window":
      return "Held — archived too recently.";
    case "no-worktree":
      return "Nothing on disk to reclaim.";
    case "not-a-managed-worktree":
      return "Held — works in a main checkout, not a T3-provisioned worktree.";
    default:
      return "Held.";
  }
}
