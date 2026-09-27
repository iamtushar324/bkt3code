// T3-CUSTOM(expbkt3): BEGIN - a managed BK build presents its paired token instead.
import { isBkManagedPrimary } from "../../fork/managedEnvironment";
import { readManagedPrimaryAccessToken } from "../../fork/managedPrimaryCredential";

// T3-CUSTOM(expbkt3): END
let desktopBearerTokenPromise: Promise<string> | null = null;

export function readDesktopPrimaryBearerToken(): Promise<string | null> {
  // T3-CUSTOM(expbkt3): BEGIN - in a managed BK build the primary environment is the
  // central server, where the local backend's bearer token means nothing. Present the
  // token the operator's pairing produced; null until they pair, which shows the gate.
  if (isBkManagedPrimary()) {
    return readManagedPrimaryAccessToken();
  }
  // T3-CUSTOM(expbkt3): END
  if (typeof window === "undefined") {
    return Promise.resolve(null);
  }
  const bridge = window.desktopBridge;
  if (!bridge) {
    return Promise.resolve(null);
  }

  desktopBearerTokenPromise ??= bridge.getLocalEnvironmentBearerToken().catch((error) => {
    desktopBearerTokenPromise = null;
    throw error;
  });
  return desktopBearerTokenPromise;
}

export function __resetDesktopPrimaryAuthForTests(): void {
  desktopBearerTokenPromise = null;
}
