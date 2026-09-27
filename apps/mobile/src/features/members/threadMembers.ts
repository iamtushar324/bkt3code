// T3-CUSTOM(expbkt3): pure logic for tagging users on a thread.
//
// Free of react-native and of any atom, so it is unit testable — importing the
// mobile state layer pulls in react-native, which the test bundler cannot parse.
import type { OrchestrationUser, UserId } from "@t3tools/contracts";

export interface ThreadMemberEntry {
  readonly user: OrchestrationUser;
  readonly isOwner: boolean;
  readonly isMember: boolean;
}

/** A readable label for a user, however sparse their directory record is. */
export function threadMemberLabel(user: OrchestrationUser): string {
  return user.name ?? user.email ?? user.id;
}

/** The initial for the avatar circle. */
export function threadMemberInitial(user: OrchestrationUser): string {
  return threadMemberLabel(user).trim().slice(0, 1).toUpperCase() || "?";
}

/**
 * The directory, ordered for a phone: people already on the thread first (owner
 * at the top), then everyone else alphabetically. Scrolling to find who is
 * already tagged is the common mistake this avoids.
 */
export function buildThreadMemberEntries(input: {
  readonly users: ReadonlyArray<OrchestrationUser>;
  readonly ownerUserId: UserId | null;
  readonly memberUserIds: ReadonlyArray<UserId>;
}): ReadonlyArray<ThreadMemberEntry> {
  const members = new Set<string>(input.memberUserIds);
  const entries = input.users.map((user) => ({
    user,
    isOwner: input.ownerUserId !== null && user.id === input.ownerUserId,
    isMember: members.has(user.id),
  }));

  return entries.sort((left, right) => {
    if (left.isOwner !== right.isOwner) return left.isOwner ? -1 : 1;
    if (left.isMember !== right.isMember) return left.isMember ? -1 : 1;
    return threadMemberLabel(left.user).localeCompare(threadMemberLabel(right.user));
  });
}

/**
 * Filters the directory by a query over name and email.
 *
 * An empty query keeps everyone; matching is case-insensitive and substring, so
 * a partial surname or an email prefix both work.
 */
export function filterThreadMemberEntries(
  entries: ReadonlyArray<ThreadMemberEntry>,
  query: string,
): ReadonlyArray<ThreadMemberEntry> {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return entries;
  return entries.filter((entry) => {
    const name = entry.user.name?.toLowerCase() ?? "";
    const email = entry.user.email?.toLowerCase() ?? "";
    return name.includes(needle) || email.includes(needle);
  });
}

/**
 * Whether removing this member is allowed.
 *
 * The owner cannot be removed as a member — ownership transfer is the operation
 * for that, and offering a remove that always fails is worse than not offering it.
 */
export function canRemoveThreadMember(entry: ThreadMemberEntry): boolean {
  return entry.isMember && !entry.isOwner;
}
