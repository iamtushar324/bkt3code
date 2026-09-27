/**
 * MemberPicker - searchable member checkbox list (team mode).
 *
 * Presentational: the parent (ThreadMembersControl / project-access settings)
 * owns the popover/dialog shell and the command wiring. The owner row is checked
 * + disabled with an "Owner" badge. Rows are disabled while their toggle is
 * pending. Structure follows the phase sidebar's search + checkbox-row popover.
 * Owners/admins may also promote any organization user
 * to owner; ownership transfer is handled by the parent.
 *
 * @module components/members/MemberPicker
 */
import type { OrchestrationUser, UserId } from "@t3tools/contracts";
import { SearchIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { cn } from "~/lib/utils";
import { Avatar, userDisplayName } from "../ui/avatar";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";

export function MemberPicker({
  users,
  ownerUserId,
  memberUserIds,
  pendingUserIds,
  onToggle,
  canTransferOwnership = false,
  onTransferOwnership,
  resolveUser,
}: {
  readonly users: ReadonlyArray<OrchestrationUser>;
  readonly ownerUserId: UserId | null;
  readonly memberUserIds: ReadonlyArray<UserId>;
  readonly pendingUserIds: ReadonlySet<UserId>;
  readonly onToggle: (userId: UserId, nextChecked: boolean) => void;
  readonly canTransferOwnership?: boolean;
  readonly onTransferOwnership?: (userId: UserId) => void;
  readonly resolveUser: (id: UserId) => OrchestrationUser;
}) {
  const [search, setSearch] = useState("");
  const memberSet = useMemo(() => new Set(memberUserIds), [memberUserIds]);

  // Union of directory users + any owner/member ids not in the directory
  // (departed users), so nothing silently disappears from the list.
  const rows = useMemo(() => {
    const ids = new Set<UserId>();
    for (const user of users) ids.add(user.id);
    if (ownerUserId !== null) ids.add(ownerUserId);
    for (const id of memberUserIds) ids.add(id);
    const needle = search.trim().toLowerCase();
    return [...ids]
      .map((id) => resolveUser(id))
      .filter((user) =>
        needle.length === 0 ? true : userDisplayName(user).toLowerCase().includes(needle),
      )
      .sort((a, b) => userDisplayName(a).localeCompare(userDisplayName(b)));
  }, [users, ownerUserId, memberUserIds, search, resolveUser]);

  return (
    <div className="flex max-h-80 flex-col">
      <div className="sticky top-0 z-10 border-b border-border bg-popover p-2">
        <div className="relative">
          <SearchIcon className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search people…"
            className="h-7 pl-7 text-xs"
          />
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-1">
        {rows.length === 0 ? (
          <p className="px-2 py-3 text-center text-xs text-muted-foreground">No people found.</p>
        ) : (
          rows.map((user) => {
            const isOwner = ownerUserId === user.id;
            const isMember = memberSet.has(user.id);
            const isPending = pendingUserIds.has(user.id);
            const checked = isOwner || isMember;
            return (
              <label
                key={user.id}
                className={cn(
                  "flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-accent",
                  (isOwner || isPending) && "cursor-default opacity-80 hover:bg-transparent",
                )}
              >
                <Checkbox
                  checked={checked}
                  disabled={isOwner || isPending}
                  onCheckedChange={(next) => onToggle(user.id, next === true)}
                />
                <Avatar user={user} size="sm" />
                <span className="min-w-0 flex-1 truncate">{userDisplayName(user)}</span>
                {isOwner ? (
                  <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                    Owner
                  </span>
                ) : canTransferOwnership && onTransferOwnership ? (
                  <button
                    type="button"
                    disabled={isPending}
                    className="rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground disabled:pointer-events-none"
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      onTransferOwnership(user.id);
                    }}
                  >
                    Make owner
                  </button>
                ) : null}
              </label>
            );
          })
        )}
      </div>
    </div>
  );
}
