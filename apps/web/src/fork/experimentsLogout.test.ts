import { describe, expect, it, vi } from "vite-plus/test";

import { PrimaryEnvironmentRequestError } from "../environments/primary";
import {
  createLogoutRunner,
  desktopPairingHref,
  endPrimaryEnvironmentSession,
  navigateAfterLogout,
  performExperimentsLogout,
  resolveExperimentsLogoutPlan,
  resolveExperimentsLogoutSource,
  type ExperimentsLogoutPlan,
} from "./experimentsLogout";

function plan(input: Parameters<typeof resolveExperimentsLogoutPlan>[0]): ExperimentsLogoutPlan {
  const resolved = resolveExperimentsLogoutPlan(input);
  if (resolved === null) throw new Error("expected a logout plan");
  return resolved;
}

const browser = plan({ isElectron: false, managedPrimary: false, clerkSignedIn: true });
const pairedDesktop = plan({ isElectron: true, managedPrimary: true, clerkSignedIn: false });
const clerkDesktop = plan({ isElectron: true, managedPrimary: false, clerkSignedIn: true });

function recordingEffects() {
  const operations: string[] = [];
  return {
    operations,
    effects: {
      logoutEnvironment: async () => {
        operations.push("environment");
      },
      signOutClerk: async () => {
        operations.push("clerk");
      },
      navigate: (destination: string) => {
        operations.push(`navigate:${destination}`);
      },
    },
  };
}

describe("experiments logout plan", () => {
  it("offers a logout only where there is a session to end", () => {
    expect(
      resolveExperimentsLogoutPlan({
        isElectron: false,
        managedPrimary: false,
        clerkSignedIn: false,
      }),
    ).toBeNull();
    expect(
      resolveExperimentsLogoutPlan({
        isElectron: true,
        managedPrimary: false,
        clerkSignedIn: false,
      }),
    ).toBeNull();
  });

  it("keeps the bundled backend's session when an unmanaged desktop signs out of Clerk", () => {
    expect(clerkDesktop).toEqual({
      revokeEnvironmentSession: false,
      signOutClerk: true,
      destination: "desktop-reload",
    });
  });

  it("logs a keyless managed desktop out without Clerk", () => {
    expect(pairedDesktop).toEqual({
      revokeEnvironmentSession: true,
      signOutClerk: false,
      destination: "desktop-pairing",
    });
    expect(plan({ isElectron: true, managedPrimary: true, clerkSignedIn: true }).signOutClerk).toBe(
      true,
    );
  });
});

describe("experiments logout sequencing", () => {
  it("web: revokes the environment session, ends Clerk, then loads the sign-in page", async () => {
    const { operations, effects } = recordingEffects();
    await performExperimentsLogout(browser, effects);
    expect(operations).toEqual(["environment", "clerk", "navigate:browser-pairing"]);
  });

  it("managed desktop: revokes the paired session, then reloads into pairing", async () => {
    const { operations, effects } = recordingEffects();
    await performExperimentsLogout(pairedDesktop, effects);
    expect(operations).toEqual(["environment", "navigate:desktop-pairing"]);
  });

  it("unmanaged desktop: ends Clerk, then reloads in place", async () => {
    const { operations, effects } = recordingEffects();
    await performExperimentsLogout(clerkDesktop, effects);
    expect(operations).toEqual(["clerk", "navigate:desktop-reload"]);
  });

  it("stops before Clerk and navigation when the environment refuses the revocation", async () => {
    const { operations, effects } = recordingEffects();
    await expect(
      performExperimentsLogout(browser, {
        ...effects,
        logoutEnvironment: async () => {
          throw new Error("Environment unavailable");
        },
      }),
    ).rejects.toThrow("Environment unavailable");
    expect(operations).toEqual([]);
  });
});

describe("experiments logout control variant", () => {
  it("reads Clerk wherever a provider is mounted, on either platform", () => {
    for (const isElectron of [false, true]) {
      expect(
        resolveExperimentsLogoutSource({ hasClerkConfig: true, isElectron, managedPrimary: false }),
      ).toBe("clerk");
    }
  });

  it("reads the paired session on a keyless managed desktop", () => {
    expect(
      resolveExperimentsLogoutSource({
        hasClerkConfig: false,
        isElectron: true,
        managedPrimary: true,
      }),
    ).toBe("paired-session");
  });

  it("renders nothing without Clerk on the web or on an unmanaged desktop", () => {
    expect(
      resolveExperimentsLogoutSource({
        hasClerkConfig: false,
        isElectron: false,
        managedPrimary: false,
      }),
    ).toBeNull();
    expect(
      resolveExperimentsLogoutSource({
        hasClerkConfig: false,
        isElectron: true,
        managedPrimary: false,
      }),
    ).toBeNull();
  });
});

