/** T3-CUSTOM(expbkt3): Mattermost conversation link editor opened from a thread row. */
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
import { resolvePhaseSidebarMattermostLink } from "./PhaseGroupedSidebar.logic";

export function MattermostLinkDialog({
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
    const link = resolvePhaseSidebarMattermostLink(url);
    if (!link) {
      setError("Paste a Mattermost link such as https://chat.example.com/team/pl/postid.");
      return;
    }
    onSave(link.url);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup>
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>Link Mattermost conversation</DialogTitle>
            <DialogDescription>
              Link the Mattermost thread that follows “{threadTitle}”. The Mattermost mark appears
              on the row beside the provider icon.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-2">
            <label htmlFor="mattermost-thread-url" className="text-xs font-medium">
              Mattermost link
            </label>
            <Input
              id="mattermost-thread-url"
              autoFocus
              value={url}
              placeholder="https://chat.example.com/team/pl/postid"
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
            <Button type="submit">Link Mattermost</Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
