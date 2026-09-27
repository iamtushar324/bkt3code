/**
 * T3-CUSTOM(expbkt3): the last primary platform registration that resolved.
 *
 * Platform-managed environments are rebuilt from a poll rather than restored
 * from the connection catalog, and building one requires a live descriptor
 * fetch against the host. That makes a host which is already down when the app
 * starts invisible: the registration is omitted, the environment never installs,
 * and the shell/thread caches sitting in IndexedDB are never rendered — the app
 * looks empty rather than offline.
 *
 * Keeping the last-good registration here closes that gap. The record is the
 * descriptor-derived identity of the environment (its id and label) alongside
 * the endpoints it was reached on, so a disconnected start can install the
 * environment immediately and let the supervisor retry the connection in the
 * background, exactly as it would for a host that dropped mid-session.
 *
 * The record is bound to a signature of the endpoints it was resolved for, so a
 * build repointed at another host — or a stale record left by an older build —
 * is discarded rather than presented as that host's identity. Nothing secret is
 * stored: a primary registration carries no credential, only the same-origin
 * endpoints the app was already configured with.
 *
 * Persisted in `localStorage`, with an in-memory mirror so the module still
 * works where storage is unavailable (private modes, tests). Both are
 * best-effort: losing the record costs one poll's worth of visibility, never
 * correctness.
 *
 * @module fork/platformRegistrationCache
 */
import {
  PrimaryConnectionRegistration,
  PrimaryConnectionTarget,
} from "@t3tools/client-runtime/connection";
import type { EnvironmentId } from "@t3tools/contracts";

const STORAGE_KEY = "expbkt3:platform-registration-cache";

export interface StoredPlatformRegistration {
  /** Endpoints this identity was resolved for; a mismatch discards the record. */
  readonly signature: string;
  readonly environmentId: string;
  readonly label: string;
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
}

let cachedRegistration: StoredPlatformRegistration | null = null;
let hydrated = false;

function readStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : (window.localStorage ?? null);
  } catch {
    return null;
  }
}

export function parseStoredPlatformRegistration(
  raw: string | null,
): StoredPlatformRegistration | null {
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
  const candidate = parsed as Partial<StoredPlatformRegistration>;
  if (
    typeof candidate.signature !== "string" ||
    candidate.signature.length === 0 ||
    typeof candidate.environmentId !== "string" ||
    candidate.environmentId.length === 0 ||
    typeof candidate.label !== "string" ||
    typeof candidate.httpBaseUrl !== "string" ||
    candidate.httpBaseUrl.length === 0 ||
    typeof candidate.wsBaseUrl !== "string" ||
    candidate.wsBaseUrl.length === 0
  ) {
    return null;
  }
  return {
    signature: candidate.signature,
    environmentId: candidate.environmentId,
    label: candidate.label,
    httpBaseUrl: candidate.httpBaseUrl,
    wsBaseUrl: candidate.wsBaseUrl,
  };
}

export function readPersistedPrimaryRegistration(): StoredPlatformRegistration | null {
  if (hydrated) {
    return cachedRegistration;
  }
  hydrated = true;
  const storage = readStorage();
  if (storage === null) {
    return cachedRegistration;
  }
  try {
    cachedRegistration = parseStoredPlatformRegistration(storage.getItem(STORAGE_KEY));
  } catch {
    cachedRegistration = null;
  }
  return cachedRegistration;
}

export function writePersistedPrimaryRegistration(entry: StoredPlatformRegistration): void {
  hydrated = true;
  cachedRegistration = entry;
  const storage = readStorage();
  if (storage === null) {
    return;
  }
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(entry));
  } catch {
    // Storage is full or blocked; the in-memory mirror still serves this run.
  }
}

export function clearPersistedPrimaryRegistration(): void {
  hydrated = true;
  cachedRegistration = null;
  const storage = readStorage();
  if (storage === null) {
    return;
  }
  try {
    storage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to do: the in-memory mirror is already cleared.
  }
}

export function storedPlatformRegistration(
  signature: string,
  registration: PrimaryConnectionRegistration,
): StoredPlatformRegistration {
  return {
    signature,
    environmentId: registration.target.environmentId,
    label: registration.target.label,
    httpBaseUrl: registration.target.httpBaseUrl,
    wsBaseUrl: registration.target.wsBaseUrl,
  };
}

export function platformRegistrationFromStored(
  stored: StoredPlatformRegistration,
): PrimaryConnectionRegistration {
  return new PrimaryConnectionRegistration({
    target: new PrimaryConnectionTarget({
      environmentId: stored.environmentId as EnvironmentId,
      label: stored.label,
      httpBaseUrl: stored.httpBaseUrl,
      wsBaseUrl: stored.wsBaseUrl,
    }),
  });
}

/**
 * The registration to install when the descriptor fetch could not resolve the
 * primary environment this poll. Only a record resolved for the very endpoints
 * being dialled now is reused, so the environment always keeps the identity the
 * host itself reported.
 */
export function primaryRegistrationFallback(
  signature: string,
  stored: StoredPlatformRegistration | null = readPersistedPrimaryRegistration(),
): PrimaryConnectionRegistration | null {
  if (stored === null || stored.signature !== signature) {
    return null;
  }
  return platformRegistrationFromStored(stored);
}

export function __resetPersistedPrimaryRegistrationForTests(): void {
  cachedRegistration = null;
  hydrated = false;
}