describe("ending a session the server no longer knows", () => {
  function requestError(status: number) {
    return new PrimaryEnvironmentRequestError({
      operation: "logout-current-session",
      status,
      cause: new Error(`HTTP ${status}`),
    });
  }

  function effectsFailingWith(status: number) {
    const { operations, effects } = recordingEffects();
    return {
      operations,
      effects: {
        ...effects,
        logoutEnvironment: () =>
          endPrimaryEnvironmentSession(
            async () => {
              throw requestError(status);
            },
            () => {
              operations.push("clear-token");
            },
          ),
      },
    };
  }

  it("web: a 401 still signs out of Clerk, so a retry cannot strand a live Clerk session", async () => {
    const { operations, effects } = effectsFailingWith(401);
    await performExperimentsLogout(browser, effects);
    expect(operations).toEqual(["clear-token", "clerk", "navigate:browser-pairing"]);
  });

  it("managed desktop: a 401 clears the stored token and reloads into pairing", async () => {
    const { operations, effects } = effectsFailingWith(401);
    await performExperimentsLogout(pairedDesktop, effects);
    expect(operations).toEqual(["clear-token", "navigate:desktop-pairing"]);
  });

  it("any other failure stops before Clerk and navigation, and reaches the error toast", async () => {
    const { operations, effects } = effectsFailingWith(503);
    const onError = vi.fn();

    await createLogoutRunner().run(() => performExperimentsLogout(browser, effects), onError);

    expect(operations).toEqual([]);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ status: 503 }));
  });
});

describe("logout runner", () => {
  it("ignores a second click while a logout is in flight, and after it succeeded", async () => {
    const runner = createLogoutRunner();
    let finish: () => void = () => undefined;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const perform = vi.fn(() => pending);
    const onError = vi.fn();

    const first = runner.run(perform, onError);
    expect(runner.run(perform, onError)).toBeNull();
    finish();
    await first;

    expect(runner.run(perform, onError)).toBeNull();
    expect(perform).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it("reports a failure and lets the user try again", async () => {
    const runner = createLogoutRunner();
    const failure = new Error("Could not reach the server");
    const perform = vi.fn(async () => {
      throw failure;
    });
    const onError = vi.fn();

    await runner.run(perform, onError);
    expect(onError).toHaveBeenCalledWith(failure);

    await runner.run(perform, onError);
    expect(perform).toHaveBeenCalledTimes(2);
  });
});

describe("navigation after logout", () => {
  function fakeWindow(href: string) {
    const calls: string[] = [];
    const location = {
      href,
      assign: (url: string | URL) => {
        calls.push(`assign:${url.toString()}`);
      },
      reload: () => {
        calls.push("reload");
      },
    };
    const history = {
      state: { key: "settings" },
      replaceState: (state: unknown, _unused: string, url?: string | URL | null) => {
        calls.push(`replace:${JSON.stringify(state)}:${url?.toString()}`);
      },
    };
    return { calls, location, history };
  }

  it("loads the browser's pairing page", () => {
    const { calls, location, history } = fakeWindow(
      "https://stagebkt3.dev.beknown.live/settings/experiments?tab=1",
    );
    navigateAfterLogout("browser-pairing", location, history);
    expect(calls).toEqual(["assign:https://stagebkt3.dev.beknown.live/pair"]);
  });

  it("reloads the desktop window at its hash-routed pairing screen", () => {
    const { calls, location, history } = fakeWindow("t3code://app/#/settings/experiments");
    navigateAfterLogout("desktop-pairing", location, history);
    expect(calls).toEqual(['replace:{"key":"settings"}:t3code://app/#/pair', "reload"]);
  });

  it("reloads the desktop window in place after a Clerk-only logout", () => {
    const { calls, location, history } = fakeWindow("t3code://app/#/settings/experiments");
    navigateAfterLogout("desktop-reload", location, history);
    expect(calls).toEqual(["reload"]);
  });

  it("keeps the renderer's path and query when pointing at the pairing screen", () => {
    expect(desktopPairingHref("http://127.0.0.1:5733/index.html?x=1#/settings")).toBe(
      "http://127.0.0.1:5733/index.html?x=1#/pair",
    );
  });
});
