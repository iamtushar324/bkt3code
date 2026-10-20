/** T3-CUSTOM(expbkt3): Paired clients request browser trust only after the exact server refusal. */
import type { ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import * as Cause from "effect/Cause";
import { PersonalMcpSettingsError } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { createToolyardSettingsContinuation } from "@t3tools/client-runtime/toolyard-trust-setup";
import { act, render, stubGlobal } from "../../../test/render";
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
  // The page origin the component compares a continuation against. A browser test cannot
  // change its real origin, so the continuation reader sees this one instead.
  pageOrigin: "https://stage.test",
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
// The state factories replace their modules outright instead of spreading the originals:
// the section reads only these members, and the real modules build live atoms.
vi.mock(import("@effect/atom-react"), () => ({
  useAtomValue: ((atom: unknown) => {
    if (atom === "clerk-user") return mocks.clerkUserId;
    const environmentId = (atom as { environmentId?: string }).environmentId;
    return AsyncResult.success(mocks.statusByEnvironment.get(environmentId ?? "") ?? mocks.status);
  }) as never,
}));
vi.mock(import("../../state/identity"), () => ({ currentClerkUserAtom: "clerk-user" as never }));
vi.mock(import("./SettingsScopeContext"), async (original) => ({
  ...(await original()),
  useSettingsScope: (() => ({
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
  })) as never,
}));
vi.mock(import("../../state/session"), () => ({
  readPreparedConnection: ((environmentId: string) => ({
    httpBaseUrl: environmentId === "env_mac" ? "http://127.0.0.1:4312" : "https://stage.test",
  })) as never,
  useEnvironmentSessionState: ((environmentId: string) => ({
    data: {
      authenticated: mocks.sessionAuthenticated.get(environmentId) ?? true,
      userId: mocks.sessionUsers.has(environmentId)
        ? mocks.sessionUsers.get(environmentId)
        : mocks.userId,
    },
  })) as never,
}));
vi.mock(import("../../state/server"), () => ({
  serverEnvironment: {
    toolyardIntegrationStatus: (input: { environmentId: string; input: { userScope: string } }) => {
      mocks.statusQueries(input);
      return { environmentId: input.environmentId };
    },
    configureToolyardIntegration: "configure",
    openToolyardDashboard: "handoff",
  } as never,
}));
vi.mock(import("../../state/use-atom-command"), () => ({
  useAtomCommand: ((command: string) =>
    command === "configure"
      ? mocks.configure
      : command === "handoff"
        ? mocks.handoff
        : vi.fn()) as never,
}));
vi.mock(import("../../state/teamIdentityToken"), () => ({
  readTeamClerkToken: (() => mocks.token()) as never,
}));
vi.mock(import("../../rpc/atomRegistry"), () => ({
  appAtomRegistry: { refresh: mocks.refresh } as never,
}));
vi.mock(import("../../hooks/useSettings"), () => ({
  usePrimarySettings: (() => "https://stale-mcp.test") as never,
}));
vi.mock(import("../../fork/managedEnvironment"), async (original) => ({
  ...(await original()),
  readBkManagedEnvironment: (() => ({ httpBaseUrl: "https://stable.test" })) as never,
}));
vi.mock(import("../../fork/toolyardBrowserHandoff"), async (original) => ({
  ...(await original()),
  createToolyardBrowserHandoffTarget: () => ({ open: mocks.open, close: vi.fn() }),
}));
vi.mock(import("@t3tools/client-runtime/toolyard-trust-setup"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    readToolyardSettingsContinuation: ((
      ...args: Parameters<typeof actual.readToolyardSettingsContinuation>
    ) => {
      const [fragment, environmentId, userScope, _pageOrigin, draft, now] = args;
      return actual.readToolyardSettingsContinuation(
        fragment,
        environmentId,
        userScope,
        mocks.pageOrigin,
        draft,
        now,
      );
    }) as never,
  };
});
// The UI stand-ins render every fold and dialog inline, so the tests query one tree.
vi.mock(import("../ui/button"), async (original) => ({
  ...(await original()),
  Button: (({ children, ...props }: { children: ReactNode }) => (
    <button {...props}>{children}</button>
  )) as never,
}));
vi.mock(import("../ui/badge"), async (original) => ({
  ...(await original()),
  Badge: (({ children }: { children: ReactNode }) => <span>{children}</span>) as never,
}));
vi.mock(import("../ui/input"), async (original) => ({
  ...(await original()),
  Input: ((props: object) => <input {...props} />) as never,
}));
// A click asks for the opposite state, as the real switch does.
vi.mock(import("../ui/switch"), async (original) => ({
  ...(await original()),
  Switch: (({
    checked,
    onCheckedChange,
    ...props
  }: {
    checked?: boolean;
    onCheckedChange: (checked: boolean) => void;
  }) => (
    <button
      {...props}
      data-testid="switch"
      role="switch"
      aria-checked={Boolean(checked)}
      onClick={() => onCheckedChange(!checked)}
    />
  )) as never,
}));
// Folds keep their panels mounted, as the component requests with keepMounted.
vi.mock(import("../ui/collapsible"), async (original) => {
  const { createContext, useContext } = await import("react");
  const Fold = createContext({ open: false, onOpenChange: (_open: boolean) => {} });
  return {
    ...(await original()),
    Collapsible: (({
      open,
      onOpenChange,
      children,
    }: {
      open: boolean;
      onOpenChange: (open: boolean) => void;
      children: ReactNode;
    }) => <Fold value={{ open, onOpenChange }}>{children}</Fold>) as never,
    CollapsibleTrigger: (({
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
    }) as never,
    CollapsiblePanel: (({ children }: { children: ReactNode }) => <div>{children}</div>) as never,
  };
});
vi.mock(import("../ui/radio-group"), async (original) => {
  const { createContext, useContext } = await import("react");
  const Group = createContext({
    value: undefined as unknown,
    disabled: false as boolean | undefined,
    onValueChange: (_value: unknown) => {},
  });
  return {
    ...(await original()),
    RadioGroup: (({
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
    )) as never,
    Radio: (({ value, disabled }: { value: string; disabled?: boolean }) => {
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
    }) as never,
  };
});
vi.mock(import("../ui/alert-dialog"), async (original) => {
  const { createContext, useContext } = await import("react");
  const Close = createContext((_open: boolean) => {});
  const Pass = (({ children }: { children: ReactNode }) => <>{children}</>) as never;
  return {
    ...(await original()),
    AlertDialog: (({
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
      ) : null) as never,
    AlertDialogPopup: Pass,
    AlertDialogHeader: Pass,
    AlertDialogFooter: Pass,
    AlertDialogTitle: Pass,
    AlertDialogDescription: Pass,
    AlertDialogClose: (({ children }: { children: ReactNode }) => {
      const close = useContext(Close);
      return <button onClick={() => close(false)}>{children}</button>;
    }) as never,
  };
});
vi.mock(import("./settingsLayout"), async (original) => ({
  ...(await original()),
  SettingsSection: (({
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
  )) as never,
  SettingsRow: (({ children, control }: { children: ReactNode; control: ReactNode }) => (
    <div>
      {children}
      {control}
    </div>
  )) as never,
}));
import { EnvironmentToolyardSettings, ToolyardSettingsSection } from "./ToolyardSettingsSection";
import { readToolyardSettingsDraft, toolyardDraftKey } from "../../fork/toolyardSettingsDraft";
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
const setNativeInputValue = Object.getOwnPropertyDescriptor(
  HTMLInputElement.prototype,
  "value",
)!.set!;
/** Like the renderer's findBy*: exactly one match. */
function onlyIn<T extends Element = HTMLElement>(scope: ParentNode, selector: string): T {
  const matches = scope.querySelectorAll<T>(selector);
  expect(matches).toHaveLength(1);
  return matches[0]!;
}
/** A control whose own text is exactly `name`, as its label child rather than nested text. */
const hasOwnText = (node: Element, name: string) =>
  [...node.childNodes].some(
    (child) => child.nodeType === Node.TEXT_NODE && child.textContent === name,
  );
function buttonIn(scope: ParentNode, name: string) {
  return [...scope.querySelectorAll("button")].find((node) => hasOwnText(node, name));
}
const expanded = (node: Element | undefined) => node!.getAttribute("aria-expanded");
async function click(node: HTMLElement | undefined) {
  expect(node).toBeDefined();
  await act(async () => {
    node!.click();
  });
}
function setHash(hash: string) {
  window.history.replaceState(window.history.state, "", hash);
}
/** Resets the shared mock state and stubs the globals the section reads, for one test. */
function setup(): Disposable {
  vi.clearAllMocks();
  const stack = new DisposableStack();
  const initialUrl = window.location.href;
  stack.defer(() => window.history.replaceState(window.history.state, "", initialUrl));
  const store = new Map<string, string>();
  stack.use(stubGlobal("desktopBridge", {}));
  stack.use(
    stubGlobal("sessionStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
      removeItem: (key: string) => store.delete(key),
    }),
  );
  mocks.pageOrigin = "https://stage.test";
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
  return stack;
}
/** Renders the section with queries scoped to its container. */
async function mount(ui: ReactNode = <ToolyardSettingsSection />) {
  // The section uses no links or router hooks; it reads the continuation from window.location.
  const screen = await render(ui, { router: false });
  const { container } = screen;
  function only<T extends Element = HTMLElement>(selector: string, scope: ParentNode = container) {
    return onlyIn<T>(scope, selector);
  }
  const button = (name: string) => buttonIn(container, name);
  const method = (value: "team" | "api-key" | "host") =>
    container.querySelector<HTMLButtonElement>(`button[role="radio"][value="${value}"]`) ??
    undefined;
  const dialog = () => container.querySelector('[role="alertdialog"]') ?? undefined;
  const dialogButton = (name: string) => buttonIn(dialog()!, name);
  const fold = (name: string) =>
    [...container.querySelectorAll<HTMLElement>("button[aria-expanded]")].find((node) =>
      hasOwnText(node, name),
    );
  const input = (label: string, scope?: ParentNode) =>
    only<HTMLInputElement>(`input[aria-label="${label}"]`, scope);
  const inputs = (label: string) => container.querySelectorAll(`input[aria-label="${label}"]`);
  const alertText = () => only('[role="alert"]').textContent;
  const alerts = () => container.querySelectorAll('[role="alert"]');
  // Markup, not just text, so attributes count too, as the rendered tree's JSON did.
  const text = () => container.innerHTML;
  async function type(label: string, value: string) {
    const target = input(label);
    // React tracks the last value it saw on the element, so set it through the native setter.
    setNativeInputValue.call(target, value);
    await act(async () => {
      target.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  async function edit() {
    await type("Toolyard base URL", "https://toolyard.test");
    await click(only('[data-testid="switch"]'));
  }
  return Object.assign(screen, {
    only,
    button,
    method,
    dialog,
    dialogButton,
    fold,
    input,
    inputs,
    alertText,
    alerts,
    text,
    type,
    edit,
  });
}
it("first calls configure without a token, opens only the exact refused setup in the default browser, and retains edited drafts", async () => {
  using _setup = setup();
  await using view = await mount();
  await view.edit();
  await click(view.button("Save and verify trust"));
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
  await view.type("Toolyard base URL", "https://new-draft.test");
  mocks.status = { ...mocks.status, revision: 1, enabled: true, baseUrl: "https://toolyard.test" };
  await view.rerender(<ToolyardSettingsSection />);
  expect(readToolyardSettingsDraft(key)?.baseUrl).toBe("https://new-draft.test");
});
it("clears only an unchanged draft after a matching advanced server result", async () => {
  using _setup = setup();
  await using view = await mount();
  await view.edit();
  await click(view.button("Save and verify trust"));
  mocks.status = {
    ...mocks.status,
    revision: 1,
    enabled: false,
    baseUrl: "https://different.test",
  };
  await view.rerender(<ToolyardSettingsSection />);
  expect(readToolyardSettingsDraft(key)).not.toBeNull();
  mocks.status = { ...mocks.status, revision: 2, enabled: true, baseUrl: "https://toolyard.test" };
  await view.rerender(<ToolyardSettingsSection />);
  expect(readToolyardSettingsDraft(key)).toBeNull();
});
it.each(["settings_revision_conflict", "administrator_required", "unknown secret"])(
  "does not open a browser for %s",
  async (code) => {
    using _setup = setup();
    mocks.configure.mockResolvedValue(failure(code));
    await using view = await mount();
    await view.edit();
    await click(view.button("Save and verify trust"));
    expect(mocks.open).not.toHaveBeenCalled();
    expect(readToolyardSettingsDraft(key)).not.toBeNull();
  },
);
it("does not open a browser after a successful token-free setting change", async () => {
  using _setup = setup();
  mocks.configure.mockResolvedValue(AsyncResult.success({ ...mocks.status, revision: 1 }));
  await using view = await mount();
  await view.edit();
  await click(view.button("Save and verify trust"));
  expect(mocks.open).not.toHaveBeenCalled();
  expect(readToolyardSettingsDraft(key)).toBeNull();
});
it("prefills an authenticated browser draft without any configure call until explicit Save", async () => {
  using _setup = setup();
  setHash(
    new URL(
      createToolyardSettingsContinuation(
        "https://stage.test",
        "env_stage",
        "user_admin",
        { baseUrl: "https://toolyard.test", enabled: true, revision: 0 },
        Date.now(),
      ),
    ).hash,
  );
  mocks.token.mockResolvedValue("fresh-browser-token");
  mocks.configure.mockResolvedValue(AsyncResult.success({ ...mocks.status, revision: 1 }));
  await using view = await mount();
  expect(mocks.configure).not.toHaveBeenCalled();
  expect(view.input("Toolyard base URL").value).toBe("https://toolyard.test");
  await click(view.button("Save and verify trust"));
  expect(mocks.configure.mock.calls[0]![0].input.adminToken).toBe("fresh-browser-token");
  expect(mocks.open).not.toHaveBeenCalled();
});

it("does not attempt an asynchronous popup when a browser lacks fresh Clerk identity", async () => {
  using _setup = setup();
  Reflect.deleteProperty(window, "desktopBridge");
  await using view = await mount();
  await view.edit();
  await click(view.button("Save and verify trust"));
  expect(mocks.open).not.toHaveBeenCalled();
  expect(readToolyardSettingsDraft(key)).not.toBeNull();
  expect(view.alertText()).toContain("signed-in browser administrator");
});

it("submits a local API key once without Clerk or browser trust and clears the secret after success", async () => {
  using _setup = setup();
  mocks.configure.mockImplementation(async () => {
    mocks.status = { ...mocks.status, revision: 1, mode: "api-key" };
    return AsyncResult.success(mocks.status);
  });
  await using view = await mount();
  await click(view.method("api-key"));
  await view.type("Toolyard base URL", "https://toolyard.test");
  await view.type("Toolyard API key", "ag_test.local-secret");
  expect(JSON.stringify(readToolyardSettingsDraft(key))).not.toContain("local-secret");
  await click(view.button("Save and connect"));
  expect(mocks.configure.mock.calls[0]![0].input).toMatchObject({
    mode: "api-key",
    apiKey: "ag_test.local-secret",
    enabled: true,
  });
  expect(mocks.token).not.toHaveBeenCalled();
  expect(mocks.open).not.toHaveBeenCalled();
  expect(view.input("Toolyard API key").value).toBe("");
  expect(readToolyardSettingsDraft(key)).toBeNull();
});
it.each(["invalid_api_key", "invalid_assertion"])(
  "retains public drafts and a retryable key after %s, then Discard clears both",
  async (code) => {
    using _setup = setup();
    mocks.configure.mockResolvedValue(failure(code));
    await using view = await mount();
    await click(view.method("api-key"));
    await view.type("Toolyard API key", "ag_test.secret");
    await click(view.button("Save and connect"));
    expect(readToolyardSettingsDraft(key)?.mode).toBe("api-key");
    expect(view.alertText()).toContain("Toolyard refused this API key");
    expect(view.input("Toolyard API key").value).toBe("ag_test.secret");
    expect(mocks.open).not.toHaveBeenCalled();
    await click(view.button("Discard"));
    expect(readToolyardSettingsDraft(key)).toBeNull();
    expect(view.inputs("Toolyard API key")).toHaveLength(0);
  },
);
it("restores the public API mode after reload without recovering the secret", async () => {
  using _setup = setup();
  {
    // Disposing the first mount stands in for leaving the page before the reload.
    await using beforeReload = await mount();
    await click(beforeReload.method("api-key"));
    await beforeReload.type("Toolyard API key", "ag_test.secret");
  }
  await using view = await mount();
  expect(view.input("Toolyard API key").value).toBe("");
  expect(readToolyardSettingsDraft(key)?.mode).toBe("api-key");
});
it("clears a secret when the authenticated user changes", async () => {
  using _setup = setup();
  await using view = await mount();
  await click(view.method("api-key"));
  await view.type("Toolyard API key", "ag_test.secret");
  mocks.userId = "user_other";
  await view.rerender(<ToolyardSettingsSection />);
  await click(view.method("api-key"));
  expect(view.input("Toolyard API key").value).toBe("");
});
it("disconnects only the current account after confirmation", async () => {
  using _setup = setup();
  mocks.status = {
    ...mocks.status,
    administrator: false,
    mode: "api-key",
    baseUrl: "https://toolyard.test",
    enabled: true,
    connection: "connected",
  };
  mocks.configure.mockResolvedValue(AsyncResult.success(mocks.status));
  await using view = await mount();
  await click(view.button("Disconnect my account"));
  expect(mocks.configure).not.toHaveBeenCalled();
  await click(view.dialogButton("Disconnect"));
  expect(mocks.configure.mock.calls[0]![0].input).toMatchObject({
    disconnect: true,
    mode: "api-key",
    remove: false,
  });
  expect(mocks.configure.mock.calls[0]![0].input).not.toHaveProperty("apiKey");
  expect(view.button("Remove instance")).toBeUndefined();
});
it("sends no disconnect when the confirmation is cancelled, and keeps a refused disconnect visible", async () => {
  using _setup = setup();
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
  await using view = await mount();
  await click(view.button("Disconnect my account"));
  expect(view.dialog()).toBeDefined();
  await click(view.dialogButton("Cancel"));
  expect(view.dialog()).toBeUndefined();
  expect(mocks.configure).not.toHaveBeenCalled();
  await click(view.button("Disconnect my account"));
  await click(view.dialogButton("Disconnect"));
  expect(mocks.configure).toHaveBeenCalledOnce();
  expect(mocks.configure.mock.calls[0]![0].input).toMatchObject({
    disconnect: true,
    expectedRevision: 5,
  });
  expect(view.alertText()).toContain("The server settings changed");
  expect(view.text()).toContain("Connected");
});
it("removes the instance only after the administrator confirms, with the expected revision", async () => {
  using _setup = setup();
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
  await using view = await mount();
  // A team connection has no personal disconnect until another method is chosen.
  expect(view.button("Disconnect my account")).toBeUndefined();
  await click(view.button("Remove instance"));
  await click(view.dialogButton("Cancel"));
  expect(mocks.configure).not.toHaveBeenCalled();
  await click(view.button("Remove instance"));
  await click(view.dialogButton("Remove instance"));
  expect(mocks.configure.mock.calls[0]![0].input).toMatchObject({
    remove: true,
    expectedRevision: 4,
  });
  expect(mocks.configure.mock.calls[0]![0].input).not.toHaveProperty("disconnect");
  expect(view.dialog()).toBeUndefined();
});
it("shows an approved request on a connected account as history, with Open Toolyard and no Connect action", async () => {
  using _setup = setup();
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
  await using view = await mount();
  expect(view.text()).toContain("Connected");
  expect(view.text()).toContain("dev@beknown.work");
  expect(view.text()).not.toContain("Awaiting");
  expect(view.text()).not.toContain("Connection request:");
  for (const label of [
    "Connect my Toolyard account",
    "Start a new request",
    "Open account consent",
    "Save and verify trust",
    "Discard",
  ])
    expect(view.button(label)).toBeUndefined();
  // Summaries abbreviate identifiers; details keep the full values and the finished request.
  expect(view.text()).toContain("agent_01…");
  expect(view.text()).toContain("agent_0123456789abcdef");
  expect(view.text()).toContain("owner_0123456789abcdef");
  expect(view.text()).toContain("Approved");
  expect(expanded(view.fold("Connection details"))).toBe("false");
  await click(view.button("Open Toolyard"));
  expect(mocks.open).toHaveBeenCalledWith("https://toolyard.test/handoff?code=x");
  expect(mocks.configure).not.toHaveBeenCalled();
});
it("offers account consent while a request is pending and no routine save without a draft", async () => {
  using _setup = setup();
  mocks.status = {
    ...mocks.status,
    administrator: false,
    mode: "host",
    baseUrl: "https://toolyard.test",
    enabled: true,
    pendingConnection: pendingRequest(),
  };
  await using view = await mount();
  expect(view.text()).toContain("Awaiting your decision");
  expect(view.button("Connect my Toolyard account")).toBeUndefined();
  await click(view.button("Open account consent"));
  expect(mocks.open).toHaveBeenCalledWith(
    "https://toolyard.test/connections/authorize?request=reference",
  );
});
it("starts a new consent request after a rejected one", async () => {
  using _setup = setup();
  mocks.status = {
    ...mocks.status,
    administrator: false,
    mode: "host",
    baseUrl: "https://toolyard.test",
    enabled: true,
    pendingConnection: pendingRequest("rejected"),
  };
  mocks.configure.mockResolvedValue(AsyncResult.success(mocks.status));
  await using view = await mount();
  expect(view.text()).toContain("Request rejected");
  await click(view.button("Start a new request"));
  expect(mocks.configure.mock.calls[0]![0].input).toMatchObject({
    mode: "host",
    hostAction: "begin",
  });
});
it("shows an outage as unavailable with Retry, never as revoked access", async () => {
  using _setup = setup();
  mocks.status = {
    ...mocks.status,
    administrator: false,
    mode: "api-key",
    baseUrl: "https://toolyard.test",
    enabled: true,
    connection: "unavailable",
    email: "dev@beknown.work",
  };
  await using view = await mount();
  expect(view.text()).toContain("Status unavailable");
  expect(view.text()).not.toContain("Access revoked");
  expect(view.button("Save and connect")).toBeUndefined();
  expect(view.button("Open Toolyard")).toBeUndefined();
  await click(view.button("Retry"));
  expect(mocks.refresh).toHaveBeenCalledOnce();
});
it("opens server setup for a draft, keeps the draft when the fold closes, and shows conflicts outside it", async () => {
  using _setup = setup();
  mocks.status = {
    ...mocks.status,
    revision: 2,
    baseUrl: "https://toolyard.test",
    enabled: true,
    connection: "connected",
  };
  await using view = await mount();
  expect(expanded(view.fold("Server setup — administrator"))).toBe("false");
  expect(view.button("Save and verify trust")).toBeUndefined();
  await view.type("Toolyard base URL", "https://next.test");
  expect(expanded(view.fold("Server setup — administrator"))).toBe("true");
  await click(view.fold("Server setup — administrator"));
  expect(expanded(view.fold("Server setup — administrator"))).toBe("false");
  expect(view.input("Toolyard base URL").value).toBe("https://next.test");
  expect(view.button("Save and verify trust")!.disabled).toBe(false);
  mocks.status = { ...mocks.status, revision: 3 };
  await view.rerender(<ToolyardSettingsSection />);
  expect(view.only("p", view.only('[role="alert"]')).textContent).toContain("revision 2");
  await click(view.button("Use current revision"));
  expect(readToolyardSettingsDraft(key)).toMatchObject({
    baseUrl: "https://next.test",
    revision: 3,
  });
});
it("disables team access when the server has no verified team identity", async () => {
  using _setup = setup();
  mocks.status = { ...mocks.status, mode: "api-key", teamAvailable: false };
  await using view = await mount();
  expect(view.method("team")!.disabled).toBe(true);
  expect(view.method("api-key")!.disabled).toBe(false);
  expect(view.text()).toContain("no verified team identity");
  expect(mocks.token).not.toHaveBeenCalled();
});
it.each([
  ["api-key", "team", "Save and verify trust"],
  ["team", "api-key", "Save and connect"],
] as const)(
  "keeps the %s disconnect action after the draft selects %s",
  async (savedMode, nextMode, saveLabel) => {
    using _setup = setup();
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
    await using view = await mount();
    expect(expanded(view.fold("Manage connection"))).toBe("false");
    await click(view.method(nextMode));
    // The method change needs a disconnect first, so its fold opens and the warning stays outside.
    expect(expanded(view.fold("Manage connection"))).toBe("true");
    expect(view.button(saveLabel)!.disabled).toBe(true);
    expect(view.button("Disconnect my account")!.disabled).toBe(false);
    expect(view.alertText()).toContain("Disconnect my account");
    await click(view.button("Disconnect my account"));
    await click(view.dialogButton("Disconnect"));
    expect(mocks.configure.mock.calls[0]![0].input).toMatchObject({
      disconnect: true,
      remove: false,
    });
    expect(mocks.configure.mock.calls[0]![0].input).not.toHaveProperty("apiKey");
    expect(readToolyardSettingsDraft(key)?.mode).toBe(nextMode);
    expect(view.button("Remove instance")).toBeUndefined();
  },
);

it("targets the selected server and isolates its public draft, API key, and user identity", async () => {
  using _setup = setup();
  mocks.statusByEnvironment.set("env_mac", {
    ...mocks.status,
    mode: "api-key",
    teamAvailable: false,
    baseUrl: "https://toolyard.test",
    enabled: true,
  });
  mocks.sessionUsers.set("env_mac", null);
  await using view = await mount();
  await click(view.method("api-key"));
  await view.type("Toolyard base URL", "https://stage-draft.test");
  await view.type("Toolyard API key", "ag_stage.stage-secret");
  mocks.selectedIds = ["env_mac"];
  await view.rerender(<ToolyardSettingsSection />);
  expect(view.input("Toolyard API key").value).toBe("");
  expect(view.input("Toolyard base URL").value).toBe("https://toolyard.test");
  expect(mocks.statusQueries.mock.calls.at(-1)![0]).toMatchObject({
    environmentId: "env_mac",
    input: { userScope: "local-user" },
  });
  expect(view.text()).toContain("All clients authorized for this local profile");
  await view.type("Toolyard API key", "ag_mac.mac-secret");
  mocks.configure.mockResolvedValue(failure("invalid_api_key"));
  await click(view.button("Save and connect"));
  expect(mocks.configure.mock.calls.at(-1)![0]).toMatchObject({
    environmentId: "env_mac",
    input: { apiKey: "ag_mac.mac-secret", mode: "api-key" },
  });
  expect(mocks.configure.mock.calls.at(-1)![0].input).not.toHaveProperty("adminToken");
  expect(mocks.token).not.toHaveBeenCalled();
  mocks.selectedIds = ["env_stage"];
  await view.rerender(<ToolyardSettingsSection />);
  expect(view.input("Toolyard base URL").value).toBe("https://stage-draft.test");
  expect(view.input("Toolyard API key").value).toBe("");
  expect(readToolyardSettingsDraft(key)?.baseUrl).toBe("https://stage-draft.test");
});
it("does not send the primary Clerk token to a server with a different authenticated user", async () => {
  using _setup = setup();
  mocks.sessionUsers.set("env_stage", "user_other");
  mocks.token.mockResolvedValue("primary-user-secret");
  await using view = await mount();
  await view.edit();
  await click(view.button("Save and verify trust"));
  expect(mocks.token).not.toHaveBeenCalled();
  expect(mocks.configure.mock.calls[0]![0].input).not.toHaveProperty("adminToken");
  const url = new URL(mocks.open.mock.calls[0]![0]);
  expect(JSON.parse(decodeURIComponent(url.hash.split("=")[1]!)).userId).toBe("user_other");
});
it("does not inspect Toolyard credentials before the selected server authenticates the client", async () => {
  using _setup = setup();
  mocks.sessionAuthenticated.set("env_stage", false);
  await using view = await mount();
  expect(mocks.statusQueries).not.toHaveBeenCalled();
  expect(mocks.configure).not.toHaveBeenCalled();
});

it("applies a browser continuation only to its selected server when two servers are visible", async () => {
  using _setup = setup();
  mocks.selectedIds = ["env_stage", "env_other"];
  mocks.pageOrigin = "https://other.test";
  setHash(
    new URL(
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
    ).hash,
  );
  await using view = await mount();
  const sections = view.container.querySelectorAll("section");
  expect(sections).toHaveLength(2);
  expect(view.input("Toolyard base URL", sections[0]).value).toBe("");
  expect(view.input("Toolyard base URL", sections[1]).value).toBe("https://other-toolyard.test");
  expect(readToolyardSettingsDraft(toolyardDraftKey("env_other", "user_admin"))?.baseUrl).toBe(
    "https://other-toolyard.test",
  );
  expect(readToolyardSettingsDraft(key)).toBeNull();
  expect(mocks.configure).not.toHaveBeenCalled();
});

it("uses the grouped title and Refresh, and re-reads status when the group refreshes", async () => {
  using _setup = setup();
  const environment = {
    environmentId: "env_stage",
    label: "Stage",
    serverConfig: {
      auth: { clerk: {} },
      settings: { experimental: { externalMcp: { publicUrl: null } } },
    },
  } as unknown as Parameters<typeof EnvironmentToolyardSettings>[0]["environment"];
  await using view = await mount(
    <EnvironmentToolyardSettings environment={environment} compact refreshVersion={0} />,
  );
  expect(view.only("section").getAttribute("data-title")).toBe("Toolyard");
  expect(view.button("Refresh")).toBeUndefined();
  expect(mocks.refresh).not.toHaveBeenCalled();
  await view.rerender(
    <EnvironmentToolyardSettings environment={environment} compact refreshVersion={1} />,
  );
  expect(mocks.refresh).toHaveBeenCalledOnce();
  await view.rerender(<EnvironmentToolyardSettings environment={environment} />);
  expect(view.only("section").getAttribute("data-title")).toBe("Toolyard — Stage");
  expect(view.button("Refresh")).toBeDefined();
});

it("opens host account consent with no copied API key or Clerk token", async () => {
  using _setup = setup();
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
  await using view = await mount();
  await click(view.button("Connect my Toolyard account"));
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
  using _setup = setup();
  {
    // Disposing the first mount stands in for navigating away before the reload.
    await using beforeReload = await mount();
    await beforeReload.edit();
    await click(beforeReload.method("host"));
    mocks.configure.mockResolvedValue(failure("instance_unavailable"));
    await click(beforeReload.button("Connect my Toolyard account"));
    expect(readToolyardSettingsDraft(key)).toEqual({
      baseUrl: "https://toolyard.test",
      enabled: true,
      revision: 0,
      mode: "host",
    });
  }
  await using view = await mount();
  expect(view.method("host")!.getAttribute("aria-checked")).toBe("true");
  expect(view.alerts()).toHaveLength(0);
});
it("refuses a consent destination from another Toolyard instance", async () => {
  using _setup = setup();
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
  await using view = await mount();
  await click(view.button("Connect my Toolyard account"));
  expect(mocks.open).not.toHaveBeenCalled();
  expect(view.alerts().length).toBeGreaterThan(0);
});
it("cancels only the committed request and preserves a newer settings draft", async () => {
  using _setup = setup();
  mocks.status = {
    ...mocks.status,
    mode: "host",
    revision: 3,
    baseUrl: "https://toolyard.test",
    enabled: true,
    pendingConnection: pendingRequest(),
  };
  mocks.configure.mockResolvedValue(AsyncResult.success(mocks.status));
  await using view = await mount();
  await view.type("Toolyard base URL", "https://new-draft.test");
  await click(view.method("api-key"));
  await click(view.button("Cancel connection request"));
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
  using _setup = setup();
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
  await using view = await mount();
  await click(view.button("Connect my Toolyard account"));
  mocks.status = { ...mocks.status, pendingConnection: pendingRequest() };
  await view.rerender(<ToolyardSettingsSection />);
  expect(view.text()).toContain("Awaiting your Toolyard account decision");
  mocks.status = {
    ...mocks.status,
    connection: "connected",
    pendingConnection: pendingRequest("approved"),
  };
  await view.rerender(<ToolyardSettingsSection />);
  expect(view.text()).toContain("Connected");
  expect(view.text()).not.toContain("Awaiting your Toolyard account decision");
  expect(view.text()).not.toContain("Review the account and host");
  expect(view.button("Connect my Toolyard account")).toBeUndefined();
});
it("does not offer an ineffective team reconnect through a settings save", async () => {
  using _setup = setup();
  mocks.status = {
    ...mocks.status,
    mode: "team",
    enabled: true,
    baseUrl: "https://toolyard.test",
    connection: "revoked",
    revision: 4,
  };
  await using view = await mount();
  expect(view.button("Save and verify trust")).toBeUndefined();
  expect(view.text()).toContain("A settings save does not restore revoked access");
  expect(view.method("host")).toBeDefined();
  expect(mocks.configure).not.toHaveBeenCalled();
});
