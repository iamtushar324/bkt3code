/** T3-CUSTOM(expbkt3): webhook changes are confirmed, revision-guarded and scoped per server user. */
import { act, cloneElement, type ReactElement, type ReactNode } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
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
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: { environmentId: string }) =>
    AsyncResult.success(mocks.webhooks.get(atom.environmentId) ?? []),
}));
vi.mock("../state/session", () => ({
  useEnvironmentSessionState: (environmentId: string) => ({
    data: {
      authenticated: mocks.sessionAuthenticated.get(environmentId) ?? true,
      userId: mocks.sessionUsers.has(environmentId)
        ? mocks.sessionUsers.get(environmentId)
        : "user_a",
    },
  }),
}));
vi.mock("../state/entities", () => ({
  useThreadShell: (ref: { threadId: string }) =>
    ref.threadId.startsWith("thread-titled") ? { title: "Fix login" } : null,
}));
vi.mock("../state/server", () => ({
  serverEnvironment: {
    sessionWebhooksList: (input: { environmentId: string; input: { userScope: string } }) => {
      mocks.listQueries(input);
      return { environmentId: input.environmentId };
    },
    sessionWebhooksUpdate: "update",
  },
}));
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: (command: string) => (command === "update" ? mocks.update : vi.fn()),
}));
vi.mock("../rpc/atomRegistry", () => ({ appAtomRegistry: { refresh: mocks.refresh } }));
vi.mock("../components/ui/button", () => ({
  Button: ({ children, ...props }: { children: ReactNode }) => (
    <button {...props}>{children}</button>
  ),
}));
vi.mock("../components/ui/badge", () => ({
  Badge: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../components/ui/menu", () => ({
  Menu: ({ children }: { children: ReactNode }) => <>{children}</>,
  MenuTrigger: ({ render, children }: { render: ReactElement; children: ReactNode }) =>
    cloneElement(render, {}, children),
  MenuPopup: ({ children }: { children: ReactNode }) => <>{children}</>,
  MenuItem: ({ children, ...props }: { children: ReactNode }) => (
    <button role="menuitem" {...props}>
      {children}
    </button>
  ),
}));
// These folds are uncontrolled and unmount closed panels, as the component requests.
vi.mock("../components/ui/collapsible", async () => {
  const { createContext, useContext, useMemo, useState } = await import("react");
  const Fold = createContext({ open: false, onOpenChange: (_open: boolean) => {} });
  return {
    Collapsible: ({ children }: { children: ReactNode }) => {
      const [open, onOpenChange] = useState(false);
      const fold = useMemo(() => ({ open, onOpenChange }), [open]);
      return <Fold value={fold}>{children}</Fold>;
    },
    CollapsibleTrigger: ({ children, ...props }: { children: ReactNode }) => {
      const fold = useContext(Fold);
      return (
        <button {...props} aria-expanded={fold.open} onClick={() => fold.onOpenChange(!fold.open)}>
          {children}
        </button>
      );
    },
    CollapsiblePanel: ({ children }: { children: ReactNode }) =>
      useContext(Fold).open ? <div>{children}</div> : null,
  };
});
vi.mock("../components/ui/alert-dialog", async () => {
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
vi.mock("../components/settings/settingsLayout", () => ({
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
}));
import { EnvironmentSessionWebhookSettings } from "./SessionWebhookSettingsSection";

let renderer: ReactTestRenderer;
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
async function render(node: ReactNode = server("env_stage")) {
  await act(() => {
    renderer = create(<>{node}</>);
  });
}
const text = () => JSON.stringify(renderer.toJSON());
const textOf = (node: ReactTestInstance): string =>
  node.children.map((child) => (typeof child === "string" ? child : textOf(child))).join("");
const buttons = (name: string) =>
  renderer.root.findAllByType("button").filter((node) => textOf(node).includes(name));
const dialog = () => renderer.root.findAllByProps({ role: "alertdialog" })[0];
async function press(name: string, scope = renderer.root) {
  const target = scope.findAllByType("button").find((node) => textOf(node) === name)!;
  await act(async () => {
    target.props.onClick();
  });
}
const alerts = () =>
  renderer.root.findAll((node) => node.type === "p" && node.props.role === "alert").map(textOf);

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.webhooks.clear();
  mocks.sessionUsers.clear();
  mocks.sessionAuthenticated.clear();
  mocks.listQueries.mockClear();
  mocks.update.mockReset();
  mocks.refresh.mockClear();
  mocks.webhooks.set("env_stage", [webhook()]);
});
afterEach(() => {
  act(() => renderer?.unmount());
  vi.unstubAllGlobals();
});

