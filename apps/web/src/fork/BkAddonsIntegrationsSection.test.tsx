/** T3-CUSTOM(expbkt3): the production settings composition preserves the selected-server boundary. */
import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
const mocks = vi.hoisted(() => ({
  environments: [
    {
      environmentId: "stage",
      label: "Stage",
      connection: { phase: "connected" },
      serverConfig: { auth: { clerk: {} } },
    },
    {
      environmentId: "mac",
      label: "Mac",
      connection: { phase: "connected" },
      serverConfig: { auth: {} },
    },
    {
      environmentId: "offline",
      label: "Offline",
      connection: { phase: "offline" },
      serverConfig: null,
    },
  ],
}));
vi.mock("../components/settings/SettingsScopeContext", () => ({
  useSettingsScope: () => ({ environments: mocks.environments }),
}));
vi.mock("../components/settings/ToolyardSettingsSection", () => ({
  EnvironmentToolyardSettings: (props: object) => <div data-kind="connection" {...props} />,
}));
vi.mock("./SessionWebhookSettingsSection", () => ({
  EnvironmentSessionWebhookSettings: (props: object) => <div data-kind="callbacks" {...props} />,
}));
vi.mock("../components/ui/button", () => ({
  Button: ({ children, ...props }: { children: ReactNode }) => (
    <button {...props}>{children}</button>
  ),
}));
vi.mock("../components/ui/badge", () => ({
  Badge: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../components/settings/settingsLayout", () => ({
  SettingsSearchTarget: ({ children, ...props }: { children: ReactNode }) => (
    <div {...props}>{children}</div>
  ),
}));
import { BkAddonsIntegrationsSection } from "./BkAddonsIntegrationsSection";
let renderer: ReactTestRenderer;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});
afterEach(async () => {
  await act(() => renderer?.unmount());
  vi.unstubAllGlobals();
});
it("groups only selected connected servers and retains the offline server", async () => {
  await act(() => {
    renderer = create(<BkAddonsIntegrationsSection />);
  });
  const groups = renderer.root.findAllByType("section");
  expect(groups).toHaveLength(3);
  for (const [index, environmentId] of ["stage", "mac"].entries()) {
    const rows = groups[index]!.findAllByType("div").filter((row) => row.props["data-kind"]);
    expect(rows.map((row) => row.props["data-kind"])).toEqual(["connection", "callbacks"]);
    expect(rows[0]!.props.environment.environmentId).toBe(environmentId);
    expect(rows[1]!.props.environmentId).toBe(environmentId);
  }
  expect(groups[2]!.findAllByType("button")).toHaveLength(0);
  expect(JSON.stringify(renderer.toJSON())).toContain("Reconnect Offline");
  expect(
    renderer.root.findAllByType("div").filter((node) => node.props.id === "toolyard"),
  ).toHaveLength(1);
  expect(
    renderer.root.findAllByType("div").filter((node) => node.props.id === "session-webhooks"),
  ).toHaveLength(1);
});
it("refreshes only the chosen server's connection and callbacks", async () => {
  await act(() => {
    renderer = create(<BkAddonsIntegrationsSection />);
  });
  await act(() =>
    renderer.root
      .findByProps({ "aria-label": "Refresh connections and callbacks for Mac" })
      .props.onClick(),
  );
  const rows = renderer.root.findAllByType("div").filter((row) => row.props["data-kind"]);
  expect(rows.map((row) => row.props.refreshVersion)).toEqual([0, 0, 1, 1]);
});
