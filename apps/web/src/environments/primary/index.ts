export {
  getPrimaryKnownEnvironment,
  resetPrimaryEnvironmentDescriptorForTests,
  resolveInitialPrimaryEnvironmentDescriptor,
  writePrimaryEnvironmentDescriptor,
} from "./context";

export {
  // T3-CUSTOM(expbkt3): BEGIN — Clerk-backed managed auth surface.
  bindPrimaryEnvironmentClerkIdentity,
  // T3-CUSTOM(expbkt3): END
  createServerPairingCredential,
  // T3-CUSTOM(expbkt3): fetchSessionState feeds the fork's managed offline gate.
  fetchSessionState,
  isPrimaryEnvironmentPairingCredentialRejectedError,
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
  revokeOtherServerClientSessions,
  revokeServerClientSession,
  revokeServerPairingLink,
  stripPairingTokenFromUrl,
  // T3-CUSTOM(expbkt3): Clerk session token exchange.
  submitClerkSessionToken,
  submitServerAuthCredential,
  takePairingTokenFromUrl,
  type ServerClientSessionRecord,
  type ServerPairingLinkRecord,
  __resetServerAuthBootstrapForTests,
} from "./auth";

export { usePrimarySessionState } from "./sessionState";

// T3-CUSTOM(expbkt3): fork runtime/pairing modules construct the client directly.
export { PrimaryEnvironmentHttpClient } from "./httpClient";

export {
  DesktopEnvironmentBootstrapIncompleteError,
  isDesktopEnvironmentBootstrapIncompleteError,
  isPrimaryEnvironmentProtocolUnsupportedError,
  isPrimaryEnvironmentUrlInvalidError,
  PrimaryEnvironmentProtocolUnsupportedError,
  PrimaryEnvironmentUrlInvalidError,
  readPrimaryEnvironmentTarget,
  resolvePrimaryEnvironmentHttpUrl,
  isLoopbackHostname,
  type PrimaryEnvironmentTarget,
} from "./target";
