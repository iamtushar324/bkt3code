/** T3-CUSTOM(expbkt3): the production settings composition preserves the selected-server boundary. */
import type { ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../test/render";

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
vi.mock(import("../components/settings/SettingsScopeContext"), async (original) => ({
  ...(await original()),
  useSettingsScope: (() => ({ environments: mocks.environments })) as never,
}));
// The stand-ins write the props the section hands each server's rows into the DOM.
vi.mock(import("../components/settings/ToolyardSettingsSection"), async (original) => ({
  ...(await original()),
  EnvironmentToolyardSettings: (({
    environment,
    refreshVersion,
  }: {
    environment: { environmentId: string };
    refreshVersion: number;
  }) => (
    <div
      data-kind="connection"
      data-environment-id={environment.environmentId}
      data-refresh-version={refreshVersion}
    />
  )) as never,
}));
vi.mock(import("./SessionWebhookSettingsSection"), async (original) => ({
  ...(await original()),
  EnvironmentSessionWebhookSettings: (({
    environmentId,
    refreshVersion,
  }: {
    environmentId: string;
    refreshVersion: number;
  }) => (
    <div
      data-kind="callbacks"
      data-environment-id={environmentId}
      data-refresh-version={refreshVersion}
    />
  )) as never,
}));
vi.mock(import("../components/settings/settingsLayout"), async (original) => ({
  ...(await original()),
  SettingsSearchTarget: (({ children, id }: { children: ReactNode; id?: string }) => (
    <div id={id}>{children}</div>
  )) as never,
}));

import { BkAddonsIntegrationsSection } from "./BkAddonsIntegrationsSection";

const rowsIn = (root: ParentNode) => [...root.querySelectorAll<HTMLElement>("[data-kind]")];

it("groups only selected connected servers and retains the offline server", async () => {
  await using screen = await render(<BkAddonsIntegrationsSection />);
  const groups = [...screen.container.querySelectorAll("section")];
  expect(groups).toHaveLength(3);
  for (const [index, environmentId] of ["stage", "mac"].entries()) {
    const rows = rowsIn(groups[index]!);
    expect(rows.map((row) => row.dataset.kind)).toEqual(["connection", "callbacks"]);
    expect(rows[0]!.dataset.environmentId).toBe(environmentId);
    expect(rows[1]!.dataset.environmentId).toBe(environmentId);
  }
  expect(groups[2]!.querySelectorAll("button")).toHaveLength(0);
  expect(screen.container.textContent).toContain("Reconnect Offline");
  expect(screen.container.querySelectorAll("#toolyard")).toHaveLength(1);
  expect(screen.container.querySelectorAll("#session-webhooks")).toHaveLength(1);
});

it("refreshes only the chosen server's connection and callbacks", async () => {
  await using screen = await render(<BkAddonsIntegrationsSection />);
  await userEvent.click(
    screen.getByRole("button", { name: "Refresh connections and callbacks for Mac" }),
  );
  expect(rowsIn(screen.container).map((row) => row.dataset.refreshVersion)).toEqual([
    "0",
    "0",
    "1",
    "1",
  ]);
});
