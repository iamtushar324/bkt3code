/**
 * T3-CUSTOM(expbkt3): PhaseSidebarOwnerAvatar - whose session this row is.
 *
 * In a shared environment the sidebar mixes my own sessions with ones teammates
 * started and pulled me into, and until now the two were indistinguishable. This
 * puts the owner's face immediately left of the provider icon, but *only* on the
 * rows where it says something: threads owned by someone other than the current
 * operator. See `phaseSidebarRowOwnerAvatarUserId` for that decision — render
 * this component only when it returns a user id, so rows that need no avatar do
 * not subscribe to the org directory at all.
 *
 * @module components/sidebar/PhaseSidebarOwnerAvatar
 */
import type { OrchestrationUser, UserId } from "@t3tools/contracts";

import { useOrgMembers } from "../../state/orgMembers";
import { Avatar, userDisplayName } from "../ui/avatar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/**
 * Presentation only, so it can be asserted without the org-directory atom.
 * Sized to the 3.5 lane the priority badge and provider icon already share.
 */
export function PhaseSidebarOwnerAvatarView({
  owner,
  threadId,
}: {
  readonly owner: Pick<OrchestrationUser, "id" | "name" | "email" | "imageUrl">;
  readonly threadId: string;
}) {
  const label = `Started by ${userDisplayName(owner)}`;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            aria-label={label}
            className="inline-flex size-3.5 shrink-0 items-center justify-center"
            data-testid={`phase-thread-owner-${threadId}`}
            role="img"
          />
        }
      >
        <Avatar user={owner} size="xs" className="size-3.5 text-[7px] ring-border/70" />
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}

export function PhaseSidebarOwnerAvatar({
  ownerUserId,
  threadId,
}: {
  readonly ownerUserId: UserId;
  readonly threadId: string;
}) {
  // `resolveUser` returns a minimal record for a departed or not-yet-loaded
  // user, so the row still shows initials rather than a hole.
  const { resolveUser } = useOrgMembers();
  return <PhaseSidebarOwnerAvatarView owner={resolveUser(ownerUserId)} threadId={threadId} />;
}
