/** T3-CUSTOM(expbkt3): Paired clients request browser trust only after the exact server refusal. */
import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import * as Cause from "effect/Cause";
import { PersonalMcpSettingsError } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { createToolyardSettingsContinuation } from "@t3tools/client-runtime/toolyard-trust-setup";
const mocks = vi.hoisted(() => ({
  status: {
    mode: "team" as "team" | "api-key" | "host",
    hostConsentAllowed: true,
    hostName: "Test Mac",
    agentId: null as string | null,
    ownerId: null as string | null,
    pendingConnection: null as null | {
      requestId: string;
      authorizationUrl: string | null;
      expiresAt: string;
      status: "pending" | "approved" | "cancelled" | "rejected" | "expired";
      lastError: string | null;
    },
    apiKeyAllowed: true,
    teamAvailable: true,
    callbackTransport: "push" as "push" | "pull",
    revision: 0,
    revocationPending: 0,
    enabled: false,
    removed: false,
    baseUrl: null as string | null,
    instanceId: null as string | null,
    origin: null as string | null,
    administrator: true,
    connection: "not_connected",
    email: null as string | null,
    expiresAt: null as string | null,
  },
  userId: "user_admin",
  clerkUserId: "user_admin" as string | null,
  selectedIds: ["env_stage"],
  sessionUsers: new Map<string, string | null>(),
  sessionAuthenticated: new Map<string, boolean>(),
  statusByEnvironment: new Map<string, object>(),
  statusQueries: vi.fn(),
  configure: vi.fn(),
  handoff: vi.fn(),
  token: vi.fn(),
  open: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: unknown) => {
    if (atom === "clerk-user") return mocks.clerkUserId;
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
    configureToolyardIntegration: "configure",
    openToolyardDashboard: "handoff",
  },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: string) =>
    command === "configure" ? mocks.configure : command === "handoff" ? mocks.handoff : vi.fn(),
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
vi.mock("../ui/badge", () => ({
  Badge: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../ui/input", () => ({ Input: (props: object) => <input {...props} /> }));
vi.mock("../ui/switch", () => ({
  Switch: (props: object) => <button data-testid="switch" {...props} />,
}));
// Folds keep their panels mounted, as the component requests with keepMounted.
vi.mock("../ui/collapsible", async () => {
  const { createContext, useContext } = await import("react");
  const Fold = createContext({ open: false, onOpenChange: (_open: boolean) => {} });
  return {
    Collapsible: ({
      open,
      onOpenChange,
      children,
    }: {
      open: boolean;
      onOpenChange: (open: boolean) => void;
      children: ReactNode;
    }) => <Fold value={{ open, onOpenChange }}>{children}</Fold>,
    CollapsibleTrigger: ({
      children,
      render: _render,
      ...props
    }: {
      children: ReactNode;
      render?: unknown;
    }) => {
      const fold = useContext(Fold);
      return (
        <button {...props} aria-expanded={fold.open} onClick={() => fold.onOpenChange(!fold.open)}>
          {children}
        </button>
      );
    },
    CollapsiblePanel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  };
});
vi.mock("../ui/radio-group", async () => {
  const { createContext, useContext } = await import("react");
  const Group = createContext({
    value: undefined as unknown,
    disabled: false as boolean | undefined,
    onValueChange: (_value: unknown) => {},
  });
  return {
    RadioGroup: ({
      value,
      disabled,
      onValueChange,
      children,
    }: {
      value: unknown;
      disabled?: boolean;
      onValueChange: (value: unknown) => void;
      children: ReactNode;
    }) => (
      <Group value={{ value, disabled, onValueChange }}>
        <div role="radiogroup">{children}</div>
      </Group>
    ),
    Radio: ({ value, disabled }: { value: string; disabled?: boolean }) => {
      const group = useContext(Group);
      return (
        <button
          role="radio"
          value={value}
          aria-checked={group.value === value}
          disabled={Boolean(disabled || group.disabled)}
          onClick={() => group.onValueChange(value)}
        />
      );
    },
  };
});
vi.mock("../ui/alert-dialog", async () => {
  const { createContext, useContext } = await import("react");
  const Close = createContext((_open: boolean) => {});
  const Pass = ({ children }: { children: ReactNode }) => <>{children}</>;
  return {
    AlertDialog: ({
      open,
      onOpenChange,
      children,
    }: {
      open: boolean;
      onOpenChange: (open: boolean) => void;
      children: ReactNode;
    }) =>
      open ? (
        <Close value={onOpenChange}>
          <div role="alertdialog">{children}</div>
        </Close>
      ) : null,
    AlertDialogPopup: Pass,
    AlertDialogHeader: Pass,
    AlertDialogFooter: Pass,
    AlertDialogTitle: Pass,
    AlertDialogDescription: Pass,
    AlertDialogClose: ({ children }: { children: ReactNode }) => {
      const close = useContext(Close);
      return <button onClick={() => close(false)}>{children}</button>;
    },
  };
});
vi.mock("./settingsLayout", () => ({
  SettingsSection: ({
    children,
    title,
    headerAction,
  }: {
    children: ReactNode;
    title: string;
    headerAction?: ReactNode;
  }) => (
    <section data-title={title}>
      {headerAction}
      {children}
    </section>
  ),
  SettingsRow: ({ children, control }: { children: ReactNode; control: ReactNode }) => (
    <div>
      {children}
      {control}
    </div>
  ),
}));
import { EnvironmentToolyardSettings, ToolyardSettingsSection } from "./ToolyardSettingsSection";
import { readToolyardSettingsDraft, toolyardDraftKey } from "../../fork/toolyardSettingsDraft";
let renderer: ReactTestRenderer;
const key = toolyardDraftKey("env_stage", "user_admin");
const failure = (code: string) =>
  AsyncResult.failure(
    Cause.fail(new PersonalMcpSettingsError({ operation: "Toolyard integration", message: code })),
  );
const pendingRequest = (
  status: "pending" | "approved" | "cancelled" | "rejected" | "expired" = "pending",
) => ({
  requestId: "host-request-0123456789",
  authorizationUrl: "https://toolyard.test/connections/authorize?request=reference",
  expiresAt: "2099-01-01T00:00:00Z",
  status,
  lastError: null,
});
function button(name: string) {
  return renderer.root.findAllByType("button").find((node) => node.children.includes(name))!;
}
function method(value: "team" | "api-key" | "host") {
  return renderer.root.findAll(
    (node) => node.type === "button" && node.props.role === "radio" && node.props.value === value,
  )[0]!;
}
function dialog() {
  return renderer.root.findAllByProps({ role: "alertdialog" })[0];
}
function dialogButton(name: string) {
  return dialog()!
    .findAllByType("button")
    .find((node) => node.children.includes(name))!;
}
function fold(name: string) {
  return renderer.root
    .findAllByType("button")
    .find((node) => node.props["aria-expanded"] !== undefined && node.children.includes(name))!;
}
const text = () => JSON.stringify(renderer.toJSON());
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
    hostConsentAllowed: true,
    pendingConnection: null,
    ownerId: null,
    agentId: null,
    teamAvailable: true,
    administrator: true,
    revision: 0,
    enabled: false,
    baseUrl: null,
    removed: false,
    connection: "not_connected",
    email: null,
    expiresAt: null,
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
  await act(() => method("api-key").props.onClick());
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
    await act(() => method("api-key").props.onClick());
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
  await act(() => method("api-key").props.onClick());
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
  await act(() => method("api-key").props.onClick());
  await act(() =>
    renderer.root
      .findByProps({ "aria-label": "Toolyard API key" })
      .props.onChange({ target: { value: "ag_test.secret" } }),
  );
  mocks.userId = "user_other";
  await act(() => renderer.update(<ToolyardSettingsSection />));
  await act(() => method("api-key").props.onClick());
  expect(renderer.root.findByProps({ "aria-label": "Toolyard API key" }).props.value).toBe("");
});
it("disconnects only the current account after confirmation", async () => {
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
  expect(mocks.configure).not.toHaveBeenCalled();
  await act(() => dialogButton("Disconnect").props.onClick());
  expect(mocks.configure.mock.calls[0]![0].input).toMatchObject({
    disconnect: true,
    mode: "api-key",
    remove: false,
  });
  expect(mocks.configure.mock.calls[0]![0].input).not.toHaveProperty("apiKey");
  expect(button("Remove instance")).toBeUndefined();
});
it("sends no disconnect when the confirmation is cancelled, and keeps a refused disconnect visible", async () => {
  mocks.status = {
    ...mocks.status,
    administrator: false,
    mode: "host",
    revision: 5,
    baseUrl: "https://toolyard.test",
    enabled: true,
    connection: "connected",
  };
  mocks.configure.mockResolvedValue(failure("settings_revision_conflict"));
  await render();
  await act(() => button("Disconnect my account").props.onClick());
  expect(dialog()).toBeDefined();
  await act(() => dialogButton("Cancel").props.onClick());
  expect(dialog()).toBeUndefined();
  expect(mocks.configure).not.toHaveBeenCalled();
  await act(() => button("Disconnect my account").props.onClick());
  await act(() => dialogButton("Disconnect").props.onClick());
  expect(mocks.configure).toHaveBeenCalledOnce();
  expect(mocks.configure.mock.calls[0]![0].input).toMatchObject({
    disconnect: true,
    expectedRevision: 5,
  });
  expect(renderer.root.findByProps({ role: "alert" }).children.join("")).toContain(
    "The server settings changed",
  );
  expect(text()).toContain("Connected");
});
it("removes the instance only after the administrator confirms, with the expected revision", async () => {
  mocks.status = {
    ...mocks.status,
    revision: 4,
    baseUrl: "https://toolyard.test",
    enabled: true,
    connection: "connected",
  };
  mocks.configure.mockResolvedValue(
    AsyncResult.success({ ...mocks.status, removed: true, enabled: false, revision: 5 }),
  );
  await render();
  // A team connection has no personal disconnect until another method is chosen.
  expect(button("Disconnect my account")).toBeUndefined();
  await act(() => button("Remove instance").props.onClick());
  await act(() => dialogButton("Cancel").props.onClick());
  expect(mocks.configure).not.toHaveBeenCalled();
  await act(() => button("Remove instance").props.onClick());
  await act(() => dialogButton("Remove instance").props.onClick());
  expect(mocks.configure.mock.calls[0]![0].input).toMatchObject({
    remove: true,
    expectedRevision: 4,
  });
  expect(mocks.configure.mock.calls[0]![0].input).not.toHaveProperty("disconnect");
  expect(dialog()).toBeUndefined();
});
it("shows an approved request on a connected account as history, with Open Toolyard and no Connect action", async () => {
  mocks.status = {
    ...mocks.status,
    administrator: false,
    mode: "host",
    baseUrl: "https://toolyard.test",
    enabled: true,
    connection: "connected",
    email: "dev@beknown.work",
    agentId: "agent_0123456789abcdef",
    ownerId: "owner_0123456789abcdef",
    pendingConnection: pendingRequest("approved"),
  };
  mocks.handoff.mockResolvedValue(
    AsyncResult.success({ url: "https://toolyard.test/handoff?code=x", expiresAt: "2099" }),
  );
  await render();
  expect(text()).toContain("Connected");
  expect(text()).toContain("dev@beknown.work");
  expect(text()).not.toContain("Awaiting");
  expect(text()).not.toContain("Connection request:");
  for (const label of [
    "Connect my Toolyard account",
    "Start a new request",
    "Open account consent",
    "Save and verify trust",
    "Discard",
  ])
    expect(button(label)).toBeUndefined();
  // Summaries abbreviate identifiers; details keep the full values and the finished request.
  expect(text()).toContain("agent_01…");
  expect(text()).toContain("agent_0123456789abcdef");
  expect(text()).toContain("owner_0123456789abcdef");
  expect(text()).toContain("Approved");
  expect(fold("Connection details").props["aria-expanded"]).toBe(false);
  await act(() => button("Open Toolyard").props.onClick());
  expect(mocks.open).toHaveBeenCalledWith("https://toolyard.test/handoff?code=x");
  expect(mocks.configure).not.toHaveBeenCalled();
});
it("offers account consent while a request is pending and no routine save without a draft", async () => {
  mocks.status = {
    ...mocks.status,
    administrator: false,
    mode: "host",
    baseUrl: "https://toolyard.test",
    enabled: true,
    pendingConnection: pendingRequest(),
  };
  await render();
  expect(text()).toContain("Awaiting your decision");
  expect(button("Connect my Toolyard account")).toBeUndefined();
  await act(() => button("Open account consent").props.onClick());
  expect(mocks.open).toHaveBeenCalledWith(
    "https://toolyard.test/connections/authorize?request=reference",
  );
});
it("starts a new consent request after a rejected one", async () => {
  mocks.status = {
    ...mocks.status,
    administrator: false,
    mode: "host",
    baseUrl: "https://toolyard.test",
    enabled: true,
    pendingConnection: pendingRequest("rejected"),
  };
  mocks.configure.mockResolvedValue(AsyncResult.success(mocks.status));
  await render();
  expect(text()).toContain("Request rejected");
  await act(() => button("Start a new request").props.onClick());
  expect(mocks.configure.mock.calls[0]![0].input).toMatchObject({
    mode: "host",
    hostAction: "begin",
  });
});
it("shows an outage as unavailable with Retry, never as revoked access", async () => {
  mocks.status = {
    ...mocks.status,
    administrator: false,
    mode: "api-key",
    baseUrl: "https://toolyard.test",
    enabled: true,
    connection: "unavailable",
    email: "dev@beknown.work",
  };
  await render();
  expect(text()).toContain("Status unavailable");
  expect(text()).not.toContain("Access revoked");
  expect(button("Save and connect")).toBeUndefined();
  expect(button("Open Toolyard")).toBeUndefined();
  await act(() => button("Retry").props.onClick());
  expect(mocks.refresh).toHaveBeenCalledOnce();
});
it("opens server setup for a draft, keeps the draft when the fold closes, and shows conflicts outside it", async () => {
  mocks.status = {
    ...mocks.status,
    revision: 2,
    baseUrl: "https://toolyard.test",
    enabled: true,
    connection: "connected",
  };
  await render();
  expect(fold("Server setup — administrator").props["aria-expanded"]).toBe(false);
  expect(button("Save and verify trust")).toBeUndefined();
  await act(() =>
    renderer.root
      .findByProps({ "aria-label": "Toolyard base URL" })
      .props.onChange({ target: { value: "https://next.test" } }),
  );
  expect(fold("Server setup — administrator").props["aria-expanded"]).toBe(true);
  await act(() => fold("Server setup — administrator").props.onClick());
  expect(fold("Server setup — administrator").props["aria-expanded"]).toBe(false);
  expect(renderer.root.findByProps({ "aria-label": "Toolyard base URL" }).props.value).toBe(
    "https://next.test",
  );
  expect(button("Save and verify trust").props.disabled).toBe(false);
  mocks.status = { ...mocks.status, revision: 3 };
  await act(() => renderer.update(<ToolyardSettingsSection />));
  expect(renderer.root.findByProps({ role: "alert" }).findByType("p").children.join("")).toContain(
    "revision 2",
  );
  await act(() => button("Use current revision").props.onClick());
  expect(readToolyardSettingsDraft(key)).toMatchObject({
    baseUrl: "https://next.test",
    revision: 3,
  });
});
it("disables team access when the server has no verified team identity", async () => {
  mocks.status = { ...mocks.status, mode: "api-key", teamAvailable: false };
  await render();
  expect(method("team").props.disabled).toBe(true);
  expect(method("api-key").props.disabled).toBe(false);
  expect(text()).toContain("no verified team identity");
  expect(mocks.token).not.toHaveBeenCalled();
});
it.each([
  ["api-key", "team", "Save and verify trust"],
  ["team", "api-key", "Save and connect"],
] as const)(
  "keeps the %s disconnect action after the draft selects %s",
  async (savedMode, nextMode, saveLabel) => {
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
    expect(fold("Manage connection").props["aria-expanded"]).toBe(false);
    await act(() => method(nextMode).props.onClick());
    // The method change needs a disconnect first, so its fold opens and the warning stays outside.
    expect(fold("Manage connection").props["aria-expanded"]).toBe(true);
    expect(button(saveLabel).props.disabled).toBe(true);
    expect(button("Disconnect my account").props.disabled).toBe(false);
    expect(renderer.root.findByProps({ role: "alert" }).children.join("")).toContain(
      "Disconnect my account",
    );
    await act(() => button("Disconnect my account").props.onClick());
    await act(() => dialogButton("Disconnect").props.onClick());
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
  await act(() => method("api-key").props.onClick());
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
  expect(text()).toContain("All clients authorized for this local profile");
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

it("uses the grouped title and Refresh, and re-reads status when the group refreshes", async () => {
  const environment = {
    environmentId: "env_stage",
    label: "Stage",
    serverConfig: {
      auth: { clerk: {} },
      settings: { experimental: { externalMcp: { publicUrl: null } } },
    },
  } as unknown as Parameters<typeof EnvironmentToolyardSettings>[0]["environment"];
  await act(() => {
    renderer = create(
      <EnvironmentToolyardSettings environment={environment} compact refreshVersion={0} />,
    );
  });
  expect(renderer.root.findByType("section").props["data-title"]).toBe("Toolyard");
  expect(button("Refresh")).toBeUndefined();
  expect(mocks.refresh).not.toHaveBeenCalled();
  await act(() =>
    renderer.update(
      <EnvironmentToolyardSettings environment={environment} compact refreshVersion={1} />,
    ),
  );
  expect(mocks.refresh).toHaveBeenCalledOnce();
  await act(() => renderer.update(<EnvironmentToolyardSettings environment={environment} />));
  expect(renderer.root.findByType("section").props["data-title"]).toBe("Toolyard — Stage");
  expect(button("Refresh")).toBeDefined();
});

it("opens host account consent with no copied API key or Clerk token", async () => {
  mocks.selectedIds = ["env_mac"];
  mocks.sessionUsers.set("env_mac", null);
  mocks.status = {
    ...mocks.status,
    mode: "host",
    teamAvailable: false,
    baseUrl: "https://toolyard.test",
    enabled: true,
  };
  mocks.configure.mockResolvedValue(
    AsyncResult.success({
      ...mocks.status,
      pendingConnection: {
        requestId: "host-request",
        authorizationUrl: "https://toolyard.test/connections/authorize?request=public-reference",
        expiresAt: "2099-01-01T00:00:00Z",
        status: "pending",
        lastError: null,
      },
    }),
  );
  await render();
  await act(() => button("Connect my Toolyard account").props.onClick());
  expect(mocks.configure.mock.calls[0]![0]).toMatchObject({
    environmentId: "env_mac",
    input: { mode: "host", hostAction: "begin", enabled: true },
  });
  expect(mocks.configure.mock.calls[0]![0].input).not.toHaveProperty("apiKey");
  expect(mocks.configure.mock.calls[0]![0].input).not.toHaveProperty("adminToken");
  expect(mocks.token).not.toHaveBeenCalled();
  expect(mocks.open).toHaveBeenCalledWith(
    "https://toolyard.test/connections/authorize?request=public-reference",
  );
});
it("retains a failed host draft through navigation and reload", async () => {
  await render();
  await edit();
  await act(() => method("host").props.onClick());
  mocks.configure.mockResolvedValue(failure("instance_unavailable"));
  await act(() => button("Connect my Toolyard account").props.onClick());
  expect(readToolyardSettingsDraft(key)).toEqual({
    baseUrl: "https://toolyard.test",
    enabled: true,
    revision: 0,
    mode: "host",
  });
  await act(() => renderer.unmount());
  await render();
  expect(method("host").props["aria-checked"]).toBe(true);
  expect(renderer.root.findAllByProps({ role: "alert" }).length).toBe(0);
});
it("refuses a consent destination from another Toolyard instance", async () => {
  mocks.status = { ...mocks.status, mode: "host", baseUrl: "https://toolyard.test", enabled: true };
  mocks.configure.mockResolvedValue(
    AsyncResult.success({
      ...mocks.status,
      pendingConnection: {
        requestId: "host-request",
        authorizationUrl: "https://other.test/connections/authorize?request=reference",
        expiresAt: "2099-01-01T00:00:00Z",
        status: "pending",
        lastError: null,
      },
    }),
  );
  await render();
  await act(() => button("Connect my Toolyard account").props.onClick());
  expect(mocks.open).not.toHaveBeenCalled();
  expect(renderer.root.findAllByProps({ role: "alert" }).length).toBeGreaterThan(0);
});
it("cancels only the committed request and preserves a newer settings draft", async () => {
  mocks.status = {
    ...mocks.status,
    mode: "host",
    revision: 3,
    baseUrl: "https://toolyard.test",
    enabled: true,
    pendingConnection: pendingRequest(),
  };
  mocks.configure.mockResolvedValue(AsyncResult.success(mocks.status));
  await render();
  await act(() =>
    renderer.root
      .findByProps({ "aria-label": "Toolyard base URL" })
      .props.onChange({ target: { value: "https://new-draft.test" } }),
  );
  await act(() => method("api-key").props.onClick());
  await act(() => button("Cancel connection request").props.onClick());
  expect(mocks.configure.mock.calls[0]![0].input).toMatchObject({
    expectedRevision: 3,
    baseUrl: "https://toolyard.test",
    mode: "host",
    hostAction: "cancel",
  });
  expect(readToolyardSettingsDraft(key)).toMatchObject({
    baseUrl: "https://new-draft.test",
    mode: "api-key",
  });
});

it("clears the consent instruction after a pending request becomes connected", async () => {
  mocks.status = {
    ...mocks.status,
    administrator: false,
    mode: "host",
    baseUrl: "https://toolyard.test",
    enabled: true,
  };
  mocks.configure.mockResolvedValue(
    AsyncResult.success({ ...mocks.status, pendingConnection: pendingRequest() }),
  );
  await render();
  await act(() => button("Connect my Toolyard account").props.onClick());
  mocks.status = { ...mocks.status, pendingConnection: pendingRequest() };
  await act(() => renderer.update(<ToolyardSettingsSection />));
  expect(text()).toContain("Awaiting your Toolyard account decision");
  mocks.status = {
    ...mocks.status,
    connection: "connected",
    pendingConnection: pendingRequest("approved"),
  };
  await act(() => renderer.update(<ToolyardSettingsSection />));
  expect(text()).toContain("Connected");
  expect(text()).not.toContain("Awaiting your Toolyard account decision");
  expect(text()).not.toContain("Review the account and host");
  expect(button("Connect my Toolyard account")).toBeUndefined();
});
it("does not offer an ineffective team reconnect through a settings save", async () => {
  mocks.status = {
    ...mocks.status,
    mode: "team",
    enabled: true,
    baseUrl: "https://toolyard.test",
    connection: "revoked",
    revision: 4,
  };
  await render();
  expect(button("Save and verify trust")).toBeUndefined();
  expect(text()).toContain("A settings save does not restore revoked access");
  expect(method("host")).toBeDefined();
  expect(mocks.configure).not.toHaveBeenCalled();
});
