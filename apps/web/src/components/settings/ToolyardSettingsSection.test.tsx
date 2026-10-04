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
  configure: vi.fn(),
  token: vi.fn(),
  open: vi.fn(),
  refresh: vi.fn(),
  atom: {},
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => AsyncResult.success(mocks.status) }));
vi.mock("../../state/identity", () => ({ useCurrentUserId: () => mocks.userId }));
vi.mock("../../state/environments", () => ({ usePrimaryEnvironmentId: () => "env_stage" }));
vi.mock("../../state/session", () => ({
  readPreparedConnection: () => ({ httpBaseUrl: "https://stage.test" }),
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    toolyardIntegrationStatus: () => mocks.atom,
    configureToolyardIntegration: "configure",
    openToolyardDashboard: "handoff",
  },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: string) => (command === "configure" ? mocks.configure : vi.fn()),
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
  SettingsSection: ({ children }: { children: ReactNode }) => <section>{children}</section>,
  SettingsRow: ({ children, control }: { children: ReactNode; control: ReactNode }) => (
    <div>
      {children}
      {control}
    </div>
  ),
}));
import { ToolyardSettingsSection } from "./ToolyardSettingsSection";
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
  mocks.status = { ...mocks.status, revision: 0, enabled: false, baseUrl: null, removed: false };
  mocks.userId = "user_admin";
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
