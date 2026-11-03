/** Vite's proxy and the server's dev 404 handler must share prefixes to avoid index.html responses or redirect loops. */
// T3-CUSTOM(expbkt3): BEGIN — reformatted to a multi-line array to add the
// fork's /attachments prefix (upstream now ships /mcp itself).
export const DEV_PROXIED_PATH_PREFIXES = [
  "/api",
  "/oauth",
  "/.well-known",
  "/ws",
  "/attachments",
  "/mcp",
] as const;
// T3-CUSTOM(expbkt3): END

/** Preserve origins for OAuth metadata validation and /ws cookie-session Origin/Host checks. */
export const DEV_PROXIED_ORIGIN_PRESERVING_PREFIXES: ReadonlySet<string> = new Set([
  "/oauth",
  "/.well-known",
  "/mcp",
  "/ws",
]);

export function isDevProxiedPath(pathname: string): boolean {
  return DEV_PROXIED_PATH_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}
