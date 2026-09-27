/**
 * orgMembers - Clerk org directory for the tagging UI (team mode).
 *
 * A keep-alive atom fetching `GET /api/orchestration/users`. `useOrgMembers()`
 * exposes the member list plus `resolveUser(id)` which falls back to a minimal
 * record for a departed/unknown user id so avatar lists never break. Only used
 * from team-mode UI (single-user builds serve an empty list).
 *
 * @module state/orgMembers
 */
import type { OrchestrationUser, UserId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback, useMemo } from "react";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { PrimaryEnvironmentHttpClient } from "../environments/primary";
import { runPrimaryHttp } from "../lib/runtime";
import { useCurrentUserId } from "./identity";

async function fetchOrgMembers(): Promise<ReadonlyArray<OrchestrationUser>> {
  const result = await runPrimaryHttp(
    PrimaryEnvironmentHttpClient.pipe(
      Effect.flatMap((client) => client.orchestration.users({ headers: {} })),
    ),
  );
  return result.users;
}

const orgMembersAtom = Atom.make(Effect.promise(fetchOrgMembers)).pipe(
  Atom.swr({ staleTime: 60_000, revalidateOnMount: true }),
  Atom.keepAlive,
  Atom.withLabel("orchestration:org-members"),
);

export function refreshOrgMembers(): void {
  appAtomRegistry.refresh(orgMembersAtom);
}

export interface UseOrgMembersResult {
  readonly users: ReadonlyArray<OrchestrationUser>;
  readonly isPending: boolean;
  readonly resolveUser: (id: UserId) => OrchestrationUser;
}

export function useOrgMembers(): UseOrgMembersResult {
  const result = useAtomValue(orgMembersAtom);
  const users = Option.getOrNull(AsyncResult.value(result)) ?? [];
  const byId = useMemo(() => new Map(users.map((user) => [user.id, user])), [users]);
  const resolveUser = useCallback(
    (id: UserId): OrchestrationUser =>
      byId.get(id) ?? { id, name: null, email: null, imageUrl: null, isAdmin: false },
    [byId],
  );
  return { users, isPending: result.waiting, resolveUser };
}

/**
 * Whether the current operator is a Clerk org admin (may manage project access).
 * False outside team mode.
 */
export function useIsTeamAdmin(): boolean {
  const currentUserId = useCurrentUserId();
  const { resolveUser } = useOrgMembers();
  if (currentUserId === null) return false;
  return resolveUser(currentUserId).isAdmin;
}
