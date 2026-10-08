/**
 * T3-CUSTOM(expbkt3): which surface the /pair route shows.
 *
 * An explicit pairing link (`/pair#token=…`, or one whose token was already
 * stripped while its redemption is pending) always goes to upstream's pairing
 * surface, which redeems it. The Clerk sign-in gate is only for team mode
 * without a link; otherwise a browser that already holds a Clerk session would
 * sign in as that user and silently ignore the link.
 */
export type PairRouteSurface = "pairing" | "clerk";

export function resolvePairRouteSurface(input: {
  readonly teamMode: boolean;
  readonly hasPairingToken: boolean;
  readonly explicitPairingRequested: boolean;
}): PairRouteSurface {
  if (input.hasPairingToken || input.explicitPairingRequested) return "pairing";
  return input.teamMode ? "clerk" : "pairing";
}
