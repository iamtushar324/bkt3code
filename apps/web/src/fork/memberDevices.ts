/**
 * T3-CUSTOM(expbkt3): the data behind a member's "Your devices" list.
 *
 * Kept apart from the React surface so the rules are testable without a DOM.
 *
 * The admin "Authorized clients" panel reads its data over the
 * `subscribeAuthAccess` RPC, which requires `access:read` and streams the whole
 * environment. A member has neither the scope nor any business seeing other
 * people's sessions, so this view uses the plain HTTP endpoints instead — the
 * server already narrows those to the caller's own records. That keeps `ws.ts`
 * and the RPC scope map completely out of this change.
 *
 * @module fork/memberDevices
 */
import type { AuthEnvironmentScope } from "@t3tools/contracts";
import { AuthAccessWriteScope } from "@t3tools/contracts";

import type {
  ServerClientSessionRecord,
  ServerPairingLinkRecord,
} from "../environments/primary/auth";

/**
 * Whether to show a member the self-service view.
 *
 * An `access:write` holder keeps the full administrative panel; a session with
 * no identity at all (a plain bootstrap client, a single-user local server) sees
 * neither, exactly as today.
 */
export function shouldShowMemberDevices(input: {
  readonly scopes: ReadonlyArray<AuthEnvironmentScope> | null;
  readonly userId: string | null;
}): boolean {
  if (input.userId === null || input.scopes === null) {
    return false;
  }
  return !input.scopes.includes(AuthAccessWriteScope);
}

/** A pending credential the member has not yet redeemed. */
export interface MemberPendingPairing {
  readonly id: string;
  readonly label: string | null;
  readonly expiresAt: string;
}

/** A device the member has paired. */
export interface MemberDeviceSession {
  readonly sessionId: ServerClientSessionRecord["sessionId"];
  readonly label: string | null;
  readonly deviceBound: boolean;
  readonly current: boolean;
  readonly lastConnectedAt: string | null;
}

export function toMemberPendingPairings(
  pairingLinks: ReadonlyArray<ServerPairingLinkRecord>,
): ReadonlyArray<MemberPendingPairing> {
  return pairingLinks
    .map((pairingLink) => ({
      id: pairingLink.id,
      label: pairingLink.label ?? null,
      expiresAt: pairingLink.expiresAt,
    }))
    .toSorted((left, right) => left.expiresAt.localeCompare(right.expiresAt));
}

/**
 * Browser sessions are excluded: on a team-mode server those come from signing
 * in with Clerk, not from pairing a device, and listing a member's own browser
 * tabs as "devices" they should revoke is misleading. It also matches what the
 * server counts against their pairing cap.
 */
export function toMemberDeviceSessions(
  clientSessions: ReadonlyArray<ServerClientSessionRecord>,
): ReadonlyArray<MemberDeviceSession> {
  return clientSessions
    .filter((clientSession) => clientSession.method !== "browser-session-cookie")
    .map((clientSession) => ({
      sessionId: clientSession.sessionId,
      label: clientSession.client.label ?? null,
      deviceBound: clientSession.method === "dpop-access-token",
      current: clientSession.current,
      lastConnectedAt: clientSession.lastConnectedAt,
    }));
}

/** Message for the 403 the server returns once a member is at their cap. */
export const MEMBER_PAIRING_LIMIT_MESSAGE =
  "You have reached the limit of paired devices. Revoke one below, then try again.";

export function memberPairingErrorMessage(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "reason" in error &&
    (error as { readonly reason?: unknown }).reason === "self_pairing_limit_reached"
  ) {
    return MEMBER_PAIRING_LIMIT_MESSAGE;
  }
  return error instanceof Error ? error.message : "Could not create a pairing code.";
}
