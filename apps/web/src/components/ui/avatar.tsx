/**
 * Avatar / AvatarStack - user avatars for the tagging UI.
 *
 * `Avatar` renders a user's image, falling back to initials (pattern from
 * ProjectFavicon / ProviderInstanceIcon). `AvatarStack` overlaps several avatars
 * with a `+N` overflow chip and per-avatar tooltips.
 *
 * @module components/ui/avatar
 */
import type { OrchestrationUser } from "@t3tools/contracts";
import { useState } from "react";

import { cn } from "~/lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./tooltip";

const SIZE_CLASS = {
  xs: "size-5 text-[9px]",
  sm: "size-6 text-[10px]",
  md: "size-8 text-xs",
} as const;

export type AvatarSize = keyof typeof SIZE_CLASS;

function initialsFor(user: Pick<OrchestrationUser, "name" | "email" | "id">): string {
  const source = user.name?.trim() || user.email?.trim() || String(user.id);
  const words = source
    .replace(/[_@.-]+/g, " ")
    .split(/\s+/u)
    .filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return words
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? "")
    .join("");
}

export function userDisplayName(user: Pick<OrchestrationUser, "name" | "email" | "id">): string {
  return user.name?.trim() || user.email?.trim() || String(user.id);
}

export function Avatar({
  user,
  size = "sm",
  className,
}: {
  readonly user: Pick<OrchestrationUser, "name" | "email" | "id" | "imageUrl">;
  readonly size?: AvatarSize;
  readonly className?: string;
}) {
  const [loaded, setLoaded] = useState(false);
  const imageUrl = user.imageUrl?.trim() || null;
  return (
    <span
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted font-medium text-muted-foreground ring-1 ring-border",
        SIZE_CLASS[size],
        className,
      )}
      aria-label={userDisplayName(user)}
    >
      {!loaded ? <span aria-hidden>{initialsFor(user)}</span> : null}
      {imageUrl ? (
        <img
          src={imageUrl}
          alt=""
          className={cn("absolute inset-0 size-full object-cover", loaded ? "" : "hidden")}
          onLoad={() => setLoaded(true)}
          onError={() => setLoaded(false)}
        />
      ) : null}
    </span>
  );
}

export function AvatarStack({
  users,
  size = "sm",
  max = 4,
  className,
}: {
  readonly users: ReadonlyArray<Pick<OrchestrationUser, "name" | "email" | "id" | "imageUrl">>;
  readonly size?: AvatarSize;
  readonly max?: number;
  readonly className?: string;
}) {
  const shown = users.slice(0, max);
  const overflow = users.length - shown.length;
  return (
    <span className={cn("flex items-center -space-x-1.5", className)}>
      {shown.map((user) => (
        <Tooltip key={user.id}>
          <TooltipTrigger render={<span className="rounded-full ring-2 ring-background" />}>
            <Avatar user={user} size={size} />
          </TooltipTrigger>
          <TooltipPopup side="bottom">{userDisplayName(user)}</TooltipPopup>
        </Tooltip>
      ))}
      {overflow > 0 ? (
        <span
          className={cn(
            "inline-flex shrink-0 items-center justify-center rounded-full bg-muted font-medium text-muted-foreground ring-2 ring-background",
            SIZE_CLASS[size],
          )}
        >
          +{overflow}
        </span>
      ) : null}
    </span>
  );
}
