/** T3-CUSTOM(expbkt3): Retain the public draft across browser authentication redirects. */
const key = "t3-toolyard-settings-draft:browser-continuation";
const prefix = "#toolyard-settings=";
export function prepareToolyardSettingsContinuation() {
  const hash = window.location.hash;
  if (!hash.startsWith(prefix) || hash.length > 8192) return;
  try {
    window.sessionStorage.setItem(key, hash);
    window.history.replaceState(
      window.history.state,
      "",
      window.location.pathname + window.location.search,
    );
  } catch {
    // The component can still read the current fragment when storage is unavailable.
  }
}
export function pendingToolyardSettingsContinuation(): string | null {
  try {
    const hash = window.sessionStorage.getItem(key);
    return hash?.startsWith(prefix) && hash.length <= 8192 ? hash : null;
  } catch {
    return null;
  }
}
export function clearToolyardSettingsContinuation() {
  try {
    window.sessionStorage.removeItem(key);
  } catch {
    /* Authentication remains available. */
  }
}
