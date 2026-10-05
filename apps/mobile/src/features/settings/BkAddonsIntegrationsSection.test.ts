// T3-CUSTOM(expbkt3): BK Add-ons mobile state rules: server scope, disclosures, callback triage.
import {
  EnvironmentId,
  ThreadId,
  type SessionWebhookView,
  type ToolyardIntegrationStatus,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { bkAddonsServers } from "./BkAddonsIntegrationsSection";
import { sessionCallbackGroups } from "./SessionWebhooksSettingsSection";
import { toolyardDisclosureDefaults } from "./ToolyardSettingsSection";

vi.mock("react-native", () => ({
  Alert: { alert: vi.fn() },
  Linking: { openURL: vi.fn() },
  Platform: { OS: "ios" },
  Pressable: "Pressable",
  Switch: "Switch",
  View: "View",
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: vi.fn() }));
vi.mock("@clerk/expo", () => ({ useAuth: vi.fn() }));
vi.mock("../cloud/publicConfig", () => ({ hasCloudPublicConfig: () => false }));
vi.mock("../phasesidebar/usePhaseSidebarRows", () => ({
  usePhaseSidebarViewerUserId: vi.fn(),
}));
vi.mock("../../components/AppSymbol", () => ({ SymbolView: "SymbolView" }));
vi.mock("../../components/AppText", () => ({ AppText: "Text", AppTextInput: "TextInput" }));
vi.mock("../../components/StatusPill", () => ({ StatusPill: "StatusPill" }));
vi.mock("../../state/atom-registry", () => ({ appAtomRegistry: { refresh: vi.fn() } }));
vi.mock("../../state/server", () => ({ serverEnvironment: {} }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: vi.fn() }));
vi.mock("../../state/session", () => ({
  environmentSession: {},
  usePreparedConnection: vi.fn(),
}));
vi.mock("../../state/entities", () => ({ useThreadShell: vi.fn() }));
vi.mock("../../state/environments", () => ({ useEnvironments: vi.fn() }));
vi.mock("./components/SettingsSection", () => ({ SettingsSection: "SettingsSection" }));
vi.mock("./settings-environment-filter", () => ({ useSettingsEnvironmentFilter: vi.fn() }));

type Environment = Parameters<typeof bkAddonsServers>[0][number];
type Target = Parameters<typeof bkAddonsServers>[1][number];

const laptop = EnvironmentId.make("laptop");
const server = EnvironmentId.make("server");
const environment = (environmentId: EnvironmentId, phase: string) =>
  ({ environmentId, label: environmentId, connection: { phase } }) as unknown as Environment;
const asTarget = (entry: Environment) => entry as unknown as Target;

describe("bkAddonsServers", () => {
  const environments = [environment(laptop, "connected"), environment(server, "offline")];
  const targets = [asTarget(environments[0]!)];

  it("keeps a selected but disconnected server listed without a target", () => {
    expect(bkAddonsServers(environments, targets, null)).toEqual([
      { environment: environments[0], target: targets[0] },
      { environment: environments[1], target: null },
    ]);
  });

  it("only lists servers in the environment filter", () => {
    expect(bkAddonsServers(environments, targets, new Set([server]))).toEqual([
      { environment: environments[1], target: null },
    ]);
    expect(bkAddonsServers(environments, targets, new Set<EnvironmentId>())).toEqual([]);
  });
});

const status = (overrides: Partial<ToolyardIntegrationStatus> = {}): ToolyardIntegrationStatus => ({
  revision: 4,
  revocationPending: 0,
  enabled: true,
  removed: false,
  baseUrl: "https://toolyard.example",
  instanceId: "instance-1",
  origin: "https://t3.example",
  administrator: true,
  mode: "host",
  connection: "connected",
  email: "user@example.com",
  expiresAt: null,
  ...overrides,
});
const defaults = (
  input: Partial<Parameters<typeof toolyardDisclosureDefaults>[0]> & {
    status: ToolyardIntegrationStatus;
  },
) =>
  toolyardDisclosureDefaults({
    draft: null,
    apiKeyEntered: false,
    connected: input.status.connection === "connected",
    pending: false,
    ...input,
  });

