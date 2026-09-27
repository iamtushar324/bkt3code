/**
 * T3-CUSTOM(expbkt3): members pair their own devices.
 *
 * Upstream gates the whole pairing surface behind `access:write`, which
 * `AuthStandardClientScopes` omits. On a team-mode server that means an ordinary
 * member — and a Clerk org admin whose session carries only standard scopes —
 * cannot generate a credential for their own laptop or phone, so pairing needs
 * an environment administrator every time.
 *
 * This module adds one narrow capability and nothing else: **a session that
 * carries a Clerk-derived identity may mint a pairing credential for itself.**
 * No new scope is introduced, and `access:write` keeps gating everything
 * environment-wide — anonymous links, listing other people's sessions, revoking
 * them. The self-service path is deliberately not widened for Clerk org admins:
 * whether someone is an org admin is irrelevant here, only whether their session
 * carries `access:write` (the existing administrative path) or an identity (this
 * one).
 *
 * What keeps it safe:
 *
 * - the subject is derived from the session, never from the payload, so a
 *   credential can only ever act as its creator (see `OperatorIdentity.ts`);
 * - scopes are the caller's own, intersected with the standard client set, so a
 *   self-issued credential can never carry `access:*` or `relay:write` even if
 *   the caller somehow holds them;
 * - a member may hold only {@link SELF_SERVICE_PAIRING_LIMIT} pairings at once,
 *   counting both pending credentials and the device sessions they became, so a
 *   leaked member session cannot quietly accumulate durable access;
 * - the sessions it produces do not expire (see {@link PAIRED_SESSION_TTL}); a
 *   device stays paired until it is revoked.
 *
 * @module auth/SelfServicePairing
 */
import type {
  AuthClientSession,
  AuthEnvironmentScope,
  AuthPairingLink,
  UserId,
} from "@t3tools/contracts";
import { AuthStandardClientScopes, clerkSubjectForUser } from "@t3tools/contracts";
import * as Duration from "effect/Duration";

import type * as PairingGrantStore from "./PairingGrantStore.ts";
import { operatorUserIdForPrincipal, type OperatorPrincipal } from "./OperatorIdentity.ts";

/**
 * How many pairings one member may hold at once, counting pending credentials
 * and the device sessions they became together. Five covers a laptop, a desktop,
 * a phone, a tablet and one in flight; past that, revoking is the right move.
 */
export const SELF_SERVICE_PAIRING_LIMIT = 5;

/**
 * Life of every session redeemed from a pairing credential: effectively forever.
 *
 * Nothing renews a session — its expiry is signed into the token, and desktop and
 * mobile store the `expires_in` they were handed and drop the credential at that
 * moment — so any finite lifetime is a hard cut on a device in daily use. The old
 * seven-day self-issued lifetime made every paired desktop and phone re-pair
 * weekly, surfacing as "credentials are invalid" on the next reconnect. A paired
 * device now stays paired until it is revoked in Settings → Connections.
 *
 * A century rather than an unbounded duration because the expiry is still a
 * concrete epoch in the token, the cookie and the client's stored deadline.
 */
export const PAIRED_SESSION_TTL = Duration.days(36_500);

/**
 * Scopes a self-issued credential may carry: the caller's own, narrowed to the
 * standard client set. `access:read`, `access:write` and `relay:write` are
 * absent from that set, so they can never be delegated this way.
 */
export function selfServicePairingScopes(
  sessionScopes: ReadonlySet<AuthEnvironmentScope>,
): ReadonlyArray<AuthEnvironmentScope> {
  return AuthStandardClientScopes.filter((scope) => sessionScopes.has(scope));
}

/** Whether every requested scope is one this caller may self-delegate. */
export function isSelfServiceScopeAllowed(
  requested: ReadonlyArray<AuthEnvironmentScope>,
  sessionScopes: ReadonlySet<AuthEnvironmentScope>,
): boolean {
  const allowed = new Set(selfServicePairingScopes(sessionScopes));
  return requested.every((scope) => allowed.has(scope));
}

/**
 * The pairings that count against a member's cap: their pending credentials plus
 * the device sessions those credentials became.
 *
 * Cookie sessions are deliberately excluded. On a team-mode server a member's
 * browser session comes from signing in with Clerk, not from a pairing, and
 * counting those would exhaust the cap just by opening the app in a few
 * browsers. Only bearer and DPoP sessions are reachable through a pairing
 * exchange, which is exactly the "device" the cap is about.
 */
export function countSelfServicePairings(input: {
  readonly userId: UserId;
  readonly pairingLinks: ReadonlyArray<AuthPairingLink>;
  readonly clientSessions: ReadonlyArray<AuthClientSession>;
}): number {
  const subject = clerkSubjectForUser(input.userId);
  const pending = input.pairingLinks.filter((link) => link.subject === subject).length;
  const devices = input.clientSessions.filter(
    (session) => session.subject === subject && session.method !== "browser-session-cookie",
  ).length;
  return pending + devices;
}

/** Whether this member may mint one more pairing right now. */
export function canIssueSelfServicePairing(input: {
  readonly userId: UserId;
  readonly pairingLinks: ReadonlyArray<AuthPairingLink>;
  readonly clientSessions: ReadonlyArray<AuthClientSession>;
}): boolean {
  return countSelfServicePairings(input) < SELF_SERVICE_PAIRING_LIMIT;
}

/**
 * The `ttl` field to spread into a session issued from a pairing grant: the same
 * for a member's own pairing and an administrator-minted one.
 *
 * Spread-shaped so the upstream `sessions.issue` calls keep their formatting,
 * and so it can sit after the DPoP branch and override its one-hour default.
 */
export function pairedSessionTtlFields(
  _grant: Pick<PairingGrantStore.BootstrapGrant, "selfIssued">,
): { readonly ttl: Duration.Duration } {
  return { ttl: PAIRED_SESSION_TTL };
}

/** The caller's own pairing links, for the member "Your devices" view. */
export function ownPairingLinks(
  pairingLinks: ReadonlyArray<AuthPairingLink>,
  principal: OperatorPrincipal,
): ReadonlyArray<AuthPairingLink> {
  const userId = operatorUserIdForPrincipal(principal);
  if (userId === null) {
    return [];
  }
  const subject = clerkSubjectForUser(userId);
  return pairingLinks.filter((link) => link.subject === subject);
}

/** The caller's own client sessions, for the member "Your devices" view. */
export function ownClientSessions(
  clientSessions: ReadonlyArray<AuthClientSession>,
  principal: OperatorPrincipal,
): ReadonlyArray<AuthClientSession> {
  const userId = operatorUserIdForPrincipal(principal);
  if (userId === null) {
    return [];
  }
  const subject = clerkSubjectForUser(userId);
  return clientSessions.filter((session) => session.subject === subject);
}
