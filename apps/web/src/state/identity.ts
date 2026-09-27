/**
 * identity - Current operator identity (team mode).
 *
 * `TeamIdentityBridge` mirrors the signed-in Clerk user into `currentClerkUserAtom`.
 * `useCurrentUserId()` returns that user id, or `null` outside team mode (no
 * ClerkProvider mounted / signed out) — the value UI uses to decide whether to
 * render team-only affordances (tagging controls, "Assigned to me").
 *
 * @module state/identity
 */
import type { UserId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/unstable/reactivity";

import { appAtomRegistry } from "~/rpc/atomRegistry";
// T3-CUSTOM(expbkt3): identity for clients that pair instead of signing in.
import { useEnvironmentOperatorUserId } from "~/fork/environmentOperatorIdentity";

export const currentClerkUserAtom = Atom.make<UserId | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("clerk:current-user-id"),
);

export function setCurrentClerkUser(userId: UserId | null): void {
  appAtomRegistry.set(currentClerkUserAtom, userId);
}

/** The current operator's Clerk user id, or null outside team mode. */
export function useCurrentUserId(): UserId | null {
  // T3-CUSTOM(expbkt3): a paired client (the BK desktop) mounts no ClerkProvider,
  // so fall back to the operator the environment session reports. Clerk still
  // wins wherever it is mounted and signed in, leaving browser and upstream
  // builds byte-identical in behaviour.
  const clerkUserId = useAtomValue(currentClerkUserAtom);
  const environmentUserId = useEnvironmentOperatorUserId();
  return clerkUserId ?? environmentUserId;
}