describe("toolyardDisclosureDefaults", () => {
  it("keeps management and administrator setup closed for a routine connection", () => {
    expect(defaults({ status: status() })).toEqual({
      conflict: false,
      adminExpanded: false,
      manageExpanded: false,
    });
  });

  it("opens administrator setup for an unsaved setup draft or a revision conflict", () => {
    const current = { baseUrl: "https://toolyard.example", enabled: true, revision: 4 };
    expect(
      defaults({ status: status(), draft: { ...current, baseUrl: "https://next.example" } })
        .adminExpanded,
    ).toBe(true);
    const conflict = defaults({ status: status(), draft: { ...current, revision: 3 } });
    expect(conflict).toMatchObject({ conflict: true, adminExpanded: true });
  });

  it("opens setup for administrators when the instance is missing, disabled or removed", () => {
    const missingSetups: Array<Partial<ToolyardIntegrationStatus>> = [
      { baseUrl: null },
      { enabled: false },
      { removed: true },
    ];
    for (const missing of missingSetups) {
      const next = status({ ...missing, connection: "not_connected" });
      expect(defaults({ status: next }).adminExpanded).toBe(true);
      expect(defaults({ status: { ...next, administrator: false } }).adminExpanded).toBe(false);
      expect(defaults({ status: next }).manageExpanded).toBe(false);
    }
  });

  it("shows connection methods directly when the account can connect", () => {
    for (const connection of ["not_connected", "revoked"] as const)
      expect(defaults({ status: status({ connection }) }).manageExpanded).toBe(true);
    const unavailable = status({ connection: "unavailable" });
    expect(defaults({ status: unavailable }).manageExpanded).toBe(false);
    expect(
      defaults({ status: status({ connection: "not_connected" }), pending: true }).manageExpanded,
    ).toBe(false);
  });

  it("keeps management open while a method change or API key is unsaved", () => {
    const current = { baseUrl: "https://toolyard.example", enabled: true, revision: 4 };
    expect(
      defaults({ status: status(), draft: { ...current, mode: "api-key" } }).manageExpanded,
    ).toBe(true);
    expect(defaults({ status: status(), apiKeyEntered: true }).manageExpanded).toBe(true);
  });
});

const webhook = (id: string, overrides: Partial<SessionWebhookView> = {}): SessionWebhookView => ({
  id,
  threadId: ThreadId.make(`thread-${id}`),
  instanceId: "instance-1",
  callbackRef: "callback-1",
  status: "active",
  revision: 1,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  terminalReason: null,
  deliveries: [],
  deliveryHistory: [],
  deliveryHistoryError: null,
  ...overrides,
});
type Dispatch = SessionWebhookView["deliveries"][number];
type Transport = NonNullable<SessionWebhookView["deliveryHistory"]>[number];
const dispatch = (
  eventId: string,
  state: Dispatch["state"],
  terminalReason: string | null = null,
): Dispatch => ({
  eventId,
  state,
  attempts: 1,
  receivedAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:01.000Z",
  terminalReason,
});
const transport = (eventId: string, state: Transport["status"], attempts: number): Transport => ({
  eventId,
  inboxId: "inbox-1",
  status: state,
  attempts,
  terminalReason: null,
  history: Array.from({ length: attempts }, (_, index) => {
    const accepted = state === "delivered" && index === attempts - 1;
    return {
      attempt: index + 1,
      at: 1_000 + index,
      httpStatus: accepted ? 202 : null,
      outcome: accepted ? "accepted" : "network_error",
    };
  }),
});

describe("sessionCallbackGroups", () => {
  it("keeps a received but stopped callback visible, and sorts that session first", () => {
    const quiet = webhook("a", {
      deliveries: [dispatch("done", "delivered")],
      deliveryHistory: [transport("done", "delivered", 1)],
    });
    const stopped = webhook("b", {
      deliveries: [dispatch("stopped", "terminal", "destination-paused-or-archived")],
      deliveryHistory: [transport("stopped", "delivered", 1)],
    });
    const { attentionCount, groups } = sessionCallbackGroups([quiet, stopped]);
    expect(attentionCount).toBe(1);
    expect(groups.map((group) => group.webhook.id)).toEqual(["b", "a"]);
    expect(groups[0]!.visible.map((event) => event.eventId)).toEqual(["stopped"]);
    expect(groups[1]!.visible).toEqual([]);
    expect(groups[1]!.history.map((event) => event.eventId)).toEqual(["done"]);
  });

  it("keeps a network retry visible beside a delivered event in the same session", () => {
    const mixed = webhook("c", {
      deliveries: [dispatch("done", "delivered")],
      deliveryHistory: [transport("done", "delivered", 1), transport("retry", "pending", 6)],
    });
    const [group] = sessionCallbackGroups([mixed]).groups;
    expect(group!.attentionCount).toBe(1);
    expect(group!.visible.map((event) => event.eventId)).toEqual(["retry"]);
    expect(group!.history.map((event) => event.eventId)).toEqual(["done"]);
  });
});
