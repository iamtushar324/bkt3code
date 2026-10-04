// T3-CUSTOM(expbkt3): visible without hover until the archive request completes.
import { LoaderCircleIcon } from "lucide-react";

export function ThreadArchiveStatus({ title }: { readonly title: string }) {
  return (
    <span
      role="status"
      aria-label={`Archiving ${title}`}
      data-testid="thread-archive-status"
      className="pointer-events-none absolute top-1/2 right-1 z-10 inline-flex -translate-y-1/2 items-center gap-1.5 rounded-md border border-border/70 bg-background/95 px-2.5 py-2 text-xs font-medium text-foreground shadow-sm"
    >
      <LoaderCircleIcon
        aria-hidden
        className="size-3.5 shrink-0 animate-spin text-blue-400 motion-reduce:animate-none"
      />
      Archiving…
    </span>
  );
}
