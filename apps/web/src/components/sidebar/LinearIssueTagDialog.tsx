/**
 * T3-CUSTOM(expbkt3): adds one Linear tag — an issue or a project — to a
 * thread, from the row's context menu. A session can carry several.
 */
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
import type { ThreadLinearLink } from "@t3tools/contracts";
import { parseLinearIssueUrl, parseLinearLinkUrl } from "@t3tools/shared/linearIssue";

export function LinearIssueTagDialog({
  open,
  allowProjects,
  initialUrl,
  threadTitle,
  onOpenChange,
  onSave,
}: {
  readonly open: boolean;
  /** False on servers that keep a single issue tag; they cannot store a project. */
  readonly allowProjects: boolean;
  readonly initialUrl: string;
  readonly threadTitle: string;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSave: (link: ThreadLinearLink) => void;
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
    if (!allowProjects) {
      const issue = parseLinearIssueUrl(url);
      if (!issue) {
        setError("Paste a Linear issue URL such as https://linear.app/workspace/issue/ABC-123.");
        return;
      }
      onSave({ url: issue.url, kind: "issue" });
      onOpenChange(false);
      return;
    }
    const link = parseLinearLinkUrl(url);
    if (!link) {
      setError(
        "Paste a Linear issue or project URL such as https://linear.app/workspace/issue/ABC-123.",
      );
      return;
    }
    onSave({ url: link.url, kind: link.kind });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup>
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>{allowProjects ? "Add Linear tag" : "Tag Linear issue"}</DialogTitle>
            <DialogDescription>
              {allowProjects
                ? `Link a Linear issue, sub-issue or project to “${threadTitle}”. An issue shows its current state beside its key.`
                : `Link a Linear ticket to “${threadTitle}”. Its current state will appear beside the ticket key.`}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-2">
            <label htmlFor="linear-issue-url" className="text-xs font-medium">
              {allowProjects ? "Linear issue or project URL" : "Linear ticket URL"}
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
            <Button type="submit">{allowProjects ? "Add tag" : "Tag Linear"}</Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
