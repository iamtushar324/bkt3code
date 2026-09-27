/**
 * ThreadMembersControl - avatar-stack trigger + member picker for a thread.
 *
 * Mounted in the chat header (team mode only — renders null otherwise). Reads
 * its own atoms; no prop threading from ChatView. Shows the owner + tagged
 * members as an avatar stack; clicking opens a picker to tag/untag people or
 * transfer ownership. Project-level access is managed separately by admins in
 * Settings. Self-removal asks for confirmation and navigates home.
 *
 * @module components/members/ThreadMembersControl
 */
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, OrchestrationUser, ThreadId, UserId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { UsersIcon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { useThreadShell } from "../../state/entities";
import { useCurrentUserId } from "../../state/identity";
// T3-CUSTOM(expbkt3): tagging is scoped to the thread's own environment.
import {
  shouldRenderMemberSurface,
  useEnvironmentSupportsTeam,
} from "../../fork/environmentTeamCapability";
import { useIsTeamAdmin, useOrgMembers } from "../../state/orgMembers";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { AvatarStack } from "../ui/avatar";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { MemberPicker } from "./MemberPicker";

export function ThreadMembersControl({
  environmentId,
  threadId,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const currentUserId = useCurrentUserId();
  // T3-CUSTOM(expbkt3): whether *this thread's* environment can store members.
  const supportsTeam = useEnvironmentSupportsTeam(environmentId);
  const threadRef = scopeThreadRef(environmentId, threadId);
  const thread = useThreadShell(threadRef);
  const { users, resolveUser } = useOrgMembers();
  const isAdmin = useIsTeamAdmin();
  const navigate = useNavigate();
  const addMember = useAtomCommand(threadEnvironment.addMember, { reportFailure: false });
  const removeMember = useAtomCommand(threadEnvironment.removeMember, { reportFailure: false });
  const transferOwnership = useAtomCommand(threadEnvironment.transferOwnership);
  const [pending, setPending] = useState<ReadonlySet<UserId>>(() => new Set());

  const settlePending = useCallback((userId: UserId) => {
    setPending((prev) => {
      const next = new Set(prev);
      next.delete(userId);
      return next;
    });
  }, []);

  const onToggle = useCallback(
    (userId: UserId, nextChecked: boolean) => {
      // Self-removal: confirm, then leave and navigate home.
      if (!nextChecked && userId === currentUserId) {
        const confirmed = window.confirm(
          "Remove yourself from this thread? You will lose access to it.",
        );
        if (!confirmed) return;
        setPending((prev) => new Set(prev).add(userId));
        void removeMember({ environmentId, input: { threadId, userId } })
          .then(() => navigate({ to: "/", replace: true }))
          .finally(() => settlePending(userId));
        return;
      }
      setPending((prev) => new Set(prev).add(userId));
      const run = nextChecked
        ? addMember({ environmentId, input: { threadId, userId } })
        : removeMember({ environmentId, input: { threadId, userId } });
      void run.finally(() => settlePending(userId));
    },
    [addMember, removeMember, environmentId, threadId, currentUserId, navigate, settlePending],
  );

  const stackUsers = useMemo<ReadonlyArray<OrchestrationUser>>(() => {
    if (!thread) return [];
    const ids: UserId[] = [];
    if (thread.ownerUserId !== null) ids.push(thread.ownerUserId);
    for (const id of thread.memberUserIds) if (!ids.includes(id)) ids.push(id);
    return ids.map((id) => resolveUser(id));
  }, [thread, resolveUser]);
  const canTransferOwnership =
    isAdmin ||
    thread?.ownerUserId === currentUserId ||
    (thread?.ownerUserId === null &&
      currentUserId !== null &&
      thread.memberUserIds.includes(currentUserId));
  const onTransferOwnership = useCallback(
    (userId: UserId) => {
      const user = resolveUser(userId);
      const label = user.name ?? user.email ?? user.id;
      const confirmed = window.confirm(
        `Transfer thread ownership to ${label}?${
          thread?.ownerUserId === null ? "" : " The previous owner will remain a member."
        } The provider session and terminals will restart, and future GitHub activity will use the new owner's profile.`,
      );
      if (!confirmed) return;
      setPending((prev) => new Set(prev).add(userId));
      void transferOwnership({ environmentId, input: { threadId, userId } }).finally(() =>
        settlePending(userId),
      );
    },
    [environmentId, resolveUser, settlePending, thread?.ownerUserId, threadId, transferOwnership],
  );

  // Team mode only.
  // T3-CUSTOM(expbkt3): ...and only where *this* environment is the team one. A
  // managed desktop can be signed into a central server while a single-user local
  // backend is also connected; without this the picker rendered on the local
  // backend's threads and wrote user ids it has never heard of.
  if (!shouldRenderMemberSurface({ currentUserId, environmentSupportsTeam: supportsTeam })) {
    return null;
  }
  if (thread === null) {
    return null;
  }

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button variant="ghost" size="sm" className="h-8 gap-1.5 px-2" aria-label="Members" />
        }
      >
        {stackUsers.length > 0 ? (
          <AvatarStack users={stackUsers} size="sm" />
        ) : (
          <UsersIcon className="size-4" />
        )}
      </PopoverTrigger>
      <PopoverPopup align="end" className="w-72" padding="none">
        <MemberPicker
          users={users}
          ownerUserId={thread.ownerUserId}
          memberUserIds={thread.memberUserIds}
          pendingUserIds={pending}
          onToggle={onToggle}
          canTransferOwnership={canTransferOwnership}
          onTransferOwnership={onTransferOwnership}
          resolveUser={resolveUser}
        />
      </PopoverPopup>
    </Popover>
  );
}
