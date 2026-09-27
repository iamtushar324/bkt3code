/** T3-CUSTOM(expbkt3): pick the session a thread should be filed under. */
import type { ThreadId } from "@t3tools/contracts";
import { CornerDownRightIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { ThreadShell } from "../../types";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { resolveMoveUnderCandidates } from "./MoveUnderSessionDialog.logic";

export function MoveUnderSessionDialog({
  subject,
  threads,
  repositoryLabelFor,
  onOpenChange,
  onSelect,
}: {
  /** Null closes the dialog; the row being moved is the dialog's identity. */
  readonly subject: ThreadShell | null;
  readonly threads: ReadonlyArray<ThreadShell>;
  readonly repositoryLabelFor: (thread: ThreadShell) => string;
  readonly onOpenChange: (open: boolean) => void;
  // T3-CUSTOM(expbkt3): a parent may live on another environment, so its id
  // alone no longer identifies it.
  readonly onSelect: (parent: ThreadShell) => void;
}) {
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (subject) setQuery("");
  }, [subject]);

  const candidates = useMemo(
    () =>
      subject ? resolveMoveUnderCandidates({ threads, subject, query, repositoryLabelFor }) : [],
    [query, repositoryLabelFor, subject, threads],
  );

  return (
    <Dialog open={subject !== null} onOpenChange={onOpenChange}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Move under session</DialogTitle>
          <DialogDescription>
            File “{subject?.title}” under another session. It will render nested beneath its parent
            in the sidebar. Its own child sessions move with it. The parent can live on another
            machine, so work spread across environments still reads as one tree.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-2">
          <Input
            autoFocus
            value={query}
            placeholder="Search sessions…"
            aria-label="Search sessions"
            onChange={(event) => setQuery(event.target.value)}
          />
          <ul
            className="max-h-72 space-y-0.5 overflow-y-auto"
            data-testid="move-under-session-candidates"
          >
            {candidates.map((candidate) => (
              <li key={`${candidate.thread.environmentId}:${candidate.thread.id}`}>
                <button
                  type="button"
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-sidebar-row-hover"
                  onClick={() => {
                    onSelect(candidate.thread);
                    onOpenChange(false);
                  }}
                >
                  <CornerDownRightIcon
                    aria-hidden
                    className="size-3 shrink-0 text-muted-foreground/60"
                  />
                  <span className="min-w-0 flex-1 truncate text-xs">{candidate.label}</span>
                  <span className="shrink-0 truncate text-[10px] text-muted-foreground/70">
                    {candidate.repositoryLabel}
                  </span>
                </button>
              </li>
            ))}
            {candidates.length === 0 ? (
              <li className="px-2 py-6 text-center text-xs text-muted-foreground">
                {/* Descendants are absent by design: the server rejects them as
                    cycles, so offering them would only produce a failure. */}
                No eligible sessions
              </li>
            ) : null}
          </ul>
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
