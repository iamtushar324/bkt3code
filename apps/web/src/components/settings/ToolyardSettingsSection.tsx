/** T3-CUSTOM(expbkt3): Server-owned Toolyard connection and browser handoff. */
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ServerConfig } from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import * as Option from "effect/Option";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ExternalLinkIcon, RefreshCwIcon } from "lucide-react";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { currentClerkUserAtom } from "../../state/identity";
import { readPreparedConnection, useEnvironmentSessionState } from "../../state/session";
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
import {
  createToolyardSettingsContinuation,
  readToolyardSettingsContinuation,
  toolyardCommittedDraftMatches,
  toolyardSettingsFailureCode,
  toolyardSettingsFailureMessage,
  toolyardSettingsOrigin,
} from "@t3tools/client-runtime/toolyard-trust-setup";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";

interface ToolyardSettingsEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly serverConfig: ServerConfig;
}
export function ToolyardSettingsSection() {
  const { connectedEnvironments } = useSettingsScope();
  return connectedEnvironments.length === 0 ? (
    <SettingsSection title="Toolyard">
      <p className="text-sm text-muted-foreground">
        Connect a selected server to configure Toolyard.
      </p>
    </SettingsSection>
  ) : (
    connectedEnvironments.map((environment) =>
      environment.serverConfig ? (
        <EnvironmentToolyardSettings
          key={environment.environmentId}
          environment={{ ...environment, serverConfig: environment.serverConfig }}
        />
      ) : null,
    )
  );
}
function EnvironmentToolyardSettings({
  environment,
}: {
  readonly environment: ToolyardSettingsEnvironment;
}) {
  const { data: session } = useEnvironmentSessionState(environment.environmentId);
  // The selected server verifies the user. Primary-server identity cannot select this credential.
  const userScope = session?.authenticated
    ? (session.userId ?? (environment.serverConfig.auth.clerk ? null : "local-user"))
    : null;
  return userScope ? (
    <ToolyardSettingsContent
      key={`${environment.environmentId}:${userScope}`}
      environment={environment}
      userScope={userScope}
    />
  ) : (
    <SettingsSection title={`Toolyard — ${environment.label}`}>
      <p className="text-sm text-muted-foreground">
        Authenticate with this server to configure Toolyard.
      </p>
    </SettingsSection>
  );
}
function ToolyardSettingsContent({
  environment,
  userScope,
}: {
  readonly environment: ToolyardSettingsEnvironment;
  readonly userScope: string;
}) {
  const environmentId = environment.environmentId;
  const clerkUserId = useAtomValue(currentClerkUserAtom);
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
  const publicMcpUrl = environment.serverConfig.settings.experimental.externalMcp.publicUrl;
  const draftKey = toolyardDraftKey(environmentId, userScope);
  const [draft, setDraftState] = useState<ToolyardSettingsDraft | null>(() =>
    readToolyardSettingsDraft(draftKey),
  );
  const draftRef = useRef(draft);
  const setDraft = useCallback(
    (value: ToolyardSettingsDraft | null) => {
      draftRef.current = value;
      writeToolyardSettingsDraft(draftKey, value);
      setDraftState(value);
    },
    [draftKey],
  );
  // The submitted key never enters a persisted draft or browser continuation.
  const [apiKey, setApiKey] = useState("");
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
  const mode = current.mode ?? status?.mode ?? "team";
  const modeChange = status?.connection === "connected" && mode !== (status.mode ?? "team");
  const canDisconnect =
    status?.connection === "connected" && (status.mode === "api-key" || modeChange);
  const refresh = useCallback(() => appAtomRegistry.refresh(statusAtom), [statusAtom]);
  const environmentBrowserUrl = () => {
    // This server's authenticated connection owns the browser destination.
    const prepared = readPreparedConnection(environmentId);
    return prepared?.httpBaseUrl && toolyardSettingsOrigin(prepared.httpBaseUrl)
      ? prepared.httpBaseUrl
      : null;
  };
  useEffect(() => {
    if (continuationRead || !status || !userScope.startsWith("user_")) return;
    const fragment = pendingToolyardSettingsContinuation() ?? window.location.hash;
    // Multiple selected servers must not consume another server's public continuation.
    if (fragment.startsWith("#toolyard-settings=")) {
      try {
        const payload = JSON.parse(
          decodeURIComponent(fragment.slice("#toolyard-settings=".length)),
        ) as { environmentId?: unknown };
        if (typeof payload.environmentId === "string" && payload.environmentId !== environmentId)
          return;
      } catch {
        // The bounded decoder below explains malformed links without applying their contents.
      }
    }
    const continuation = readToolyardSettingsContinuation(
      fragment,
      environmentId,
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
  }, [continuationRead, environmentId, status, userScope, draft, setDraft]);
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
      draft.revision === browserDraft.revision &&
      draft.mode === browserDraft.mode
    )
      setDraft(null);
    setBrowserDraft(null);
    setNotice("The browser saved the matching settings. The server trust is verified.");
  }, [browserDraft, status, draft, setDraft]);
  const origin = () => {
    if (status?.origin) return status.origin;
    // Direct web access names the verified server, even when a copied config is stale.
    const prepared = readPreparedConnection(environmentId);
    if (prepared) {
      try {
        const actual = new URL(prepared.httpBaseUrl);
        if (actual.protocol === "https:" && actual.origin === window.location.origin)
          return actual.origin;
      } catch {
        /* Remote/relay uses the server's configured public endpoint below. */
      }
    }
    for (const value of [environmentBrowserUrl(), publicMcpUrl]) {
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
  const save = async (remove = false, disconnect = false) => {
    if (!status) return;
    setBusy(true);
    setError(null);
    try {
      const submittedKey = apiKey;
      const submittedDraft = draft;
      const adminToken =
        mode === "team" && !disconnect && clerkUserId === userScope
          ? await readTeamClerkToken()
          : null;
      const saved = await configure({
        environmentId,
        input: {
          expectedRevision: current.revision,
          baseUrl: current.baseUrl,
          origin: origin(),
          enabled: current.enabled,
          remove,
          mode,
          ...(disconnect ? { disconnect: true } : {}),
          ...(mode === "api-key" && submittedKey && !remove && !disconnect
            ? { apiKey: submittedKey }
            : {}),
          ...(adminToken ? { adminToken } : {}),
        },
      });
      refresh();
      if (AsyncResult.isSuccess(saved)) {
        // A newer edit remains a draft after this request completes.
        if (!disconnect && draftRef.current === submittedDraft) setDraft(null);
        if (!disconnect) setApiKey((value) => (value === submittedKey ? "" : value));
        setNotice(
          disconnect
            ? "Your Toolyard connection was removed."
            : mode === "api-key"
              ? "Your API key connection is ready. Local decisions arrive through outbound requests."
              : null,
        );
      } else if (AsyncResult.isFailure(saved)) {
        const code = toolyardSettingsFailureCode(saved.cause);
        if (
          mode === "team" &&
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
            environmentId,
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
              : toolyardSettingsFailureMessage(
                  mode === "api-key" && code === "invalid_assertion" ? "invalid_api_key" : code,
                ),
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
    setBusy(true);
    setError(null);
    let browser: ToolyardBrowserHandoffTarget | null = null;
    try {
      browser = createToolyardBrowserHandoffTarget();
      const response = await handoff({ environmentId, input: {} });
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
    <SettingsSection title={`Toolyard — ${environment.label}`}>
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
      {status?.apiKeyAllowed ? (
        <>
          <SettingsRow
            title="Connection method"
            description="Use team access or your own Toolyard API key on this server. Each user has a separate connection."
            control={
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant={mode === "team" ? "default" : "outline"}
                  aria-pressed={mode === "team"}
                  disabled={busy || status.teamAvailable === false}
                  onClick={() => {
                    setApiKey("");
                    setDraft({ ...current, mode: "team" });
                  }}
                >
                  Team connection
                </Button>
                <Button
                  size="sm"
                  variant={mode === "api-key" ? "default" : "outline"}
                  aria-pressed={mode === "api-key"}
                  disabled={busy}
                  onClick={() => {
                    setApiKey("");
                    setDraft({ ...current, mode: "api-key", enabled: true });
                  }}
                >
                  API key connection
                </Button>
              </div>
            }
          >
            {status.teamAvailable === false ? (
              <p className="my-2 text-xs text-muted-foreground">
                This server has no verified team identity. Use your Toolyard API key.
              </p>
            ) : null}
            {modeChange ? (
              <p role="alert" className="my-2 text-xs text-muted-foreground">
                Select Disconnect my account before you save a different connection method. Team
                access requires administrator authorization.
              </p>
            ) : null}
          </SettingsRow>
          {mode === "api-key" ? (
            <SettingsRow
              title="Your API key"
              description="Enter a Toolyard agent API key. T3 stores a separate server credential. Decisions can arrive while your browser is closed."
              control={
                <Input
                  aria-label="Toolyard API key"
                  type="password"
                  autoComplete="off"
                  className="w-full sm:w-80"
                  value={apiKey}
                  placeholder="Enter your Toolyard API key"
                  onChange={(event) => setApiKey(event.target.value)}
                />
              }
            >
              {!status.administrator && !status.baseUrl ? (
                <p role="alert" className="my-2 text-xs text-muted-foreground">
                  An administrator must set the Toolyard URL for this server first.
                </p>
              ) : null}
            </SettingsRow>
          ) : null}
        </>
      ) : null}
      {status?.administrator ? (
        <>
          <SettingsRow
            title="Hosted instance"
            description="Use one HTTPS Toolyard instance for this server. API key access does not require a public address for your Mac."
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
            description="Enable Toolyard access on this server. Disable it to stop new Toolyard requests."
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
        </>
      ) : null}
      {status && (status.administrator || mode === "api-key" || canDisconnect) ? (
        <div className="flex flex-wrap gap-2 px-4 pb-4">
          <Button
            size="sm"
            disabled={
              busy ||
              modeChange ||
              (mode === "team" && status.teamAvailable === false) ||
              (!draft && !apiKey && !status.removed) ||
              (mode === "api-key" && !status.baseUrl && !status.administrator)
            }
            onClick={() => void save()}
          >
            {mode === "api-key" ? "Save and connect" : "Save and verify trust"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || (!draft && !apiKey)}
            onClick={() => {
              setDraft(null);
              setApiKey("");
              setError(null);
              setNotice(null);
              setBrowserDraft(null);
            }}
          >
            Discard
          </Button>
          {canDisconnect ? (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void save(false, true)}
            >
              Disconnect my account
            </Button>
          ) : null}
          {status.administrator ? (
            <Button
              size="sm"
              variant="outline"
              disabled={busy || !status.baseUrl || status.removed}
              onClick={() => void save(true)}
            >
              Remove instance
            </Button>
          ) : null}
        </div>
      ) : null}
    </SettingsSection>
  );
}
