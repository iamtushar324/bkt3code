/**
 * T3-CUSTOM(expbkt3): EnvironmentBadge - one visual identity for an environment.
 *
 * Every surface that can show rows from more than one environment renders this, so
 * a machine looks the same in the sidebar, in settings and in the command palette.
 * Callers decide *whether* to show it; this component only decides how it looks.
 *
 * @module components/environment/EnvironmentBadge
 */
import type { EnvironmentId } from "@t3tools/contracts";

import { cn } from "~/lib/utils";
import {
  environmentAccentBorder,
  environmentAccentSurface,
  type ResolvedEnvironmentAppearance,
} from "../../state/environmentAppearance";
import { useEnvironmentAppearance } from "../../state/environments";

type BadgeVariant = "full" | "icon" | "glyph" | "dot";

interface EnvironmentBadgeViewProps {
  readonly appearance: ResolvedEnvironmentAppearance;
  readonly variant?: BadgeVariant;
  readonly title?: string | undefined;
  readonly className?: string | undefined;
}

/**
 * Render from an already-resolved appearance. List rows use this so a long list
 * resolves appearances once rather than subscribing per row.
 */
export function EnvironmentBadgeView({
  appearance,
  variant = "full",
  title,
  className,
}: EnvironmentBadgeViewProps) {
  const { Icon, color, name } = appearance;
  const label = title ?? name;

  if (variant === "dot") {
    return (
      <span
        aria-label={label}
        className={cn("inline-block size-2 shrink-0 rounded-full", className)}
        style={{ backgroundColor: color }}
      />
    );
  }

  // The bare glyph in the environment's colour, with no chrome around it. For
  // dense metadata lanes that already carry other small icons — a bordered chip
  // there would outweigh everything beside it.
  if (variant === "glyph") {
    return (
      <Icon aria-label={label} className={cn("size-2.5 shrink-0", className)} style={{ color }} />
    );
  }

  if (variant === "icon") {
    return (
      <span
        aria-label={label}
        className={cn(
          "inline-flex size-5 shrink-0 items-center justify-center rounded-[5px] border",
          className,
        )}
        style={{
          color,
          backgroundColor: environmentAccentSurface(color),
          borderColor: environmentAccentBorder(color),
        }}
      >
        <Icon className="size-3" />
      </span>
    );
  }

  return (
    <span
      aria-label={label}
      className={cn(
        "inline-flex min-w-0 shrink-0 items-center gap-1 rounded-[5px] border px-1.5 py-0.5 text-[11px] leading-none font-medium",
        className,
      )}
      style={{
        color,
        backgroundColor: environmentAccentSurface(color),
        borderColor: environmentAccentBorder(color),
      }}
    >
      <Icon className="size-3 shrink-0" />
      <span className="truncate">{name}</span>
    </span>
  );
}

/**
 * Subscribing variant for single-environment contexts (a chat header, a dialog).
 * Renders nothing when the environment is unknown, so callers can drop it in
 * without guarding.
 */
export function EnvironmentBadge({
  environmentId,
  variant = "full",
  title,
  className,
}: {
  readonly environmentId: EnvironmentId | null;
  readonly variant?: BadgeVariant;
  readonly title?: string | undefined;
  readonly className?: string | undefined;
}) {
  const appearance = useEnvironmentAppearance(environmentId);
  if (appearance === null) return null;
  return (
    <EnvironmentBadgeView
      appearance={appearance}
      variant={variant}
      title={title}
      className={className}
    />
  );
}
