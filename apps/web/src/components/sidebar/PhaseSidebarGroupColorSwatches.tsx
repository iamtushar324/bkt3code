// T3-CUSTOM(expbkt3): the colour choices for a custom sidebar group (XFN-59).
//
// The twelve environment-badge colours plus "Default", which clears the
// colour. Shared by the header's colour popover and the group-by popover; the
// caller decides where the choice is written.
import { PHASE_SIDEBAR_CUSTOM_GROUP_COLOR_OPTIONS } from "@t3tools/client-runtime/state/phase-sidebar-custom-group-registry";

import { cn } from "../../lib/utils";

export function PhaseSidebarGroupColorSwatches({
  groupLabel,
  value,
  onSelect,
}: {
  readonly groupLabel: string;
  /** The group's current colour id; null for the default look. */
  readonly value: string | null;
  readonly onSelect: (colorId: string | null) => void;
}) {
  return (
    <div
      role="group"
      aria-label={`Colour for group ${groupLabel}`}
      className="flex w-36 flex-col gap-2"
      data-testid="phase-sidebar-group-colors"
    >
      <div className="grid grid-cols-6 gap-1.5">
        {PHASE_SIDEBAR_CUSTOM_GROUP_COLOR_OPTIONS.map((option) => (
          <button
            key={option.id}
            type="button"
            aria-label={option.label}
            aria-pressed={value === option.id}
            onClick={() => onSelect(option.id)}
            className={cn(
              "size-5 cursor-pointer rounded-full outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
              value === option.id && "ring-2 ring-foreground ring-offset-1 ring-offset-background",
            )}
            style={{ backgroundColor: option.value }}
          />
        ))}
      </div>
      <button
        type="button"
        aria-pressed={value === null}
        onClick={() => onSelect(null)}
        className={cn(
          "flex h-6 cursor-pointer items-center gap-1.5 rounded-md px-1.5 text-left text-xs outline-hidden hover:bg-accent focus-visible:ring-1 focus-visible:ring-ring",
          value === null ? "text-foreground" : "text-muted-foreground",
        )}
      >
        <span
          aria-hidden
          className="size-3 shrink-0 rounded-full border border-muted-foreground/50"
        />
        Default
      </button>
    </div>
  );
}
