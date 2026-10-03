/**
 * T3-CUSTOM(expbkt3): inheritedThreadMembers - who a session is born tagged with.
 *
 * A session created from another session is somebody's follow-up work: a
 * side-by-side thread off a row in the sidebar, or an agent fanning work out of
 * the session it was asked in. The people watching the session it came from are
 * the people who need to see it, so a parented session is born tagged with its
 * parent's audience — the parent's owner plus everyone tagged there.
 *
 * Creators that know better say so: any explicit member list on the command
 * wins outright, including an empty one, which is how `t3_create_session`
 * expresses "keep this to myself". Only an omitted list falls back to the
 * parent.
 *
 * The creator is left out of the result. Ownership already implies access and
 * the projector tags the creator itself, so repeating them here would only
 * invite a duplicate row.
 *
 * @module inheritedThreadMembers
 */
import type { ThreadId, UserId } from "@t3tools/contracts";

interface TaggableThread {
  readonly id: ThreadId;
  readonly ownerUserId: UserId | null;
  readonly memberUserIds: ReadonlyArray<UserId>;
}

export function resolveCreatedThreadMemberUserIds(input: {
  readonly threads: ReadonlyArray<TaggableThread>;
  readonly parentThreadId: ThreadId | null | undefined;
  readonly createdByUserId: UserId | null;
  readonly explicitMemberUserIds: ReadonlyArray<UserId> | undefined;
}): ReadonlyArray<UserId> {
  const parentThreadId = input.parentThreadId ?? null;
  const parent =
    input.explicitMemberUserIds === undefined && parentThreadId !== null
      ? input.threads.find((candidate) => candidate.id === parentThreadId)
      : undefined;
  const candidates =
    input.explicitMemberUserIds ??
    (parent === undefined
      ? []
      : [...(parent.ownerUserId === null ? [] : [parent.ownerUserId]), ...parent.memberUserIds]);
  return Array.from(new Set(candidates)).filter((userId) => userId !== input.createdByUserId);
}
