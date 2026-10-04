/** T3-CUSTOM(expbkt3): Server-owned Toolyard connection and browser handoff. */
import { useAtomValue } from "@effect/atom-react";
import { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import * as Option from "effect/Option";
import { useMemo, useState } from "react";
import { ExternalLinkIcon, RefreshCwIcon } from "lucide-react";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { useCurrentUserId } from "../../state/identity";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { readPreparedConnection } from "../../state/session";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { readTeamClerkToken } from "../../state/teamIdentityToken";
import {
  createToolyardBrowserHandoffTarget,
  type ToolyardBrowserHandoffTarget,
} from "../../fork/toolyardBrowserHandoff";
import {
  readToolyardSettingsDraft,
  writeToolyardSettingsDraft,
  toolyardDraftKey,
  type ToolyardSettingsDraft,
} from "../../fork/toolyardSettingsDraft";
import { readBkManagedEnvironment } from "../../fork/managedEnvironment";
import { usePrimarySettings } from "../../hooks/useSettings";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { SettingsRow, SettingsSection } from "./settingsLayout";

export function ToolyardSettingsSection() {
  const primary = usePrimaryEnvironmentId();
  const userId = useCurrentUserId();
  return (
    <ToolyardSettingsContent key={`${primary}:${userId}`} userScope={userId ?? "unverified"} />
  );
}
function ToolyardSettingsContent({ userScope }: { readonly userScope: string }) {
  const primary = usePrimaryEnvironmentId();
  const environmentId = primary ?? EnvironmentId.make("unavailable");
  const target = useMemo(
    () => ({ environmentId, input: { userScope } }),
    [environmentId, userScope],
  );
  const statusAtom = useMemo(() => serverEnvironment.toolyardIntegrationStatus(target), [target]);
  const result = useAtomValue(statusAtom);
  const status = Option.getOrNull(AsyncResult.value(result));
  const configure = useAtomCommand(
    serverEnvironment.configureToolyardIntegration,
    "Toolyard settings",
  );
  const handoff = useAtomCommand(serverEnvironment.openToolyardDashboard, "Open Toolyard");
  const publicMcpUrl = usePrimarySettings(
    (settings) => settings.experimental.externalMcp.publicUrl,
  );
  const draftKey = toolyardDraftKey(environmentId, userScope);
  const [draft, setDraftState] = useState<ToolyardSettingsDraft | null>(() =>
    readToolyardSettingsDraft(draftKey),
  );
  const setDraft = (value: ToolyardSettingsDraft | null) => {
    writeToolyardSettingsDraft(draftKey, value);
    setDraftState(value);
  };
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = draft ?? {
    baseUrl: status?.baseUrl ?? "",
    enabled: status?.enabled ?? false,
    revision: status?.revision ?? 0,
  };
  const refresh = () => appAtomRegistry.refresh(statusAtom);
  const origin = () => {
    if (status?.origin) return status.origin;
    // Direct web access names the verified server, even when a copied config is stale.
    const prepared = primary ? readPreparedConnection(primary) : null;
    if (prepared) {
      try {
        const actual = new URL(prepared.httpBaseUrl);
        if (actual.protocol === "https:" && actual.origin === window.location.origin)
          return actual.origin;
      } catch {
        /* Remote/relay uses the server's configured public endpoint below. */
      }
    }
    for (const value of [
      publicMcpUrl,
      readBkManagedEnvironment()?.httpBaseUrl,
      window.location.origin,
    ]) {
      if (!value) continue;
      try {
        const url = new URL(value);
        if (url.protocol === "https:") return url.origin;
      } catch {
        /* Next authenticated environment origin. */
      }
    }
    return "";
  };
  const save = async (remove = false) => {
    if (!primary || !status) return;
    setBusy(true);
    setError(null);
    try {
      const adminToken = await readTeamClerkToken();
      const saved = await configure({
        environmentId: primary,
        input: {
          expectedRevision: current.revision,
          baseUrl: current.baseUrl,
          origin: origin(),
          enabled: current.enabled,
          remove,
          ...(adminToken ? { adminToken } : {}),
        },
      });
      refresh();
      if (AsyncResult.isSuccess(saved)) setDraft(null);
      else
        setError(
          "The settings did not save. Your draft remains. Refresh the server status before another attempt.",
        );
    } finally {
      setBusy(false);
    }
  };
  const open = async () => {
    if (!primary) return;
    setBusy(true);
    setError(null);
    let browser: ToolyardBrowserHandoffTarget | null = null;
    try {
      browser = createToolyardBrowserHandoffTarget();
      const response = await handoff({ environmentId: primary, input: {} });
      if (!AsyncResult.isSuccess(response)) {
        setError("Toolyard could not create a browser handoff. Check the connection status.");
        return;
      }
      // shell.openExternal always invokes the device browser, independent of integrated-link preferences.
      await browser.open(response.value.url);
    } catch {
      setError("The default browser did not open. Try Open Toolyard again.");
    } finally {
      browser?.close();
      setBusy(false);
    }
  };
  return (
    <SettingsSection title="Toolyard">
      <SettingsRow
        title="Connection"
        description="T3 owns your connection on this server. Credentials stay on the server. Toolyard asks you for each Inbox decision."
        status={
          status ? `${status.connection}${status.email ? ` · ${status.email}` : ""}` : "Unavailable"
        }
        control={
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={refresh} disabled={busy}>
              <RefreshCwIcon />
              Refresh
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void open()}
              disabled={busy || status?.connection !== "connected"}
            >
              <ExternalLinkIcon />
              Open Toolyard
            </Button>
          </div>
        }
      >
        {status?.removed ? (
          <p className="my-2 text-xs text-muted-foreground">
            The administrator removed this instance. T3 will not restore it automatically.
          </p>
        ) : null}
        {status && status.revocationPending > 0 ? (
          <p role="alert" className="my-2 text-xs text-destructive-foreground">
            Remote permission cleanup is pending for {status.revocationPending} instance(s). T3 will
            retry it.
          </p>
        ) : null}
        {status?.expiresAt ? (
          <p className="my-2 text-xs text-muted-foreground">
            Connection expires {new Date(status.expiresAt).toLocaleString()}.
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="my-2 text-xs text-destructive-foreground">
            {error}
          </p>
        ) : null}
      </SettingsRow>
      {status?.administrator ? (
        <>
          <SettingsRow
            title="Hosted instance"
            description="Use one HTTPS Toolyard instance for this environment. A replacement requires a new server trust registration."
            control={
              <Input
                aria-label="Toolyard base URL"
                className="w-full sm:w-80"
                value={current.baseUrl}
                placeholder="https://toolyard.dev.beknown.live"
                onChange={(event) => setDraft({ ...current, baseUrl: event.target.value })}
              />
            }
          />
          <SettingsRow
            title="Enable integration"
            description="Enable automatic access for eligible team members. Disable it to stop new Toolyard requests."
            control={
              <Switch
                aria-label="Enable Toolyard integration"
                checked={current.enabled}
                onCheckedChange={(enabled) => setDraft({ ...current, enabled: Boolean(enabled) })}
              />
            }
          />
          {draft && status.revision !== draft.revision ? (
            <p role="alert" className="px-4 pb-2 text-xs text-destructive-foreground">
              Your draft uses revision {draft.revision}. The current server revision is{" "}
              {status.revision}.
              <Button
                size="sm"
                variant="outline"
                onClick={() => setDraft({ ...draft, revision: status.revision })}
              >
                Use current revision
              </Button>
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2 px-4 pb-4">
            <Button
              size="sm"
              disabled={busy || (!draft && !status.removed)}
              onClick={() => void save()}
            >
              Save and verify trust
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy || !draft}
              onClick={() => {
                setDraft(null);
                setError(null);
              }}
            >
              Discard
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy || !status.baseUrl || status.removed}
              onClick={() => void save(true)}
            >
              Remove instance
            </Button>
          </div>
        </>
      ) : null}
    </SettingsSection>
  );
}
