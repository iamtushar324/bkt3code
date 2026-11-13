/** T3-CUSTOM(expbkt3): group user-owned connections and callbacks by selected server. */
import { useEffect, useState } from "react";
import { ChevronRightIcon, RefreshCwIcon } from "lucide-react";
import { Button } from "../components/ui/button";
import { Badge } from "../components/ui/badge";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../components/ui/collapsible";
import { useSettingsScope } from "../components/settings/SettingsScopeContext";
import { SettingsGroup } from "../components/settings/SettingsGroup";
import {
  SettingsSearchTarget,
  SettingsSection,
  useSettingsSearchTargetId,
} from "../components/settings/settingsLayout";
import { EnvironmentToolyardSettings } from "../components/settings/ToolyardSettingsSection";
import { cn } from "../lib/utils";
import { BkAddonsServerSummary } from "./BkAddonsServerSummary";
import { EnvironmentDefaultCustomGroupSetting } from "./DefaultCustomGroupSetting";
import { EnvironmentSessionWebhookSettings } from "./SessionWebhookSettingsSection";
import { pendingToolyardSettingsContinuation } from "./toolyardSettingsContinuation";

type SelectedEnvironment = ReturnType<typeof useSettingsScope>["environments"][number];

/** Search results that land inside the first server's fold. */
const FIRST_SERVER_TARGETS: ReadonlyArray<string> = [
  "toolyard",
  "session-webhooks",
  "default-custom-group",
];

/** A Toolyard browser sign-in returns to this page; its card must be visible to report back. */
const toolyardReturnPending = () =>
  pendingToolyardSettingsContinuation() !== null ||
  window.location.hash.startsWith("#toolyard-settings=");

const FOLD_STORAGE_PREFIX = "t3-bk-addons-server-open:";

function readRememberedOpen(environmentId: string): boolean {
  try {
    return window.localStorage.getItem(FOLD_STORAGE_PREFIX + environmentId) === "1";
  } catch {
    return false;
  }
}

function ServerAddons({
  environment,
  first,
}: {
  readonly environment: SelectedEnvironment;
  readonly first: boolean;
}) {
  const [refreshVersion, setRefreshVersion] = useState(0);
  const serverConfig =
    environment.connection.phase === "connected" ? environment.serverConfig : null;
  const connecting =
    environment.connection.phase === "connecting" ||
    environment.connection.phase === "reconnecting";
  // Closed by default; each server's fold is remembered on this device.
  const [open, setOpen] = useState(
    () => toolyardReturnPending() || readRememberedOpen(environment.environmentId),
  );
  useEffect(() => {
    try {
      window.localStorage.setItem(
        FOLD_STORAGE_PREFIX + environment.environmentId,
        open ? "1" : "0",
      );
    } catch {
      // Storage can be blocked; the fold still works for this visit.
    }
  }, [environment.environmentId, open]);
  // A search jump lands inside the first server's fold, so open it before its target mounts.
  const searchTargetId = useSettingsSearchTargetId();
  const [seenSearchTargetId, setSeenSearchTargetId] = useState<string | null>(null);
  if (seenSearchTargetId !== searchTargetId) {
    setSeenSearchTargetId(searchTargetId);
    if (first && searchTargetId !== null && FIRST_SERVER_TARGETS.includes(searchTargetId))
      setOpen(true);
  }
  const sectionLabel = `BK Add-ons for ${environment.label}`;

  if (!serverConfig) {
    return (
      <section className="min-w-0 space-y-2" aria-label={sectionLabel}>
        <div className="flex min-h-9 flex-wrap items-center gap-2 px-3 sm:px-4">
          <h3 className="text-sm font-medium">{environment.label}</h3>
          <Badge variant="secondary">
            {connecting ? "Server connects" : "Server disconnected"}
          </Badge>
        </div>
        <SettingsSearchTarget id={first ? "session-webhooks" : undefined}>
          <p className="px-3 text-sm text-muted-foreground sm:px-4">
            {connecting
              ? `Wait for ${environment.label} to connect.`
              : `Reconnect ${environment.label} to inspect Toolyard and session callbacks.`}
          </p>
        </SettingsSearchTarget>
      </section>
    );
  }

  return (
    <section className="min-w-0" aria-label={sectionLabel}>
      <Collapsible open={open} onOpenChange={setOpen}>
        <div className="flex min-h-9 items-center gap-2 px-3 sm:px-4">
          <h3 className="min-w-0 flex-1">
            <CollapsibleTrigger className="flex w-full min-w-0 items-center gap-2 rounded-md py-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
              <ChevronRightIcon
                aria-hidden
                className={cn(
                  "size-4 shrink-0 text-muted-foreground transition-transform duration-150 motion-reduce:transition-none",
                  open && "rotate-90",
                )}
              />
              <span className="shrink-0 text-sm font-medium">{environment.label}</span>
              <Badge variant="secondary" className="shrink-0">
                {serverConfig.auth.clerk ? "Team server" : "Local profile"}
              </Badge>
              <span className="min-w-0 truncate text-xs font-normal text-muted-foreground">
                <BkAddonsServerSummary
                  environmentId={environment.environmentId}
                  serverConfig={serverConfig}
                />
              </span>
            </CollapsibleTrigger>
          </h3>
          <Button
            size="xs"
            variant="outline"
            className="shrink-0"
            aria-label={`Refresh connections and callbacks for ${environment.label}`}
            onClick={() => setRefreshVersion((version) => version + 1)}
          >
            <RefreshCwIcon />
            Refresh
          </Button>
        </div>
        {/* Kept mounted: Toolyard finishes a browser sign-in and drafts even while folded. */}
        <CollapsiblePanel keepMounted>
          <div className="space-y-6 pt-3">
            <SettingsSearchTarget id={first ? "default-custom-group" : undefined}>
              <SettingsGroup className="empty:hidden">
                <EnvironmentDefaultCustomGroupSetting
                  environmentId={environment.environmentId}
                  label={environment.label}
                  serverConfig={serverConfig}
                />
              </SettingsGroup>
            </SettingsSearchTarget>
            <EnvironmentToolyardSettings
              environment={{ ...environment, serverConfig }}
              compact
              refreshVersion={refreshVersion}
            />
            <SettingsSearchTarget id={first ? "session-webhooks" : undefined}>
              <EnvironmentSessionWebhookSettings
                environmentId={environment.environmentId}
                label={environment.label}
                serverConfig={serverConfig}
                compact
                refreshVersion={refreshVersion}
                expandRequested={first && searchTargetId === "session-webhooks"}
              />
            </SettingsSearchTarget>
          </div>
        </CollapsiblePanel>
      </Collapsible>
    </section>
  );
}

export function BkAddonsIntegrationsSection() {
  const { environments } = useSettingsScope();
  return (
    <SettingsSection id="toolyard" title="Connections" variant="plain">
      <div className="space-y-3">
        <p className="px-3 text-xs text-muted-foreground sm:px-4">
          Toolyard, session callbacks and the default group, saved per server for your account.
          The project selection filters this list.
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
      </div>
    </SettingsSection>
  );
}
