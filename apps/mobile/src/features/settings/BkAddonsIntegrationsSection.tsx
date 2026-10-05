/** T3-CUSTOM(expbkt3): BK Add-ons — Toolyard, then session callbacks, for each selected server. */
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { useEnvironments, type EnvironmentPresentation } from "../../state/environments";
import { environmentSession } from "../../state/session";
import { SettingsSection } from "./components/SettingsSection";
import { SessionCallbacksServerSettings } from "./SessionWebhooksSettingsSection";
import { useSettingsEnvironmentFilter, type SettingsTarget } from "./settings-environment-filter";
import { BkAddonButton, ToolyardServerSettings } from "./ToolyardSettingsSection";

/**
 * Servers in the current environment filter, in catalog order. A selected server that is
 * not connected stays listed without a target, so it shows a reconnect note instead of vanishing.
 */
export function bkAddonsServers(
  environments: ReadonlyArray<EnvironmentPresentation>,
  selectedTargets: ReadonlyArray<SettingsTarget>,
  selectedIds: ReadonlySet<EnvironmentId> | null,
) {
  return environments
    .filter((entry) => selectedIds === null || selectedIds.has(entry.environmentId))
    .map((environment) => ({
      environment,
      target:
        selectedTargets.find((target) => target.environmentId === environment.environmentId) ??
        null,
    }));
}

export function BkAddonsIntegrationsSection() {
  const { selectedTargets, selectedIds } = useSettingsEnvironmentFilter();
  const { environments } = useEnvironments();
  const servers = bkAddonsServers(environments, selectedTargets, selectedIds);
  return (
    <View className="gap-3">
      <SettingsSection title="BK Add-ons">
        <View className="gap-1 p-4">
          <Text className="text-sm text-foreground-muted">
            Connections are saved per server for your account. The environment filter chooses which
            servers appear here; a project selection does not create a separate connection.
          </Text>
          {servers.length === 0 ? (
            <Text className="text-sm text-foreground-muted">
              No server is selected. Choose a server in the environment filter.
            </Text>
          ) : null}
        </View>
      </SettingsSection>
      {servers.map(({ environment, target }) =>
        target ? (
          <BkAddonsServerGroup key={environment.environmentId} target={target} />
        ) : (
          <SettingsSection key={environment.environmentId} title={environment.label}>
            <Text className="p-4 text-sm text-foreground-muted">
              {environment.connection.phase === "connecting" ||
              environment.connection.phase === "reconnecting"
                ? "Connecting to this server. Toolyard and session callbacks appear once it is connected."
                : "This server is not connected. Reconnect it in Environments to manage Toolyard and session callbacks."}
            </Text>
          </SettingsSection>
        ),
      )}
    </View>
  );
}

function BkAddonsServerGroup({ target }: { readonly target: SettingsTarget }) {
  const session = useAtomValue(environmentSession.sessionStateValueAtom(target.environmentId));
  // The scope comes from this server's own authenticated session, never another environment.
  const userScope = session?.authenticated
    ? (session.userId ?? (target.serverConfig.auth.clerk ? null : "local-user"))
    : null;
  const [refreshToken, setRefreshToken] = useState(0);
  const account =
    userScope === null
      ? "Not authenticated"
      : userScope === "local-user"
        ? "Local profile"
        : target.serverConfig.auth.clerk
          ? "Team account"
          : "Signed-in account";
  return (
    <SettingsSection
      title={`${target.label} · ${account}`}
      trailing={
        userScope ? (
          <BkAddonButton
            label="Refresh"
            accessibilityLabel={`Refresh Toolyard and session callbacks for ${target.label}`}
            onPress={() => setRefreshToken((value) => value + 1)}
          />
        ) : null
      }
    >
      {userScope ? (
        <>
          <ToolyardServerSettings
            target={target}
            userScope={userScope}
            refreshToken={refreshToken}
          />
          <View className="h-px bg-separator" />
          <SessionCallbacksServerSettings
            target={target}
            userScope={userScope}
            refreshToken={refreshToken}
          />
        </>
      ) : (
        <Text className="p-4 text-sm text-foreground-muted">
          Authenticate with this server to manage Toolyard and session callbacks.
        </Text>
      )}
    </SettingsSection>
  );
}
