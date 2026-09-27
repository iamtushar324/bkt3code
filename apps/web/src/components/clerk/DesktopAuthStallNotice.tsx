import React from "react";

/**
 * Fork-owned diagnostic for a desktop build whose Clerk provider never loads.
 *
 * In a packaged desktop build `main.tsx` mounts `ElectronClerkProvider`, which
 * talks to Clerk's Native API and renders its children only once initialization
 * settles. If that API is disabled for the instance, initialization never
 * settles, the provider renders nothing, and the whole window is blank with no
 * message anywhere — the app looks broken rather than misconfigured. That cost a
 * real debugging session on the first BK desktop build, so this replaces the
 * blank window with the actual cause.
 *
 * It renders as a *sibling* of the provider, not a child, which is the only way
 * it can appear when the provider itself renders nothing.
 *
 * See docs/operations/bk-desktop-build.md, "Blank window, and sign-in fails with
 * native_api_disabled".
 */

/** How long to wait before concluding the provider is never going to render. */
export const AUTH_STALL_TIMEOUT_MS = 12_000;

/**
 * True when the app rendered literally nothing, which is the only case this
 * notice should claim.
 *
 * Deliberately narrow: a signed-out user, an auth error surfaced by the app, or a
 * loading spinner all put elements in the root, so none of them trip this. Only a
 * provider that rendered no children at all leaves the root empty.
 *
 * Takes the count rather than the element so it stays a pure decision, testable
 * in the DOM-free `unit` project.
 */
export function shouldReportAuthStall(rootChildElementCount: number | undefined): boolean {
  return rootChildElementCount === 0;
}

export function DesktopAuthStallNotice({
  timeoutMs = AUTH_STALL_TIMEOUT_MS,
  rootElementId = "root",
}: {
  readonly timeoutMs?: number;
  readonly rootElementId?: string;
}): React.ReactElement | null {
  const [stalled, setStalled] = React.useState(false);

  React.useEffect(() => {
    const timer = setTimeout(() => {
      setStalled(shouldReportAuthStall(document.getElementById(rootElementId)?.childElementCount));
    }, timeoutMs);
    return () => clearTimeout(timer);
  }, [timeoutMs, rootElementId]);

  if (!stalled) return null;

  return (
    <div
      role="alert"
      style={{
        position: "fixed",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "2rem",
        // Inline styles on purpose: a stalled provider may mean the app's own
        // stylesheet-dependent layout never mounted, so this must not rely on it.
        font: "14px/1.6 -apple-system, BlinkMacSystemFont, system-ui, sans-serif",
        background: "#0d2a5c",
        color: "#f4f6fb",
      }}
    >
      <div style={{ maxWidth: "34rem" }}>
        <h1 style={{ font: "600 18px/1.4 inherit", margin: "0 0 0.75rem" }}>
          Sign-in service did not respond
        </h1>
        <p style={{ margin: "0 0 0.75rem" }}>
          This build could not initialize authentication, so the app could not start. The window is
          blank because the sign-in provider never finished loading — not because the app crashed.
        </p>
        <p style={{ margin: "0 0 0.75rem" }}>
          The usual cause is that the Clerk instance has its <strong>Native API disabled</strong>.
          Desktop builds require it; the browser app does not. Enable it under{" "}
          <strong>Clerk Dashboard &rarr; Native applications</strong>, then reopen this app.
        </p>
        <p style={{ margin: 0, opacity: 0.75 }}>
          Details: docs/operations/bk-desktop-build.md &mdash; &ldquo;Blank window, and sign-in
          fails with native_api_disabled&rdquo;.
        </p>
      </div>
    </div>
  );
}
