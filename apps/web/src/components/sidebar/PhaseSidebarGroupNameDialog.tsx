/** T3-CUSTOM(expbkt3): name a custom sidebar group — used for both create and rename. */
import { PHASE_SIDEBAR_GROUP_LABEL_MAX_LENGTH } from "@t3tools/client-runtime/state/phase-sidebar-grouping";
import { useEffect, useState, type FormEvent } from "react";

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

export function PhaseSidebarGroupNameDialog({
  open,
  mode,
  initialLabel,
  onOpenChange,
  onSubmit,
}: {
  readonly open: boolean;
  readonly mode: "create" | "rename";
  readonly initialLabel: string;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSubmit: (label: string) => void;
}) {
  const [label, setLabel] = useState(initialLabel);

  useEffect(() => {
    if (open) setLabel(initialLabel);
  }, [initialLabel, open]);

  const trimmed = label.trim();
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (trimmed.length === 0) return;
    onSubmit(trimmed);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup>
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>{mode === "create" ? "New group" : "Rename group"}</DialogTitle>
            <DialogDescription>
              {mode === "create"
                ? "Groups are shared: everyone who can see a session sees which group it is in, and agents can file sessions into one."
                : "Every session in this group is relabelled; nothing else changes."}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-2">
            <label htmlFor="phase-sidebar-group-name" className="text-xs font-medium">
              Group name
            </label>
            <Input
              id="phase-sidebar-group-name"
              autoFocus
              value={label}
              maxLength={PHASE_SIDEBAR_GROUP_LABEL_MAX_LENGTH}
              placeholder="e.g. This week"
              onChange={(event) => setLabel(event.target.value)}
            />
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={trimmed.length === 0}>
              {mode === "create" ? "Create group" : "Rename"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
