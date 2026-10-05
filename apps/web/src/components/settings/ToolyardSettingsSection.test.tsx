/** T3-CUSTOM(expbkt3): Paired clients request browser trust only after the exact server refusal. */
import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import * as Cause from "effect/Cause";
import { PersonalMcpSettingsError } from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { createToolyardSettingsContinuation } from "@t3tools/client-runtime/toolyard-trust-setup";
const mocks = vi.hoisted(() => ({
  status: {
    mode: "team" as "team" | "api-key",
    apiKeyAllowed: true,
    teamAvailable: true,
    callbackTransport: "push" as "push" | "pull",
    revision: 0,
    revocationPending: 0,
    enabled: false,
    removed: false,
    baseUrl: null as string | null,
    instanceId: null,
    origin: null,
    administrator: true,
    connection: "not_connected",
    email: null,
    expiresAt: null,
  },
  userId: "user_admin",
  clerkUserId: "user_admin" as string | null,
  selectedIds: ["env_stage"],
  sessionUsers: new Map<string, string | null>(),
  sessionAuthenticated: new Map<string, boolean>(),
  statusByEnvironment: new Map<string, object>(),
  statusQueries: vi.fn(),
  webhookQueries: vi.fn(),
  webhookUpdate: vi.fn(),
  configure: vi.fn(),
  token: vi.fn(),
  open: vi.fn(),
  refresh: vi.fn(),
  atom: {},
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: unknown) => {
    if (atom === "clerk-user") return mocks.clerkUserId;
    const webhookEnvironmentId = (atom as { webhookEnvironmentId?: string }).webhookEnvironmentId;
    if (webhookEnvironmentId)
      return AsyncResult.success([
        {
          id: `${webhookEnvironmentId}-hook`,
          threadId: `${webhookEnvironmentId}-thread`,
          revision: 1,
          status: "active",
          terminalReason: null,
          deliveries: [],
          deliveryHistory: [],
        },
      ]);
    const environmentId = (atom as { environmentId?: string }).environmentId;
    return AsyncResult.success(mocks.statusByEnvironment.get(environmentId ?? "") ?? mocks.status);
  },
}));
vi.mock("../../state/identity", () => ({ currentClerkUserAtom: "clerk-user" }));
vi.mock("./SettingsScopeContext", () => ({
  useSettingsScope: () => ({
    connectedEnvironments: mocks.selectedIds.map((environmentId) => ({
      environmentId,
      label: environmentId === "env_mac" ? "Mac" : "Stage",
      connection: { phase: "connected" },
      serverConfig: {
        auth: environmentId === "env_mac" ? {} : { clerk: {} },
        settings: {
          experimental: {
            externalMcp: {
              publicUrl: environmentId === "env_mac" ? null : "https://stage-mcp.test",
            },
          },
        },
      },
    })),
  }),
}));
vi.mock("../../state/session", () => ({
  readPreparedConnection: (environmentId: string) => ({
    httpBaseUrl: environmentId === "env_mac" ? "http://127.0.0.1:4312" : "https://stage.test",
  }),
  useEnvironmentSessionState: (environmentId: string) => ({
    data: {
      authenticated: mocks.sessionAuthenticated.get(environmentId) ?? true,
      userId: mocks.sessionUsers.has(environmentId)
        ? mocks.sessionUsers.get(environmentId)
        : mocks.userId,
    },
  }),
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    toolyardIntegrationStatus: (input: { environmentId: string; input: { userScope: string } }) => {
      mocks.statusQueries(input);
      return { environmentId: input.environmentId };
    },
    sessionWebhooksList: (input: { environmentId: string }) => {
      mocks.webhookQueries(input);
      return { webhookEnvironmentId: input.environmentId };
    },
    sessionWebhooksUpdate: "webhook-update",
    configureToolyardIntegration: "configure",
    openToolyardDashboard: "handoff",
  },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: string) =>
    command === "configure"
      ? mocks.configure
      : command === "webhook-update"
        ? mocks.webhookUpdate
        : vi.fn(),
}));
vi.mock("../../state/teamIdentityToken", () => ({ readTeamClerkToken: () => mocks.token() }));
vi.mock("../../rpc/atomRegistry", () => ({ appAtomRegistry: { refresh: mocks.refresh } }));
vi.mock("../../hooks/useSettings", () => ({ usePrimarySettings: () => "https://stale-mcp.test" }));
vi.mock("../../fork/managedEnvironment", () => ({
  readBkManagedEnvironment: () => ({ httpBaseUrl: "https://stable.test" }),
}));
vi.mock("../../fork/toolyardBrowserHandoff", () => ({
  createToolyardBrowserHandoffTarget: () => ({ open: mocks.open, close: vi.fn() }),
}));
vi.mock("../ui/button", () => ({
  Button: ({ children, ...props }: { children: ReactNode }) => (
    <button {...props}>{children}</button>
  ),
}));
vi.mock("../ui/input", () => ({ Input: (props: object) => <input {...props} /> }));
vi.mock("../ui/switch", () => ({
  Switch: (props: object) => <button data-testid="switch" {...props} />,
}));
vi.mock("./settingsLayout", () => ({
  SettingsSection: ({ children, title }: { children: ReactNode; title: string }) => (
    <section data-title={title}>{children}</section>
  ),
  SettingsRow: ({ children, control }: { children: ReactNode; control: ReactNode }) => (
    <div>
      {children}
      {control}
    </div>
  ),
}));
import { ToolyardSettingsSection } from "./ToolyardSettingsSection";
import { SessionWebhookSettingsSection } from "../../fork/SessionWebhookSettingsSection";
import { readToolyardSettingsDraft, toolyardDraftKey } from "../../fork/toolyardSettingsDraft";
let renderer: ReactTestRenderer;
const key = toolyardDraftKey("env_stage", "user_admin");
const failure = (code: string) =>
  AsyncResult.failure(
    Cause.fail(new PersonalMcpSettingsError({ operation: "Toolyard integration", message: code })),
  );
