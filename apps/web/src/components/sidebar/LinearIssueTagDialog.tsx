/** T3-CUSTOM(expbkt3): manual Linear tag editor opened from a thread row. */
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
import { resolvePhaseSidebarLinearIssue } from "./PhaseGroupedSidebar.logic";

export function LinearIssueTagDialog({
  open,
  initialUrl,
  threadTitle,
  onOpenChange,
  onSave,
}: {
  readonly open: boolean;
  readonly initialUrl: string;
  readonly threadTitle: string;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSave: (url: string) => void;
}) {
  const [url, setUrl] = useState(initialUrl);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setUrl(initialUrl);
    setError(null);
  }, [initialUrl, open]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const issue = resolvePhaseSidebarLinearIssue(null, url);
    if (!issue) {
      setError("Paste a Linear issue URL such as https://linear.app/workspace/issue/ABC-123.");
      return;
    }
    onSave(issue.url);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup>
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>Tag Linear issue</DialogTitle>
            <DialogDescription>
              Link a Linear ticket to “{threadTitle}”. Its current state will appear beside the
              ticket key.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-2">
            <label htmlFor="linear-issue-url" className="text-xs font-medium">
              Linear ticket URL
            </label>
            <Input
              id="linear-issue-url"
              autoFocus
              value={url}
              placeholder="https://linear.app/workspace/issue/ABC-123"
              aria-invalid={error !== null}
              onChange={(event) => {
                setUrl(event.target.value);
                setError(null);
              }}
            />
            {error ? <p className="text-xs text-destructive">{error}</p> : null}
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit">Tag Linear</Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
