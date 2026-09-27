import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { SidebarProvider } from "../ui/sidebar";
import { performWebLogout, WebLogoutControlView } from "./WebLogoutControl";

describe("web logout", () => {
  it("revokes the environment session before ending Clerk and redirecting", async () => {
    const operations: string[] = [];

    await performWebLogout({
      logoutEnvironment: async () => {
        operations.push("environment");
      },
      signOutClerk: async () => {
        operations.push("clerk");
      },
      redirectToSignIn: () => {
        operations.push("redirect");
      },
    });

    expect(operations).toEqual(["environment", "clerk", "redirect"]);
  });

  it("does not create a partial Clerk logout when environment revocation fails", async () => {
    const signOutClerk = vi.fn(async () => undefined);
    const redirectToSignIn = vi.fn();

    await expect(
      performWebLogout({
        logoutEnvironment: async () => {
          throw new Error("Environment unavailable");
        },
        signOutClerk,
        redirectToSignIn,
      }),
    ).rejects.toThrow("Environment unavailable");

    expect(signOutClerk).not.toHaveBeenCalled();
    expect(redirectToSignIn).not.toHaveBeenCalled();
  });

  it("renders a disabled progress state while logout is in flight", () => {
    const markup = renderToStaticMarkup(
      <SidebarProvider>
        <WebLogoutControlView isLoggingOut onLogout={() => undefined} />
      </SidebarProvider>,
    );

    expect(markup).toContain("Logging out…");
    expect(markup).toContain("disabled");
    expect(markup).toContain("animate-spin");
  });
});
