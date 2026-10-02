import {
  TOOLYARD_MCP_URL,
  type PersonalMcpIntegration,
  type PersonalMcpProfile,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  createToolyardAutoConnectRunner,
  resolveToolyardCardView,
  shouldAutoConnectToolyard,
  toolyardConnectErrorMessage,
  toolyardIntegrationOf,
} from "./toolyardConnect";

const toolyard = (credentialConfigured: boolean): PersonalMcpIntegration => ({
  id: "toolyard",
  name: "toolyard",
  url: TOOLYARD_MCP_URL,
  enabled: true,
  authMode: "bearer",
  customHeaderName: "",
  credentialConfigured,
  providerInstanceIds: [],
  allowedTools: [],
});

const profileWith = (integrations: ReadonlyArray<PersonalMcpIntegration>): PersonalMcpProfile => ({
  userId: "user_1" as PersonalMcpProfile["userId"],
  externalAccessEnabled: false,
  externalTokenConfigured: false,
  externalTokenPrefix: "",
  integrations,
  updatedAt: "2026-10-02T07:00:00.000Z",
});

describe("toolyardIntegrationOf", () => {
  it("finds the built-in entry and nothing else", () => {
    expect(toolyardIntegrationOf(profileWith([toolyard(true)]))?.credentialConfigured).toBe(true);
    expect(toolyardIntegrationOf(profileWith([]))).toBeNull();
    expect(toolyardIntegrationOf(null)).toBeNull();
  });
});

describe("shouldAutoConnectToolyard", () => {
  it("connects a signed-in operator whose profile shows no toolyard credential", () => {
    expect(
      shouldAutoConnectToolyard({
        signedIn: true,
        profile: profileWith([toolyard(false)]),
        attempted: false,
      }),
    ).toBe(true);
  });

  it("does nothing while signed out, before the profile loads, once connected, or after one try", () => {
    const pending = profileWith([toolyard(false)]);
    expect(shouldAutoConnectToolyard({ signedIn: false, profile: pending, attempted: false })).toBe(
      false,
    );
    expect(shouldAutoConnectToolyard({ signedIn: true, profile: null, attempted: false })).toBe(
      false,
    );
    expect(
      shouldAutoConnectToolyard({
        signedIn: true,
        profile: profileWith([toolyard(true)]),
        attempted: false,
      }),
    ).toBe(false);
    expect(shouldAutoConnectToolyard({ signedIn: true, profile: pending, attempted: true })).toBe(
      false,
    );
  });
});

describe("createToolyardAutoConnectRunner", () => {
  const pending = profileWith([toolyard(false)]);

  it("does not use up the attempt until a Clerk token is actually in hand", async () => {
    const runner = createToolyardAutoConnectRunner();
    const connects: string[] = [];
    const base = {
      signedIn: true,
      userId: "user_1",
      profile: pending,
      connect: async (token: string) => {
        connects.push(token);
      },
    };

    // Clerk not ready yet: nothing sent, nothing burned.
    expect(await runner.run({ ...base, readToken: async () => null })).toBe("no-token");
    expect(connects).toEqual([]);

    // Token available: one connect, and that is this load's attempt.
    expect(await runner.run({ ...base, readToken: async () => "clerk-1" })).toBe("attempted");
    expect(connects).toEqual(["clerk-1"]);

    // The profile still says unconnected (the connect failed, say): no retry this load.
    expect(await runner.run({ ...base, readToken: async () => "clerk-2" })).toBe("skipped");
    expect(connects).toEqual(["clerk-1"]);
  });

  it("gives a different signed-in user their own attempt without a reload", async () => {
    const runner = createToolyardAutoConnectRunner();
    const connects: string[] = [];
    const run = (userId: string, token: string) =>
      runner.run({
        signedIn: true,
        userId,
        profile: pending,
        readToken: async () => token,
        connect: async (clerkToken) => {
          connects.push(clerkToken);
        },
      });

    expect(await run("user_1", "clerk-user-1")).toBe("attempted");
    expect(await run("user_1", "clerk-user-1-again")).toBe("skipped");
    expect(await run("user_2", "clerk-user-2")).toBe("attempted");
    expect(connects).toEqual(["clerk-user-1", "clerk-user-2"]);
  });

  it("collapses overlapping runs into one connect", async () => {
    const runner = createToolyardAutoConnectRunner();
    const connects: string[] = [];
    let releaseToken: (token: string) => void = () => {};
    const tokenGate = new Promise<string>((resolve) => {
      releaseToken = resolve;
    });
    const input = {
      signedIn: true,
      userId: "user_1",
      profile: pending,
      connect: async (token: string) => {
        connects.push(token);
      },
    };

    const first = runner.run({ ...input, readToken: () => tokenGate });
    // A StrictMode re-run or a profile refresh while the first is still reading its token.
    expect(await runner.run({ ...input, readToken: async () => "clerk-late" })).toBe("busy");
    releaseToken("clerk-first");
    expect(await first).toBe("attempted");
    expect(connects).toEqual(["clerk-first"]);
  });

  it("stays idle for a signed-out or already-connected operator", async () => {
    const runner = createToolyardAutoConnectRunner();
    const readToken = async () => "clerk";
    const connect = async () => {};
    expect(
      await runner.run({ signedIn: false, userId: null, profile: pending, readToken, connect }),
    ).toBe("skipped");
    expect(
      await runner.run({
        signedIn: true,
        userId: "user_1",
        profile: profileWith([toolyard(true)]),
        readToken,
        connect,
      }),
    ).toBe("skipped");
  });
});

