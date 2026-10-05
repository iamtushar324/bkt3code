/** T3-CUSTOM(expbkt3): group user-owned connections and callbacks by selected server. */
import { useState } from "react";
import { RefreshCwIcon } from "lucide-react";
import { Button } from "../components/ui/button";
import { Badge } from "../components/ui/badge";
import { useSettingsScope } from "../components/settings/SettingsScopeContext";
import { SettingsSearchTarget } from "../components/settings/settingsLayout";
import { EnvironmentToolyardSettings } from "../components/settings/ToolyardSettingsSection";
import { EnvironmentSessionWebhookSettings } from "./SessionWebhookSettingsSection";

type SelectedEnvironment = ReturnType<typeof useSettingsScope>["environments"][number];

function ServerAddons({
  environment,
  first,
}: {
  readonly environment: SelectedEnvironment;
  readonly first: boolean;
}) {
  const [refreshVersion, setRefreshVersion] = useState(0);
  const connected = environment.connection.phase === "connected" && environment.serverConfig;
  const connecting =
    environment.connection.phase === "connecting" ||
    environment.connection.phase === "reconnecting";
  return (
    <section className="min-w-0 space-y-3" aria-label={`BK Add-ons for ${environment.label}`}>
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 sm:px-4">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <h2 className="text-sm font-medium">{environment.label}</h2>
          <Badge variant="secondary">
            {connected
              ? environment.serverConfig?.auth.clerk
                ? "Team server"
                : "Local profile"
              : connecting
                ? "Server connects"
                : "Server disconnected"}
          </Badge>
        </div>
        {connected ? (
          <Button
            size="sm"
            variant="outline"
            aria-label={`Refresh connections and callbacks for ${environment.label}`}
            onClick={() => setRefreshVersion((version) => version + 1)}
          >
            <RefreshCwIcon />
            Refresh
          </Button>
        ) : null}
      </div>
      {connected && environment.serverConfig ? (
        <>
          <EnvironmentToolyardSettings
            environment={{ ...environment, serverConfig: environment.serverConfig }}
            compact
            refreshVersion={refreshVersion}
          />
          <SettingsSearchTarget id={first ? "session-webhooks" : undefined}>
            <EnvironmentSessionWebhookSettings
              environmentId={environment.environmentId}
              label={environment.label}
              serverConfig={environment.serverConfig}
              compact
              refreshVersion={refreshVersion}
            />
          </SettingsSearchTarget>
        </>
      ) : (
        <SettingsSearchTarget id={first ? "session-webhooks" : undefined}>
          <p className="px-3 text-sm text-muted-foreground sm:px-4">
            {connecting
              ? `Wait for ${environment.label} to connect.`
              : `Reconnect ${environment.label} to inspect Toolyard and session callbacks.`}
          </p>
        </SettingsSearchTarget>
      )}
    </section>
  );
}

export function BkAddonsIntegrationsSection() {
  const { environments } = useSettingsScope();
  return (
    <SettingsSearchTarget id="toolyard" className="space-y-6">
      <p className="px-3 text-sm text-muted-foreground sm:px-4">
        Connections are saved per server for your account. The project selection filters the server
        list.
      </p>
      {environments.length === 0 ? (
        <SettingsSearchTarget id="session-webhooks">
          <p className="px-3 text-sm text-muted-foreground sm:px-4">
            Select a server to inspect Toolyard and session callbacks.
          </p>
        </SettingsSearchTarget>
      ) : (
        environments.map((environment, index) => (
          <ServerAddons
            key={environment.environmentId}
            environment={environment}
            first={index === 0}
          />
        ))
      )}
    </SettingsSearchTarget>
  );
}
