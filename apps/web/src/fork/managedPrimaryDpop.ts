/**
 * T3-CUSTOM(expbkt3): the device key a managed BK build proves possession of.
 *
 * A pairing credential minted for a managed desktop can only be redeemed with a
 * DPoP proof, and the access token it yields is bound to the key that signed
 * that proof. Every later request has to carry a fresh proof over the same key.
 *
 * This deliberately reuses `cloud/dpop.ts` rather than adding a second key
 * mechanism. That module already generates a P-256 keypair, re-imports the
 * private half as a **non-extractable** `CryptoKey`, and stores it in
 * IndexedDB — so the private key cannot be read back out by any script,
 * including ours. That is a stronger guarantee than encrypting exportable key
 * material at rest (Electron `safeStorage` and friends), which is why the
 * renderer keeps the key rather than the main process.
 *
 * It is the same stored record the relay signer uses. A managed BK build has no
 * relay, so nothing else touches it; loading goes through the single promise
 * below so two callers can never race and generate competing keys.
 *
 * @module fork/managedPrimaryDpop
 */
import { DpopProof } from "@t3tools/client-runtime/relay";
import { computeDpopJwkThumbprint } from "@t3tools/shared/dpop";
import * as Effect from "effect/Effect";

import { layer as browserCryptoLayer, loadOrCreateProofKey } from "../cloud/dpop";

export interface ManagedPrimaryDpopKey {
  readonly proofKey: DpopProof.DpopProofKey;
  readonly thumbprint: string;
}

let keyPromise: Promise<ManagedPrimaryDpopKey | null> | null = null;

const loadOrCreateKey = loadOrCreateProofKey().pipe(
  Effect.map((proofKey) => ({
    proofKey,
    thumbprint: computeDpopJwkThumbprint(proofKey.publicJwk),
  })),
);

/**
 * The device key, or `null` where it cannot be created (no WebCrypto, no
 * IndexedDB). Callers treat `null` as "cannot pair here" rather than throwing:
 * the pairing gate has a message for it, a crash has nothing.
 */
export function loadManagedPrimaryDpopKey(): Promise<ManagedPrimaryDpopKey | null> {
  keyPromise ??= Effect.runPromise(
    loadOrCreateKey.pipe(
      Effect.provide(browserCryptoLayer),
      Effect.catchCause(() => Effect.succeed(null)),
    ),
  );
  return keyPromise;
}

/** Thumbprint of the device key, for diagnostics and stored-token validation. */
export async function readManagedPrimaryDpopThumbprint(): Promise<string | null> {
  return (await loadManagedPrimaryDpopKey())?.thumbprint ?? null;
}

/**
 * A proof for one request. `accessToken` binds the proof to the token being
 * presented (`ath`), which is what stops a captured proof being replayed
 * against a different token.
 */
export async function createManagedPrimaryDpopProof(input: {
  readonly method: string;
  readonly url: string;
  readonly accessToken?: string;
}): Promise<string | null> {
  const loaded = await loadManagedPrimaryDpopKey();
  if (loaded === null) {
    return null;
  }
  return Effect.runPromise(
    DpopProof.createProof({
      method: input.method,
      url: input.url,
      ...(input.accessToken ? { accessToken: input.accessToken } : {}),
      key: loaded.proofKey,
    }).pipe(
      Effect.provide(browserCryptoLayer),
      Effect.catchCause(() => Effect.succeed(null)),
    ),
  );
}

export function __resetManagedPrimaryDpopForTests(): void {
  keyPromise = null;
}
