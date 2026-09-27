import { SearchIcon } from "lucide-react";

import { Kbd } from "../ui/kbd";
import { CommandDialogTrigger } from "../ui/command";
import { SidebarMenuButton } from "../ui/sidebar";

export function SidebarSearchAction({ shortcutLabel }: { readonly shortcutLabel?: string | null }) {
  return (
    <CommandDialogTrigger
      render={
        <SidebarMenuButton
          size="sm"
          className="gap-2 px-2 py-1.5 text-muted-foreground/70 hover:bg-accent hover:text-foreground focus-visible:ring-0"
          data-testid="command-palette-trigger"
        />
      }
    >
      <SearchIcon className="size-3.5 text-muted-foreground/70" />
      <span className="flex-1 truncate text-left text-xs">Search</span>
      {shortcutLabel ? (
        <Kbd className="h-4 min-w-0 rounded-sm px-1.5 text-[10px]">{shortcutLabel}</Kbd>
      ) : null}
    </CommandDialogTrigger>
  );
}
