export {
  // T3-CUSTOM(expbkt3): BEGIN — Clerk-backed managed auth surface.
  bindPrimaryEnvironmentClerkIdentity,
  // T3-CUSTOM(expbkt3): END
  // T3-CUSTOM(expbkt3): the member-devices section mints pairing links.
  createServerPairingCredential,
  // T3-CUSTOM(expbkt3): fetchSessionState feeds the fork's managed offline gate.
  fetchSessionState,
  // T3-CUSTOM(expbkt3): the /pair route prefers a pending pairing link over the Clerk gate.
  isExplicitPairingRequested,
  // T3-CUSTOM(expbkt3): BEGIN — member-devices settings section.
  listServerClientSessions,
  listServerPairingLinks,
  // T3-CUSTOM(expbkt3): END
  // T3-CUSTOM(expbkt3): Expose current-session logout to the web account control.
  logoutPrimaryEnvironment,
  peekPairingTokenFromUrl,
  PrimaryEnvironmentPairingCredentialRejectedError,
  PrimaryEnvironmentRequestError,
  // T3-CUSTOM(expbkt3): BEGIN — Clerk membership failure surfaced by the sign-in gate.
  PrimaryEnvironmentClerkNotMemberError,
  // T3-CUSTOM(expbkt3): END
  resolveInitialServerAuthGateState,
  // T3-CUSTOM(expbkt3): BEGIN — member-devices settings section revokes sessions and links.
  revokeServerClientSession,
  revokeServerPairingLink,
  // T3-CUSTOM(expbkt3): END
  stripPairingTokenFromUrl,
  // T3-CUSTOM(expbkt3): Clerk session token exchange.
  submitClerkSessionToken,
  submitServerAuthCredential,
  takePairingTokenFromUrl,
  type ServerClientSessionRecord,
  type ServerPairingLinkRecord,
  __resetServerAuthBootstrapForTests,
} from "./auth";

// T3-CUSTOM(expbkt3): fork runtime/pairing modules construct the client directly.
export { PrimaryEnvironmentHttpClient } from "./httpClient";

export {
  DesktopEnvironmentBootstrapIncompleteError,
  PrimaryEnvironmentProtocolUnsupportedError,
  PrimaryEnvironmentUrlInvalidError,
  readPrimaryEnvironmentTarget,
  resolvePrimaryEnvironmentHttpUrl,
  isLoopbackHostname,
  type PrimaryEnvironmentTarget,
} from "./target";
