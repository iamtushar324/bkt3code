/**
 * T3-CUSTOM(expbkt3): the bearer credential for a managed primary environment.
 *
 * An unmanaged desktop authenticates its primary environment with a token the
 * Electron main process hands over (`desktopBridge.getLocalEnvironmentBearerToken`),
 * because the primary environment *is* the bundled local backend. A managed BK
 * build points primary at the central server instead, where that token means
 * nothing, so the operator pairs once with a pairing credential and the
 * resulting access token is kept here.
 *
 * The token is bound to the base URL it was issued for, so a build switched
 * between channels — or a stale token left by an older build — is discarded
 * rather than presented to the wrong server. It is also bound to the DPoP key
 * that redeemed the pairing credential: the server pins the session to that
 * key's thumbprint, so a token kept alongside a different key is unusable and is
 * dropped rather than presented and rejected.
 *
 * Persisted in `localStorage` so a restart does not force re-pairing, with an
 * in-memory mirror so the module also works where storage is unavailable
 * (private modes, tests). Both are best-effort: losing the token costs one
 * re-pair, never correctness.
 *
 * @module fork/managedPrimaryCredential
 */
import { readBkManagedEnvironment } from "./managedEnvironment";
import { readManagedPrimaryDpopThumbprint } from "./managedPrimaryDpop";

const STORAGE_KEY = "expbkt3:managed-primary-credential";

/** Presented tokens are dropped this long before expiry, to avoid a race with the server. */
const EXPIRY_SKEW_MS = 30_000;

interface StoredManagedPrimaryCredential {
  readonly httpBaseUrl: string;
  readonly accessToken: string;
  readonly expiresAtEpochMs: number;
  /** Thumbprint of the device key the server bound this token to. */
  readonly dpopThumbprint: string;
}

let cachedCredential: StoredManagedPrimaryCredential | null = null;
let hydrated = false;

function readStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : (window.localStorage ?? null);
  } catch {
    return null;
  }
}

export function parseStoredManagedPrimaryCredential(
  raw: string | null,
): StoredManagedPrimaryCredential | null {
  if (raw === null) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const candidate = parsed as Partial<StoredManagedPrimaryCredential>;
  if (
    typeof candidate.httpBaseUrl !== "string" ||
    typeof candidate.accessToken !== "string" ||
    candidate.accessToken.length === 0 ||
    typeof candidate.expiresAtEpochMs !== "number" ||
    !Number.isFinite(candidate.expiresAtEpochMs) ||
    typeof candidate.dpopThumbprint !== "string" ||
    candidate.dpopThumbprint.length === 0
  ) {
    return null;
  }
  return {
    httpBaseUrl: candidate.httpBaseUrl,
    accessToken: candidate.accessToken,
    expiresAtEpochMs: candidate.expiresAtEpochMs,
    dpopThumbprint: candidate.dpopThumbprint,
  };
}

/** Whether a stored credential may still be presented to the managed server. */
export function isManagedPrimaryCredentialUsable(
  credential: StoredManagedPrimaryCredential | null,
  managedHttpBaseUrl: string | null,
  nowEpochMs: number,
  dpopThumbprint: string | null,
): boolean {
  if (credential === null || managedHttpBaseUrl === null || dpopThumbprint === null) {
    return false;
  }
  return (
    credential.httpBaseUrl === managedHttpBaseUrl &&
    credential.dpopThumbprint === dpopThumbprint &&
    nowEpochMs < credential.expiresAtEpochMs - EXPIRY_SKEW_MS
  );
}

function hydrate(): void {
  if (hydrated) {
    return;
  }
  hydrated = true;
  const storage = readStorage();
  if (storage === null) {
    return;
  }
  try {
    cachedCredential = parseStoredManagedPrimaryCredential(storage.getItem(STORAGE_KEY));
  } catch {
    cachedCredential = null;
  }
}

/**
 * The credential to present to the managed primary environment, or null.
 * Includes its validated expiry so shared HTTP authorization can reject stale tokens.
 *
 * Async because validity now depends on the device key: a token whose thumbprint
 * no longer matches this device is dead weight, and presenting it would just
 * produce a 401 loop instead of the pairing gate.
 */
export async function readManagedPrimaryCredential(): Promise<Pick<
  StoredManagedPrimaryCredential,
  "accessToken" | "expiresAtEpochMs"
> | null> {
  hydrate();
  const managed = readBkManagedEnvironment();
  if (managed === null) {
    return null;
  }
  const thumbprint = await readManagedPrimaryDpopThumbprint();
  if (
    !isManagedPrimaryCredentialUsable(cachedCredential, managed.httpBaseUrl, Date.now(), thumbprint)
  ) {
    return null;
  }
  return cachedCredential === null
    ? null
    : {
        accessToken: cachedCredential.accessToken,
        expiresAtEpochMs: cachedCredential.expiresAtEpochMs,
      };
}

/** The validated token for callers that do not need the refresh deadline. */
export async function readManagedPrimaryAccessToken(): Promise<string | null> {
  return (await readManagedPrimaryCredential())?.accessToken ?? null;
}

/** Records the token a pairing exchange produced. */
export function writeManagedPrimaryAccessToken(input: {
  readonly accessToken: string;
  readonly expiresInSeconds: number;
  readonly dpopThumbprint: string;
}): void {
  hydrated = true;
  const managed = readBkManagedEnvironment();
  if (managed === null) {
    return;
  }
  const credential: StoredManagedPrimaryCredential = {
    httpBaseUrl: managed.httpBaseUrl,
    accessToken: input.accessToken,
    expiresAtEpochMs: Date.now() + Math.max(0, input.expiresInSeconds) * 1_000,
    dpopThumbprint: input.dpopThumbprint,
  };
  cachedCredential = credential;
  try {
    readStorage()?.setItem(STORAGE_KEY, JSON.stringify(credential));
  } catch {
    // Storage is best effort; the in-memory mirror carries this session.
  }
}

/** Forgets the token, sending the app back to the pairing gate. */
export function clearManagedPrimaryAccessToken(): void {
  hydrated = true;
  cachedCredential = null;
  try {
    readStorage()?.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to do — the in-memory mirror is already cleared.
  }
}

export function __resetManagedPrimaryCredentialForTests(): void {
  cachedCredential = null;
  hydrated = false;
}