function button(name: string) {
  return renderer.root.findAllByType("button").find((node) => node.children.includes(name))!;
}
async function render() {
  await act(() => {
    renderer = create(<ToolyardSettingsSection />);
  });
}
async function edit() {
  await act(() => {
    renderer.root
      .findByProps({ "aria-label": "Toolyard base URL" })
      .props.onChange({ target: { value: "https://toolyard.test" } });
  });
  await act(() => {
    renderer.root.findByProps({ "data-testid": "switch" }).props.onCheckedChange(true);
  });
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const store = new Map<string, string>();
  vi.stubGlobal("window", {
    desktopBridge: {},
    sessionStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
      removeItem: (key: string) => store.delete(key),
    },
    location: {
      hash: "",
      origin: "https://stage.test",
      pathname: "/settings/experiments",
      search: "",
    },
    history: { state: null, replaceState: vi.fn() },
    setInterval,
    clearInterval,
  });
  mocks.status = {
    ...mocks.status,
    mode: "team",
    teamAvailable: true,
    administrator: true,
    revision: 0,
    enabled: false,
    baseUrl: null,
    removed: false,
    connection: "not_connected",
  };
  mocks.userId = "user_admin";
  mocks.clerkUserId = "user_admin";
  mocks.selectedIds = ["env_stage"];
  mocks.sessionUsers.clear();
  mocks.sessionAuthenticated.clear();
  mocks.statusByEnvironment.clear();
  mocks.token.mockResolvedValue(null);
  mocks.open.mockResolvedValue(undefined);
  mocks.configure.mockResolvedValue(failure("admin_trust_registration_required"));
});
afterEach(async () => {
  await act(() => renderer?.unmount());
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
it("first calls configure without a token, opens only the exact refused setup in the default browser, and retains edited drafts", async () => {
  await render();
  await edit();
  await act(() => button("Save and verify trust").props.onClick());
  expect(mocks.configure).toHaveBeenCalledOnce();
  expect(mocks.configure.mock.calls[0]![0].input).not.toHaveProperty("adminToken");
  const url = new URL(mocks.open.mock.calls[0]![0]);
  expect(url.origin).toBe("https://stage.test");
  expect(url.pathname).toBe("/settings/experiments");
  expect(readToolyardSettingsDraft(key)).toEqual({
    baseUrl: "https://toolyard.test",
    enabled: true,
    revision: 0,
  });
  await act(() => {
    renderer.root
      .findByProps({ "aria-label": "Toolyard base URL" })
      .props.onChange({ target: { value: "https://new-draft.test" } });
  });
  mocks.status = { ...mocks.status, revision: 1, enabled: true, baseUrl: "https://toolyard.test" };
  await act(() => renderer.update(<ToolyardSettingsSection />));
  expect(readToolyardSettingsDraft(key)?.baseUrl).toBe("https://new-draft.test");
});
it("clears only an unchanged draft after a matching advanced server result", async () => {
  await render();
  await edit();
  await act(() => button("Save and verify trust").props.onClick());
  mocks.status = {
    ...mocks.status,
    revision: 1,
    enabled: false,
    baseUrl: "https://different.test",
  };
  await act(() => renderer.update(<ToolyardSettingsSection />));
  expect(readToolyardSettingsDraft(key)).not.toBeNull();
  mocks.status = { ...mocks.status, revision: 2, enabled: true, baseUrl: "https://toolyard.test" };
  await act(() => renderer.update(<ToolyardSettingsSection />));
  expect(readToolyardSettingsDraft(key)).toBeNull();
});
it.each(["settings_revision_conflict", "administrator_required", "unknown secret"])(
  "does not open a browser for %s",
  async (code) => {
    mocks.configure.mockResolvedValue(failure(code));
    await render();
    await edit();
    await act(() => button("Save and verify trust").props.onClick());
    expect(mocks.open).not.toHaveBeenCalled();
    expect(readToolyardSettingsDraft(key)).not.toBeNull();
  },
);
it("does not open a browser after a successful token-free setting change", async () => {
  mocks.configure.mockResolvedValue(AsyncResult.success({ ...mocks.status, revision: 1 }));
  await render();
  await edit();
  await act(() => button("Save and verify trust").props.onClick());
  expect(mocks.open).not.toHaveBeenCalled();
  expect(readToolyardSettingsDraft(key)).toBeNull();
});
it("prefills an authenticated browser draft without any configure call until explicit Save", async () => {
  window.location.hash = new URL(
    createToolyardSettingsContinuation(
      "https://stage.test",
      "env_stage",
      "user_admin",
      { baseUrl: "https://toolyard.test", enabled: true, revision: 0 },
      Date.now(),
    ),
  ).hash;
  mocks.token.mockResolvedValue("fresh-browser-token");
  mocks.configure.mockResolvedValue(AsyncResult.success({ ...mocks.status, revision: 1 }));
  await render();
  expect(mocks.configure).not.toHaveBeenCalled();
  expect(renderer.root.findByProps({ "aria-label": "Toolyard base URL" }).props.value).toBe(
    "https://toolyard.test",
  );
  await act(() => button("Save and verify trust").props.onClick());
  expect(mocks.configure.mock.calls[0]![0].input.adminToken).toBe("fresh-browser-token");
  expect(mocks.open).not.toHaveBeenCalled();
});

it("does not attempt an asynchronous popup when a browser lacks fresh Clerk identity", async () => {
  Reflect.deleteProperty(window, "desktopBridge");
  await render();
  await edit();
  await act(() => button("Save and verify trust").props.onClick());
  expect(mocks.open).not.toHaveBeenCalled();
  expect(readToolyardSettingsDraft(key)).not.toBeNull();
  expect(renderer.root.findByProps({ role: "alert" }).children.join("")).toContain(
    "signed-in browser administrator",
  );
});

it("submits a local API key once without Clerk or browser trust and clears the secret after success", async () => {
  mocks.configure.mockImplementation(async () => {
    mocks.status = { ...mocks.status, revision: 1, mode: "api-key" };
    return AsyncResult.success(mocks.status);
  });
  await render();
  await act(() => button("API key connection").props.onClick());
  await act(() => {
    renderer.root
      .findByProps({ "aria-label": "Toolyard base URL" })
      .props.onChange({ target: { value: "https://toolyard.test" } });
    renderer.root
      .findByProps({ "aria-label": "Toolyard API key" })
      .props.onChange({ target: { value: "ag_test.local-secret" } });
  });
  expect(JSON.stringify(readToolyardSettingsDraft(key))).not.toContain("local-secret");
  await act(() => button("Save and connect").props.onClick());
  expect(mocks.configure.mock.calls[0]![0].input).toMatchObject({
    mode: "api-key",
    apiKey: "ag_test.local-secret",
    enabled: true,
  });
  expect(mocks.token).not.toHaveBeenCalled();
  expect(mocks.open).not.toHaveBeenCalled();
  expect(renderer.root.findByProps({ "aria-label": "Toolyard API key" }).props.value).toBe("");
  expect(readToolyardSettingsDraft(key)).toBeNull();
});
it.each(["invalid_api_key", "invalid_assertion"])(
  "retains public drafts and a retryable key after %s, then Discard clears both",
  async (code) => {
    mocks.configure.mockResolvedValue(failure(code));
    await render();
    await act(() => button("API key connection").props.onClick());
    await act(() =>
      renderer.root
        .findByProps({ "aria-label": "Toolyard API key" })
        .props.onChange({ target: { value: "ag_test.secret" } }),
    );
    await act(() => button("Save and connect").props.onClick());
    expect(readToolyardSettingsDraft(key)?.mode).toBe("api-key");
    expect(renderer.root.findByProps({ role: "alert" }).children.join("")).toContain(
      "Toolyard refused this API key",
    );
    expect(renderer.root.findByProps({ "aria-label": "Toolyard API key" }).props.value).toBe(
      "ag_test.secret",
    );
    expect(mocks.open).not.toHaveBeenCalled();
    await act(() => button("Discard").props.onClick());
    expect(readToolyardSettingsDraft(key)).toBeNull();
    expect(renderer.root.findAllByProps({ "aria-label": "Toolyard API key" })).toHaveLength(0);
  },
);
it("restores the public API mode after reload without recovering the secret", async () => {
  await render();
  await act(() => button("API key connection").props.onClick());
  await act(() =>
    renderer.root
      .findByProps({ "aria-label": "Toolyard API key" })
      .props.onChange({ target: { value: "ag_test.secret" } }),
  );
  await act(() => renderer.unmount());
  await render();
  expect(renderer.root.findByProps({ "aria-label": "Toolyard API key" }).props.value).toBe("");
  expect(readToolyardSettingsDraft(key)?.mode).toBe("api-key");
});
it("clears a secret when the authenticated user changes", async () => {
  await render();
  await act(() => button("API key connection").props.onClick());
  await act(() =>
    renderer.root
      .findByProps({ "aria-label": "Toolyard API key" })
      .props.onChange({ target: { value: "ag_test.secret" } }),
  );
  mocks.userId = "user_other";
  await act(() => renderer.update(<ToolyardSettingsSection />));
  await act(() => button("API key connection").props.onClick());
  expect(renderer.root.findByProps({ "aria-label": "Toolyard API key" }).props.value).toBe("");
});
it("disconnects only the current account through the user action", async () => {
  mocks.status = {
    ...mocks.status,
    administrator: false,
    mode: "api-key",
    baseUrl: "https://toolyard.test",
    enabled: true,
    connection: "connected",
  };
  mocks.configure.mockResolvedValue(AsyncResult.success(mocks.status));
  await render();
  await act(() => button("Disconnect my account").props.onClick());
  expect(mocks.configure.mock.calls[0]![0].input).toMatchObject({
    disconnect: true,
    mode: "api-key",
    remove: false,
  });
  expect(mocks.configure.mock.calls[0]![0].input).not.toHaveProperty("apiKey");
  expect(button("Remove instance")).toBeUndefined();
});

it("retains a public edit made while a successful Save request is pending", async () => {
  let complete!: () => void;
  const pending = new Promise<void>((resolve) => {
    complete = resolve;
  });
  mocks.configure.mockImplementation(async () => {
    await pending;
    mocks.status = {
      ...mocks.status,
      revision: 1,
      enabled: true,
      baseUrl: "https://toolyard.test",
    };
    return AsyncResult.success(mocks.status);
  });
  await render();
  await edit();
  await act(() => button("Save and verify trust").props.onClick());
  expect(mocks.configure).toHaveBeenCalledOnce();
  await act(() =>
    renderer.root.findByProps({ "aria-label": "Toolyard base URL" }).props.onChange({
      target: { value: "https://later-draft.test" },
    }),
  );
  await act(async () => {
    complete();
    await pending;
  });
  expect(readToolyardSettingsDraft(key)?.baseUrl).toBe("https://later-draft.test");
  expect(renderer.root.findByProps({ "aria-label": "Toolyard base URL" }).props.value).toBe(
    "https://later-draft.test",
  );
});
it("disables team access when the server has no verified team identity", async () => {
  mocks.status = { ...mocks.status, mode: "api-key", teamAvailable: false };
  await render();
  expect(button("Team connection").props.disabled).toBe(true);
  expect(button("API key connection").props.disabled).toBe(false);
  expect(mocks.token).not.toHaveBeenCalled();
});
it.each([
  ["api-key", "team", "Team connection", "Save and verify trust"],
  ["team", "api-key", "API key connection", "Save and connect"],
] as const)(
  "keeps the %s disconnect action after the draft selects %s",
  async (savedMode, nextMode, choice, saveLabel) => {
    mocks.status = {
      ...mocks.status,
      mode: savedMode,
      administrator: false,
      enabled: true,
      baseUrl: "https://toolyard.test",
      connection: "connected",
    };
    mocks.configure.mockImplementation(async () => {
      mocks.status = { ...mocks.status, connection: "revoked" };
      return AsyncResult.success(mocks.status);
    });
    await render();
    await act(() => button(choice).props.onClick());
    expect(button(saveLabel).props.disabled).toBe(true);
    expect(button("Disconnect my account").props.disabled).toBe(false);
    expect(renderer.root.findByProps({ role: "alert" }).children.join("")).toContain(
      "Disconnect my account",
    );
    await act(() => button("Disconnect my account").props.onClick());
    expect(mocks.configure.mock.calls[0]![0].input).toMatchObject({
      disconnect: true,
      remove: false,
    });
    expect(mocks.configure.mock.calls[0]![0].input).not.toHaveProperty("apiKey");
    expect(readToolyardSettingsDraft(key)?.mode).toBe(nextMode);
    expect(button("Remove instance")).toBeUndefined();
  },
);

it("targets the selected server and isolates its public draft, API key, and user identity", async () => {
  mocks.statusByEnvironment.set("env_mac", {
    ...mocks.status,
    mode: "api-key",
    teamAvailable: false,
    baseUrl: "https://toolyard.test",
    enabled: true,
  });
  mocks.sessionUsers.set("env_mac", null);
  await render();
  await act(() => button("API key connection").props.onClick());
  await act(() => {
    renderer.root
      .findByProps({ "aria-label": "Toolyard base URL" })
      .props.onChange({ target: { value: "https://stage-draft.test" } });
    renderer.root
      .findByProps({ "aria-label": "Toolyard API key" })
      .props.onChange({ target: { value: "ag_stage.stage-secret" } });
  });
  mocks.selectedIds = ["env_mac"];
  await act(() => renderer.update(<ToolyardSettingsSection />));
  expect(renderer.root.findByProps({ "aria-label": "Toolyard API key" }).props.value).toBe("");
  expect(renderer.root.findByProps({ "aria-label": "Toolyard base URL" }).props.value).toBe(
    "https://toolyard.test",
  );
  expect(mocks.statusQueries.mock.calls.at(-1)![0]).toMatchObject({
    environmentId: "env_mac",
    input: { userScope: "local-user" },
  });
  await act(() =>
    renderer.root
      .findByProps({ "aria-label": "Toolyard API key" })
      .props.onChange({ target: { value: "ag_mac.mac-secret" } }),
  );
  mocks.configure.mockResolvedValue(failure("invalid_api_key"));
  await act(() => button("Save and connect").props.onClick());
  expect(mocks.configure.mock.calls.at(-1)![0]).toMatchObject({
    environmentId: "env_mac",
    input: { apiKey: "ag_mac.mac-secret", mode: "api-key" },
  });
  expect(mocks.configure.mock.calls.at(-1)![0].input).not.toHaveProperty("adminToken");
  expect(mocks.token).not.toHaveBeenCalled();
  mocks.selectedIds = ["env_stage"];
  await act(() => renderer.update(<ToolyardSettingsSection />));
  expect(renderer.root.findByProps({ "aria-label": "Toolyard base URL" }).props.value).toBe(
    "https://stage-draft.test",
  );
  expect(renderer.root.findByProps({ "aria-label": "Toolyard API key" }).props.value).toBe("");
  expect(readToolyardSettingsDraft(key)?.baseUrl).toBe("https://stage-draft.test");
});
it("does not send the primary Clerk token to a server with a different authenticated user", async () => {
  mocks.sessionUsers.set("env_stage", "user_other");
  mocks.token.mockResolvedValue("primary-user-secret");
  await render();
  await edit();
  await act(() => button("Save and verify trust").props.onClick());
  expect(mocks.token).not.toHaveBeenCalled();
  expect(mocks.configure.mock.calls[0]![0].input).not.toHaveProperty("adminToken");
  const url = new URL(mocks.open.mock.calls[0]![0]);
  expect(JSON.parse(decodeURIComponent(url.hash.split("=")[1]!)).userId).toBe("user_other");
});
it("does not inspect Toolyard credentials before the selected server authenticates the client", async () => {
  mocks.sessionAuthenticated.set("env_stage", false);
  await render();
  expect(mocks.statusQueries).not.toHaveBeenCalled();
  expect(mocks.configure).not.toHaveBeenCalled();
});

it("applies a browser continuation only to its selected server when two servers are visible", async () => {
  mocks.selectedIds = ["env_stage", "env_other"];
  vi.stubGlobal("window", {
    ...window,
    location: { ...window.location, origin: "https://other.test" },
  });
  window.location.hash = new URL(
    createToolyardSettingsContinuation(
      "https://other.test",
      "env_other",
      "user_admin",
      {
        baseUrl: "https://other-toolyard.test",
        enabled: true,
        revision: 0,
      },
      Date.now(),
    ),
  ).hash;
  await render();
  const sections = renderer.root.findAllByType("section");
  expect(sections).toHaveLength(2);
  expect(sections[0]!.findByProps({ "aria-label": "Toolyard base URL" }).props.value).toBe("");
  expect(sections[1]!.findByProps({ "aria-label": "Toolyard base URL" }).props.value).toBe(
    "https://other-toolyard.test",
  );
  expect(readToolyardSettingsDraft(toolyardDraftKey("env_other", "user_admin"))?.baseUrl).toBe(
    "https://other-toolyard.test",
  );
  expect(readToolyardSettingsDraft(key)).toBeNull();
  expect(mocks.configure).not.toHaveBeenCalled();
});

it("lists and updates webhook destinations on each selected server under that server's user", async () => {
  mocks.selectedIds = ["env_stage", "env_mac"];
  mocks.sessionUsers.set("env_mac", null);
  mocks.webhookUpdate.mockResolvedValue(AsyncResult.success({}));
  await act(() => {
    renderer = create(<SessionWebhookSettingsSection />);
  });
  expect(mocks.webhookQueries.mock.calls.map(([input]) => input)).toEqual([
    { environmentId: "env_stage", input: { userScope: "user_admin" } },
    { environmentId: "env_mac", input: { userScope: "local-user" } },
  ]);
  const mac = renderer.root.findByProps({ "data-title": "Session webhooks — Mac" });
  const disable = mac.findAllByType("button").find((node) => node.children.includes("Disable"))!;
  await act(() => disable.props.onClick());
  expect(mocks.webhookUpdate.mock.calls[0]![0]).toMatchObject({
    environmentId: "env_mac",
    input: { id: "env_mac-hook", action: "disable", expectedRevision: 1 },
  });
});
