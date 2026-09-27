/**
 * T3-CUSTOM(expbkt3): version history for a plan document.
 *
 * Agent and human revisions interleave in one list, each with its author, so
 * "who changed this plan, and what did it look like before" is answerable
 * without leaving the panel.
 */
import type { PlanReviewVersion } from "@t3tools/contracts";
import { memo, useMemo, useState } from "react";

import { Avatar, userDisplayName } from "../ui/avatar";
import { Button } from "../ui/button";
import { cn } from "../../lib/utils";
import { useCurrentUserId } from "../../state/identity";
import { useOrgMembers } from "../../state/orgMembers";

interface PlanReviewVersionsProps {
  readonly versions: ReadonlyArray<PlanReviewVersion>;
  readonly diff: string | null;
  readonly isDiffPending: boolean;
  readonly onCompare: (fromVersionId: string, toVersionId: string) => void;
  readonly onRestore: (version: PlanReviewVersion) => void;
  readonly canRestore: boolean;
}

const ORIGIN_LABEL: Record<PlanReviewVersion["origin"], string> = {
  "agent-proposed": "Proposed",
  "agent-revision": "Revised",
  "human-edit": "Edited",
};

function formatTimestamp(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function PlanReviewVersionsImpl({
  versions,
  diff,
  isDiffPending,
  onCompare,
  onRestore,
  canRestore,
}: PlanReviewVersionsProps) {
  const { resolveUser } = useOrgMembers();
  const viewerUserId = useCurrentUserId();
  const [selected, setSelected] = useState<ReadonlyArray<string>>([]);

  const ordered = useMemo(() => versions.toReversed(), [versions]);

  const toggleSelection = (versionId: string) => {
    setSelected((current) => {
      if (current.includes(versionId)) return current.filter((id) => id !== versionId);
      // Keep at most two selected; the older one is always the diff base.
      const next = [...current, versionId].slice(-2);
      if (next.length === 2) {
        const fromIndex = versions.findIndex((version) => version.versionId === next[0]);
        const toIndex = versions.findIndex((version) => version.versionId === next[1]);
        const [from, to] = fromIndex <= toIndex ? [next[0]!, next[1]!] : [next[1]!, next[0]!];
        onCompare(from, to);
      }
      return next;
    });
  };

  if (versions.length === 0) {
    return <p className="p-4 text-muted-foreground text-sm">This plan has no versions yet.</p>;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto">
      <p className="px-4 pt-3 pb-1 text-muted-foreground text-xs">
        Select two versions to compare them.
      </p>
      <ul className="flex flex-col gap-1 px-2 pb-2">
        {ordered.map((version) => {
          const isSelected = selected.includes(version.versionId);
          const author =
            version.authorKind === "agent"
              ? "Agent"
              : version.authorUserId === null || version.authorUserId === viewerUserId
                ? "You"
                : userDisplayName(resolveUser(version.authorUserId));

          return (
            <li key={version.versionId}>
              <div
                className={cn(
                  "flex items-center gap-2 rounded-md border px-2 py-1.5 text-sm",
                  isSelected ? "border-primary bg-accent/40" : "border-transparent",
                )}
              >
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  aria-pressed={isSelected}
                  onClick={() => toggleSelection(version.versionId)}
                >
                  {version.authorKind === "user" && version.authorUserId !== null ? (
                    <Avatar user={resolveUser(version.authorUserId)} size="xs" />
                  ) : (
                    <span
                      aria-hidden
                      className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] text-muted-foreground"
                    >
                      AI
                    </span>
                  )}
                  <span className="shrink-0 font-medium tabular-nums">v{version.revision}</span>
                  <span className="truncate text-muted-foreground">
                    {ORIGIN_LABEL[version.origin]} by {author}
                  </span>
                  <span className="ml-auto shrink-0 text-muted-foreground text-xs">
                    {formatTimestamp(version.createdAt)}
                  </span>
                </button>
                {canRestore ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => onRestore(version)}
                    aria-label={`Restore version ${version.revision}`}
                  >
                    Restore
                  </Button>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>

      {isDiffPending ? (
        <p className="px-4 py-2 text-muted-foreground text-xs">Loading diff…</p>
      ) : diff && diff.trim().length > 0 ? (
        <pre className="mx-2 mb-2 overflow-auto rounded-md bg-muted/50 p-3 font-mono text-xs leading-relaxed">
          {diff
            .split("\n")
            .filter(
              (line) =>
                !line.startsWith("diff --git") &&
                !line.startsWith("---") &&
                !line.startsWith("+++"),
            )
            .map((line, index) => ({ line, key: `${index}:${line}` }))
            .map(({ line, key }) => (
              <div
                key={key}
                className={cn(
                  line.startsWith("+") && "text-green-600 dark:text-green-400",
                  line.startsWith("-") && "text-red-600 dark:text-red-400",
                  line.startsWith("@@") && "text-muted-foreground",
                )}
              >
                {line === "" ? " " : line}
              </div>
            ))}
        </pre>
      ) : selected.length === 2 ? (
        <p className="px-4 py-2 text-muted-foreground text-xs">These two versions are identical.</p>
      ) : null}
    </div>
  );
}

export const PlanReviewVersions = memo(PlanReviewVersionsImpl);
