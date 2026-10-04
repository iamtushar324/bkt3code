/** T3-CUSTOM(expbkt3): Server-owned Toolyard connection and browser handoff. */
import { useAtomValue } from "@effect/atom-react";
import { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import * as Option from "effect/Option";
import { useCallback, useEffect, useMemo, useState } from "react";
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
import {
  pendingToolyardSettingsContinuation,
  clearToolyardSettingsContinuation,
} from "../../fork/toolyardSettingsContinuation";
import { readBkManagedEnvironment } from "../../fork/managedEnvironment";
import {
  createToolyardSettingsContinuation,
  readToolyardSettingsContinuation,
  toolyardCommittedDraftMatches,
  toolyardSettingsFailureCode,
  toolyardSettingsFailureMessage,
  toolyardSettingsOrigin,
} from "@t3tools/client-runtime/toolyard-trust-setup";
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
  const setDraft = useCallback(
    (value: ToolyardSettingsDraft | null) => {
      writeToolyardSettingsDraft(draftKey, value);
      setDraftState(value);
    },
    [draftKey],
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [browserDraft, setBrowserDraft] = useState<ToolyardSettingsDraft | null>(null);
  const [continuationRead, setContinuationRead] = useState(false);
  const current = draft ?? {
    baseUrl: status?.baseUrl ?? "",
    enabled: status?.enabled ?? false,
    revision: status?.revision ?? 0,
  };
  const refresh = useCallback(() => appAtomRegistry.refresh(statusAtom), [statusAtom]);
  const environmentBrowserUrl = () => {
    // The authenticated primary connection owns the browser destination. MCP settings do not.
    const prepared = primary ? readPreparedConnection(primary) : null;
    return prepared?.httpBaseUrl && toolyardSettingsOrigin(prepared.httpBaseUrl)
      ? prepared.httpBaseUrl
      : null;
  };
  useEffect(() => {
    if (continuationRead || !primary || !status || !userScope.startsWith("user_")) return;
    const continuation = readToolyardSettingsContinuation(
      pendingToolyardSettingsContinuation() ?? window.location.hash,
      primary,
      userScope,
      window.location.origin,
      draft,
      Date.now(),
    );
    setContinuationRead(true);
    if (!continuation) return;
    clearToolyardSettingsContinuation();
    // Remove the public fragment after consumption; credentials never appear in this link.
    window.history.replaceState(
      window.history.state,
      "",
      window.location.pathname + window.location.search,
    );
    if (continuation.draft) setDraft(continuation.draft);
    setNotice(continuation.message);
  }, [continuationRead, primary, status, userScope, draft, setDraft]);
  useEffect(() => {
    if (!browserDraft) return;
    let attempts = 0;
    const timer = window.setInterval(() => {
      refresh();
      if (++attempts >= 40) {
        window.clearInterval(timer);
        setNotice(
          "Complete Save in the browser. Select Refresh here to read the server result. Your draft remains until the result matches.",
        );
      }
    }, 3000);
    return () => window.clearInterval(timer);
  }, [browserDraft, refresh]);
  useEffect(() => {
    if (!browserDraft || !status || !toolyardCommittedDraftMatches(browserDraft, status)) return;
    // An edit made after the handoff must remain a draft.
    if (
      draft &&
      draft.baseUrl === browserDraft.baseUrl &&
      draft.enabled === browserDraft.enabled &&
      draft.revision === browserDraft.revision
    )
      setDraft(null);
    setBrowserDraft(null);
    setNotice("The browser saved the matching settings. The server trust is verified.");
  }, [browserDraft, status, draft, setDraft]);
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
      environmentBrowserUrl(),
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
      else if (AsyncResult.isFailure(saved)) {
        const code = toolyardSettingsFailureCode(saved.cause);
        if (
          code === "admin_trust_registration_required" &&
          !adminToken &&
          !remove &&
          window.desktopBridge
        ) {
          const destination = environmentBrowserUrl();
          if (!destination) {
            setError(
              "This environment has no HTTPS browser address. Your draft remains. Ask its administrator to configure a public address.",
            );
            return;
          }
          const url = createToolyardSettingsContinuation(
            destination,
            primary,
            userScope,
            current,
            Date.now(),
          );
          const browser = createToolyardBrowserHandoffTarget();
          try {
            await browser.open(url);
            setBrowserDraft({ ...current });
            setNotice(
              "The default browser opened T3 Settings. Use the same account. Review the draft, then select Save and verify trust. Your desktop draft remains.",
            );
          } finally {
            browser.close();
          }
        } else
          setError(
            code === "admin_trust_registration_required" && !adminToken
              ? "Use a signed-in browser administrator account to verify server trust. Your draft remains."
              : toolyardSettingsFailureMessage(code),
          );
      }
    } catch {
      setError(
        "The settings or browser request failed. Your draft remains. Select Refresh, then try again.",
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
        {notice ? (
          <p role="status" className="my-2 text-xs text-muted-foreground">
            {notice}
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
                setNotice(null);
                setBrowserDraft(null);
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
