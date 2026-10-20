/** T3-CUSTOM(expbkt3): webhook changes are confirmed, revision-guarded and scoped per server user. */
import { cloneElement, type ReactElement, type ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { act, render } from "../../test/render";
import * as Cause from "effect/Cause";
import { PersonalMcpSettingsError, ThreadId, type SessionWebhookView } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
const mocks = vi.hoisted(() => ({
  webhooks: new Map<string, ReadonlyArray<object>>(),
  sessionUsers: new Map<string, string | null>(),
  sessionAuthenticated: new Map<string, boolean>(),
  listQueries: vi.fn(),
  update: vi.fn(),
  refresh: vi.fn(),
}));
// The state factories replace their modules outright instead of spreading the originals:
// the section reads only these members, and the real modules build live atoms.
vi.mock(import("@effect/atom-react"), () => ({
  useAtomValue: ((atom: { environmentId: string }) =>
    AsyncResult.success(mocks.webhooks.get(atom.environmentId) ?? [])) as never,
}));
vi.mock(import("../state/session"), () => ({
  useEnvironmentSessionState: ((environmentId: string) => ({
    data: {
      authenticated: mocks.sessionAuthenticated.get(environmentId) ?? true,
      userId: mocks.sessionUsers.has(environmentId)
        ? mocks.sessionUsers.get(environmentId)
        : "user_a",
    },
  })) as never,
}));
// Only the list-wide section reads the scope, and its real module builds the settings state.
vi.mock(import("../components/settings/SettingsScopeContext"), () => ({
  useSettingsScope: (() => ({ connectedEnvironments: [] })) as never,
}));
vi.mock(import("../state/entities"), () => ({
  useThreadShell: ((ref: { threadId: string }) =>
    ref.threadId.startsWith("thread-titled") ? { title: "Fix login" } : null) as never,
}));
vi.mock(import("../state/server"), () => ({
  serverEnvironment: {
    sessionWebhooksList: (input: { environmentId: string; input: { userScope: string } }) => {
      mocks.listQueries(input);
      return { environmentId: input.environmentId };
    },
    sessionWebhooksUpdate: "update",
  } as never,
}));
vi.mock(import("../state/use-atom-command"), () => ({
  useAtomCommand: ((command: string) => (command === "update" ? mocks.update : vi.fn())) as never,
}));
vi.mock(import("../rpc/atomRegistry"), () => ({
  appAtomRegistry: { refresh: mocks.refresh } as never,
}));
// The menu stand-in renders every item inline, so the tests query one tree. It replaces the
// module outright: the real menu imports lib/utils, whose graph imports the menu again
// (through TraitsPicker), so a factory that awaits the original waits on itself and the file
// never loads. Button and Badge stay real for the same reason. TraitsPicker still links
// against the other members it imports.
vi.mock(import("../components/ui/menu"), () => {
  const Pass = (({ children }: { children?: ReactNode }) => <>{children}</>) as never;
  return {
    Menu: Pass,
    MenuTrigger: (({ render, children }: { render: ReactElement; children: ReactNode }) =>
      cloneElement(render, {}, children)) as never,
    MenuPopup: Pass,
    MenuItem: (({ children, ...props }: { children: ReactNode }) => (
      <button role="menuitem" {...props}>
        {children}
      </button>
    )) as never,
    MenuGroup: Pass,
    MenuRadioGroup: Pass,
    MenuRadioItem: Pass,
    MenuSeparator: Pass,
  };
});
// These folds are uncontrolled and unmount closed panels, as the component requests.
vi.mock(import("../components/ui/collapsible"), async (original) => {
  const { createContext, useContext, useMemo, useState } = await import("react");
  const Fold = createContext({ open: false, onOpenChange: (_open: boolean) => {} });
  return {
    ...(await original()),
    Collapsible: (({ children }: { children: ReactNode }) => {
      const [open, onOpenChange] = useState(false);
      const fold = useMemo(() => ({ open, onOpenChange }), [open]);
      return <Fold value={fold}>{children}</Fold>;
    }) as never,
    CollapsibleTrigger: (({ children, ...props }: { children: ReactNode }) => {
      const fold = useContext(Fold);
      return (
        <button {...props} aria-expanded={fold.open} onClick={() => fold.onOpenChange(!fold.open)}>
          {children}
        </button>
      );
    }) as never,
    CollapsiblePanel: (({ children }: { children: ReactNode }) =>
      useContext(Fold).open ? <div>{children}</div> : null) as never,
  };
});
vi.mock(import("../components/ui/alert-dialog"), async (original) => {
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
// The real layout pulls in the settings state modules that the state mocks above replace.
vi.mock(import("../components/settings/settingsLayout"), () => ({
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
}));
import { EnvironmentSessionWebhookSettings } from "./SessionWebhookSettingsSection";

const webhook = (overrides: Partial<SessionWebhookView> = {}): SessionWebhookView => ({
  id: "swh_00000000000000000000000000000001",
  threadId: ThreadId.make("thread-titled-1"),
  instanceId: "instance-1",
  callbackRef: "cb_1",
  status: "active",
  revision: 3,
  createdAt: "2026-10-01T10:00:00.000Z",
  updatedAt: "2026-10-01T10:00:00.000Z",
  terminalReason: null,
  deliveries: [],
  deliveryHistory: [],
  deliveryHistoryError: null,
  ...overrides,
});
const failure = (code: string) =>
  AsyncResult.failure(
    Cause.fail(new PersonalMcpSettingsError({ operation: "Session webhook", message: code })),
  );
const serverConfig = (clerk: boolean) => ({ auth: clerk ? { clerk: {} } : {} }) as never;
function server(environmentId: string, clerk = true) {
  return (
    <EnvironmentSessionWebhookSettings
      key={environmentId}
      environmentId={environmentId as never}
      label={environmentId}
      serverConfig={serverConfig(clerk)}
    />
  );
}
const textOf = (node: Element): string => node.textContent ?? "";
async function press(scope: Element, name: string) {
  const target = [...scope.querySelectorAll("button")].find((node) => textOf(node) === name)!;
  await act(async () => {
    target.click();
  });
}
async function mount(ui: ReactNode = server("env_stage")) {
  // The section has no links or router hooks.
  const screen = await render(<>{ui}</>, { router: false });
  const container = screen.container;
  return Object.assign(screen, {
    // Markup, not just text, so attributes count too, as the rendered tree's JSON did.
    text: () => container.innerHTML,
    buttons: (name: string) =>
      [...container.querySelectorAll("button")].filter((button) => textOf(button).includes(name)),
    dialog: () => container.querySelector('[role="alertdialog"]') ?? undefined,
    press: (name: string, scope: Element = container) => press(scope, name),
    alerts: () => [...container.querySelectorAll('p[role="alert"]')].map(textOf),
  });
}
function setup() {
  mocks.webhooks.clear();
  mocks.sessionUsers.clear();
  mocks.sessionAuthenticated.clear();
  mocks.listQueries.mockClear();
  mocks.update.mockReset();
  mocks.refresh.mockClear();
  mocks.webhooks.set("env_stage", [webhook()]);
}

it("cancelling a confirmation sends no change", async () => {
  setup();
  await using view = await mount();
  await view.press("Disable");
  expect(textOf(view.dialog()!)).toContain("Disable callbacks for Fix login?");
  await view.press("Cancel", view.dialog()!);
  expect(view.dialog()).toBeUndefined();
  expect(mocks.update).not.toHaveBeenCalled();
});

it("confirming sends the exact server, webhook and revision the user saw", async () => {
  setup();
  mocks.update.mockResolvedValue(AsyncResult.success({}));
  await using view = await mount();
  await view.press("Remove");
  await view.press("Remove", view.dialog()!);
  expect(mocks.update).toHaveBeenCalledTimes(1);
  expect(mocks.update).toHaveBeenCalledWith({
    environmentId: "env_stage",
    input: { id: "swh_00000000000000000000000000000001", action: "remove", expectedRevision: 3 },
  });
  expect(view.dialog()).toBeUndefined();
  expect(mocks.refresh).toHaveBeenCalled();
});

it("shows a failed change inline on its card without leaking unknown text", async () => {
  setup();
  mocks.update.mockResolvedValueOnce(failure("webhook-revision-conflict"));
  await using view = await mount();
  await view.press("Rotate secret");
  await view.press("Rotate secret", view.dialog()!);
  expect(view.dialog()).toBeUndefined();
  expect(view.alerts().join()).toContain("The webhook changed since this view loaded.");
  mocks.update.mockResolvedValueOnce(failure("secret token abc"));
  await view.press("Rotate secret");
  await view.press("Rotate secret", view.dialog()!);
  expect(view.text()).not.toContain("secret token abc");
  expect(view.alerts().join()).toContain("The change did not apply.");
});

it("keys each server's list by its authenticated user and resets state on a user switch", async () => {
  setup();
  mocks.sessionUsers.set("env_mac", null);
  mocks.sessionUsers.set("env_clerk_pending", null);
  mocks.sessionAuthenticated.set("env_signed_out", false);
  await using view = await mount(
    <>
      {server("env_stage")}
      {server("env_mac", false)}
      {server("env_clerk_pending")}
      {server("env_signed_out")}
    </>,
  );
  expect(mocks.listQueries.mock.calls.map(([input]) => input)).toEqual([
    { environmentId: "env_stage", input: { userScope: "user_a" } },
    { environmentId: "env_mac", input: { userScope: "local-user" } },
  ]);
  expect(view.text().match(/Authenticate with this server/g)).toHaveLength(2);

  mocks.update.mockResolvedValueOnce(failure("webhook-not-found"));
  await view.press("Disable");
  await view.press("Disable", view.dialog()!);
  expect(view.alerts().join()).toContain("This webhook no longer exists for your account.");
  mocks.sessionUsers.set("env_stage", "user_b");
  await view.rerender(<>{server("env_stage")}</>);
  expect(mocks.listQueries).toHaveBeenLastCalledWith({
    environmentId: "env_stage",
    input: { userScope: "user_b" },
  });
  // Another user's error must not survive into this user's view.
  expect(view.text()).not.toContain("no longer exists");
});

it("keeps sync failures visible, including removed webhooks outside their closed section", async () => {
  setup();
  mocks.webhooks.set("env_stage", [
    webhook({ status: "disabled", terminalReason: "disable-server-sync-failed" }),
    webhook({
      id: "swh_00000000000000000000000000000002",
      threadId: ThreadId.make("thread-untitled-abcdef"),
      status: "removed",
      terminalReason: "remove-server-sync-failed",
      deliveries: [
        {
          eventId: "evt_failed",
          state: "terminal",
          attempts: 2,
          receivedAt: "2026-10-01T10:01:00.000Z",
          updatedAt: "2026-10-01T10:01:01.000Z",
          terminalReason: "dispatch-rejected",
        },
      ],
    }),
  ]);
  await using view = await mount();
  const visible = view.alerts().join();
  expect(visible).toContain(
    "Disable could not sync with Toolyard, and the server stopped retrying",
  );
  expect(visible).toContain("Removed webhook for Session thread-u…");
  expect(visible).toContain("Removal could not sync with Toolyard");
  expect(view.text()).toContain("Its history has 1 failed or stopped event.");
  expect(view.text()).not.toMatch(/server keeps retrying|try again shortly/);
  // The removed card stays collapsed and out of the attention badge.
  expect(view.text()).not.toContain("swh_00000000000000000000000000000002");
  expect(view.text()).not.toMatch(/\d+ events? needs? attention/);
  await view.press("Removed webhooks (1)");
  expect(view.text()).toContain("Stopped · The session rejected the notification");
});

it("leaves a deliberate Disable as history without an attention badge", async () => {
  setup();
  mocks.webhooks.set("env_stage", [
    webhook({
      status: "disabled",
      terminalReason: "disable",
      deliveries: [
        {
          eventId: "evt_stopped",
          state: "terminal",
          attempts: 0,
          receivedAt: "2026-10-01T10:01:00.000Z",
          updatedAt: "2026-10-01T10:01:01.000Z",
          terminalReason: "disable",
        },
      ],
    }),
  ]);
  await using view = await mount();
  expect(view.text()).not.toMatch(/\d+ events? needs? attention/);
  expect(view.alerts()).toEqual([]);
  expect(view.text()).toContain("No callbacks need attention.");
  expect(view.buttons("Earlier callbacks (1)")).toHaveLength(1);
});
