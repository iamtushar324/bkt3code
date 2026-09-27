/**
 * ProjectMembersDialog - manage members of a project (team mode).
 *
 * A project tag grants workspace access, and an owner/admin can transfer
 * ownership. Renders null outside team mode.
 *
 * @module components/members/ProjectMembersDialog
 */
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ProjectId, UserId } from "@t3tools/contracts";
import { useCallback, useState } from "react";

import { useProject } from "../../state/entities";
import { useCurrentUserId } from "../../state/identity";
// T3-CUSTOM(expbkt3): project access is scoped to the project's own environment.
import {
  shouldRenderMemberSurface,
  useEnvironmentSupportsTeam,
} from "../../fork/environmentTeamCapability";
import { useIsTeamAdmin, useOrgMembers } from "../../state/orgMembers";
import { projectEnvironment } from "../../state/projects";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { MemberPicker } from "./MemberPicker";

export function ProjectMembersDialog({
  environmentId,
  projectId,
  open,
  onOpenChange,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const currentUserId = useCurrentUserId();
  // T3-CUSTOM(expbkt3): whether *this project's* environment can store members.
  const supportsTeam = useEnvironmentSupportsTeam(environmentId);
  const project = useProject(scopeProjectRef(environmentId, projectId));
  const { users, resolveUser } = useOrgMembers();
  const isAdmin = useIsTeamAdmin();
  const addMember = useAtomCommand(projectEnvironment.addMember, { reportFailure: false });
  const removeMember = useAtomCommand(projectEnvironment.removeMember, { reportFailure: false });
  const transferOwnership = useAtomCommand(projectEnvironment.transferOwnership);
  const [pending, setPending] = useState<ReadonlySet<UserId>>(() => new Set());

  const onToggle = useCallback(
    (userId: UserId, nextChecked: boolean) => {
      setPending((prev) => new Set(prev).add(userId));
      const run = nextChecked
        ? addMember({ environmentId, input: { projectId, userId } })
        : removeMember({ environmentId, input: { projectId, userId } });
      void run.finally(() => {
        setPending((prev) => {
          const next = new Set(prev);
          next.delete(userId);
          return next;
        });
      });
    },
    [addMember, removeMember, environmentId, projectId],
  );
  const canTransferOwnership =
    isAdmin ||
    project?.ownerUserId === currentUserId ||
    (project?.ownerUserId === null &&
      currentUserId !== null &&
      project.memberUserIds.includes(currentUserId));
  const onTransferOwnership = useCallback(
    (userId: UserId) => {
      const user = resolveUser(userId);
      const label = user.name ?? user.email ?? user.id;
      const confirmed = window.confirm(
        `Transfer project ownership to ${label}?${
          project?.ownerUserId === null ? "" : " The previous owner will remain a member."
        }`,
      );
      if (!confirmed) return;
      setPending((prev) => new Set(prev).add(userId));
      void transferOwnership({ environmentId, input: { projectId, userId } }).finally(() => {
        setPending((prev) => {
          const next = new Set(prev);
          next.delete(userId);
          return next;
        });
      });
    },
    [environmentId, project?.ownerUserId, projectId, resolveUser, transferOwnership],
  );

  // T3-CUSTOM(expbkt3): the environment gate joins the identity gate; see
  // fork/environmentTeamCapability.ts.
  if (!shouldRenderMemberSurface({ currentUserId, environmentSupportsTeam: supportsTeam })) {
    return null;
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Project members</DialogTitle>
          <DialogDescription>
            Members can access this project and create threads. Existing threads are shared
            separately.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="p-0">
          <MemberPicker
            users={users}
            ownerUserId={project?.ownerUserId ?? null}
            memberUserIds={project?.memberUserIds ?? []}
            pendingUserIds={pending}
            onToggle={onToggle}
            canTransferOwnership={canTransferOwnership}
            onTransferOwnership={onTransferOwnership}
            resolveUser={resolveUser}
          />
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