it("cancelling a confirmation sends no change", async () => {
  await render();
  await press("Disable");
  expect(textOf(dialog()!)).toContain("Disable callbacks for Fix login?");
  await press("Cancel", dialog());
  expect(dialog()).toBeUndefined();
  expect(mocks.update).not.toHaveBeenCalled();
});

it("confirming sends the exact server, webhook and revision the user saw", async () => {
  mocks.update.mockResolvedValue(AsyncResult.success({}));
  await render();
  await press("Remove");
  await press("Remove", dialog());
  expect(mocks.update).toHaveBeenCalledTimes(1);
  expect(mocks.update).toHaveBeenCalledWith({
    environmentId: "env_stage",
    input: { id: "swh_00000000000000000000000000000001", action: "remove", expectedRevision: 3 },
  });
  expect(dialog()).toBeUndefined();
  expect(mocks.refresh).toHaveBeenCalled();
});

it("shows a failed change inline on its card without leaking unknown text", async () => {
  mocks.update.mockResolvedValueOnce(failure("webhook-revision-conflict"));
  await render();
  await press("Rotate secret");
  await press("Rotate secret", dialog());
  expect(dialog()).toBeUndefined();
  expect(alerts().join()).toContain("The webhook changed since this view loaded.");
  mocks.update.mockResolvedValueOnce(failure("secret token abc"));
  await press("Rotate secret");
  await press("Rotate secret", dialog());
  expect(text()).not.toContain("secret token abc");
  expect(alerts().join()).toContain("The change did not apply.");
});

it("keys each server's list by its authenticated user and resets state on a user switch", async () => {
  mocks.sessionUsers.set("env_mac", null);
  mocks.sessionUsers.set("env_clerk_pending", null);
  mocks.sessionAuthenticated.set("env_signed_out", false);
  await render(
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
  expect(text().match(/Authenticate with this server/g)).toHaveLength(2);

  mocks.update.mockResolvedValueOnce(failure("webhook-not-found"));
  await press("Disable");
  await press("Disable", dialog());
  expect(alerts().join()).toContain("This webhook no longer exists for your account.");
  mocks.sessionUsers.set("env_stage", "user_b");
  await act(() => {
    renderer.update(<>{server("env_stage")}</>);
  });
  expect(mocks.listQueries).toHaveBeenLastCalledWith({
    environmentId: "env_stage",
    input: { userScope: "user_b" },
  });
  // Another user's error must not survive into this user's view.
  expect(text()).not.toContain("no longer exists");
});

it("keeps sync failures visible, including removed webhooks outside their closed section", async () => {
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
  await render();
  const visible = alerts().join();
  expect(visible).toContain(
    "Disable could not sync with Toolyard, and the server stopped retrying",
  );
  expect(visible).toContain("Removed webhook for Session thread-u…");
  expect(visible).toContain("Removal could not sync with Toolyard");
  expect(text()).toContain("Its history has 1 failed or stopped event.");
  expect(text()).not.toMatch(/server keeps retrying|try again shortly/);
  // The removed card stays collapsed and out of the attention badge.
  expect(text()).not.toContain("swh_00000000000000000000000000000002");
  expect(text()).not.toMatch(/\d+ events? needs? attention/);
  await press("Removed webhooks (1)");
  expect(text()).toContain("Stopped · The session rejected the notification");
});

it("leaves a deliberate Disable as history without an attention badge", async () => {
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
  await render();
  expect(text()).not.toMatch(/\d+ events? needs? attention/);
  expect(alerts()).toEqual([]);
  expect(text()).toContain("No callbacks need attention.");
  expect(buttons("Earlier callbacks (1)")).toHaveLength(1);
});
