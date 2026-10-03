// T3-CUSTOM(expbkt3): identify other people on a shared conversation.
import type { UserId } from "@t3tools/contracts";
import { useCurrentUserId } from "../state/identity";
import { useOrgMembers } from "../state/orgMembers";
export function MessageSenderAttribution({ userId }: { readonly userId: UserId | null }) {
  const currentUserId = useCurrentUserId();
  const { resolveUser } = useOrgMembers();
  if (userId === null || userId === currentUserId) return null;
  const sender = resolveUser(userId);
  return (
    <span className="text-xs text-muted-foreground">
      {sender.name ?? sender.email ?? sender.id}
    </span>
  );
}
