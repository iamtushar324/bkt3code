/**
 * T3-CUSTOM(expbkt3): operator identity for clients with no Clerk provider.
 *
 * Upstream resolves "who am I" from Clerk alone: `TeamIdentityBridge` mirrors
 * the signed-in user into `state/identity`'s atom, and every team-mode
 * affordance (member tagging, "Assigned to me", admin checks) reads it. The BK
 * desktop mounts no ClerkProvider — it pairs with the central server using a
 * pairing credential — so that atom is permanently null and the tagging UI
 * never renders.
 *
 * The server now reports the acting operator on `/api/auth/session` (see
 * `apps/server/src/auth/OperatorIdentity.ts`), which is the same derivation
 * authorization uses. This module turns that into the identity the UI reads,
 * behind `state/identity`'s single fork seam — nothing else changes, and Clerk
 * still wins wherever it is mounted and signed in.
 *
 * Known rough edge: identity is one global atom, not per-environment. On a
 * thread hosted by a *different* environment than the primary one, the control
 * still renders using this operator id and the primary environment's member
 * list. Accepted deliberately; fixing it means threading an environment id
 * through every `useCurrentUserId()` call site.
 *
 * @module fork/environmentOperatorIdentity
 */
import type { AuthSessionState, UserId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { operatorUserIdFromSessionState } from "@t3tools/client-runtime/state/session";

import { fetchSessionState } from "../environments/primary/auth";

/**
 * The operator id carried by an environment session, or `null` when the session
 * has none — an unauthenticated gate state, or a single-user/local environment
 * where the subject is not a Clerk operator.
 */
export { operatorUserIdFromSessionState };

/**
 * Deliberately its own atom rather than a re-export of the primary session
 * atom: that one lives in an upstream-owned module, and one extra cached GET is
 * cheaper to carry across merges than an exported internal.
 */
const environmentOperatorSessionAtom = Atom.make(Effect.promise(fetchSessionState)).pipe(
  Atom.swr({ staleTime: 60_000, revalidateOnMount: true }),
  Atom.keepAlive,
  Atom.withLabel("expbkt3:environment-operator-identity"),
);

/** The operator id the primary environment session reports, or null. */
export function useEnvironmentOperatorUserId(): UserId | null {
  const result = useAtomValue(environmentOperatorSessionAtom);
  return operatorUserIdFromSessionState(Option.getOrNull(AsyncResult.value(result)));
}