describe("toolyardConnectErrorMessage", () => {
  it("words toolyard's refusals plainly", () => {
    expect(toolyardConnectErrorMessage("not_org_member")).toBe(
      "Your account isn't in the Beknown org.",
    );
    expect(toolyardConnectErrorMessage("agent_disabled")).toBe(
      "Your T3 Code agent is disabled in toolyard.",
    );
    expect(toolyardConnectErrorMessage("user_disabled")).toBe("Your toolyard account is disabled.");
  });

  it("words T3's own refusals plainly", () => {
    expect(toolyardConnectErrorMessage("not_signed_in")).toBe(
      "Sign in with your Beknown account to connect toolyard.",
    );
    expect(toolyardConnectErrorMessage("identity_mismatch")).toBe(
      "Your sign-in doesn't match this T3 session. Sign out and back in, then reconnect.",
    );
  });

  it("asks for a fresh sign-in when a signed-in client has no Clerk token", () => {
    expect(toolyardConnectErrorMessage("no_clerk_token")).toBe(
      "No sign-in token is available. Sign out and back in, then reconnect.",
    );
  });

  it("falls back to a generic message that still names an unknown code", () => {
    expect(toolyardConnectErrorMessage("internal_error")).toBe(
      "toolyard could not be connected (internal_error).",
    );
    expect(toolyardConnectErrorMessage(undefined)).toBe("toolyard could not be connected.");
  });
});

describe("resolveToolyardCardView", () => {
  const connected: PersonalMcpIntegration = {
    ...toolyard(true),
    connectedEmail: "tushar.bhardwaj@beknown.work",
    connectedAt: "2026-10-02T09:43:30.000Z",
  };
  const formatConnectedAt = () => "5m ago";
  const web = { canSignIn: true, webAppUrl: null, formatConnectedAt };
  const desktop = {
    canSignIn: false,
    webAppUrl: "https://stagebkt3.dev.beknown.live",
    formatConnectedAt,
  };

  it("offers Reconnect on the web, connected or not", () => {
    expect(resolveToolyardCardView({ ...web, toolyard: connected })).toEqual({
      status: "Connected automatically as tushar.bhardwaj@beknown.work · last connected 5m ago",
      action: { kind: "reconnect" },
    });
    expect(resolveToolyardCardView({ ...web, toolyard: toolyard(false) })).toEqual({
      status: "Not connected",
      action: { kind: "reconnect" },
    });
  });

  it("shows the server-side connection on a keyless desktop without offering Reconnect", () => {
    expect(resolveToolyardCardView({ ...desktop, toolyard: connected })).toEqual({
      status: "Connected automatically as tushar.bhardwaj@beknown.work · last connected 5m ago",
      action: { kind: "none" },
    });
  });

  it("sends a keyless desktop to the web app's origin when nothing is connected", () => {
    expect(resolveToolyardCardView({ ...desktop, toolyard: toolyard(false) })).toEqual({
      status: "Not connected · connect once from the web app",
      action: { kind: "open-web", url: "https://stagebkt3.dev.beknown.live" },
    });
    // The link is the origin, whatever path or slash the configured URL carries.
    expect(
      resolveToolyardCardView({
        ...desktop,
        webAppUrl: "https://bkt3.dev.beknown.live/some/path/",
        toolyard: toolyard(false),
      }).action,
    ).toEqual({ kind: "open-web", url: "https://bkt3.dev.beknown.live" });
  });

  it("offers no link when there is no https web app to send the person to", () => {
    expect(
      resolveToolyardCardView({ ...desktop, webAppUrl: null, toolyard: toolyard(false) }),
    ).toEqual({
      status: "Not connected · toolyard connects from the web app; this app has no web sign-in",
      action: { kind: "none" },
    });
    expect(
      resolveToolyardCardView({
        ...desktop,
        webAppUrl: "http://127.0.0.1:18086",
        toolyard: toolyard(false),
      }).action,
    ).toEqual({ kind: "none" });
  });

  it("is quiet while the profile loads", () => {
    expect(resolveToolyardCardView({ ...desktop, toolyard: null })).toEqual({
      status: "Loading…",
      action: { kind: "none" },
    });
  });
});
