/**
 * The Expo dev client launches the app via
 * <scheme>://expo-development-client/?url=<packager> — that URL addresses
 * the launcher, not app navigation. Without this filter it falls through
 * to the NotFound wildcard route on every dev launch.
 */
export function shouldHandleAppLink(url: string): boolean {
  return (
    !url.includes("expo-development-client") &&
    !url.includes("://expo-sharing") &&
    // T3-CUSTOM(expbkt3): the BK mobile build registers the t3code-bk scheme.
    !/^t3code(-dev|-preview|-bk)?:\/*$/.test(url)
  );
}
