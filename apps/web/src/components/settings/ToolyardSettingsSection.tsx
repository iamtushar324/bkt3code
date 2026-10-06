/** T3-CUSTOM(expbkt3): Server-owned Toolyard connection and browser handoff. */
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ServerConfig } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import * as Option from "effect/Option";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CheckIcon,
  ChevronRightIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleXIcon,
  ClockIcon,
  CopyIcon,
  ExternalLinkIcon,
  RefreshCwIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { currentClerkUserAtom } from "../../state/identity";
import { readPreparedConnection, useEnvironmentSessionState } from "../../state/session";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { readTeamClerkToken } from "../../state/teamIdentityToken";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { cn } from "../../lib/utils";
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
import {
  shortToolyardId,
  toolyardConnectionPresentation,
  type ToolyardConnectionTone,
} from "@t3tools/client-runtime/bk-toolyard-presentation";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Input } from "../ui/input";
import { Radio, RadioGroup } from "../ui/radio-group";
import { Switch } from "../ui/switch";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";

function checkedConsentUrl(value: string | null, baseUrl: string | null): string {
  if (!value) throw new Error("The server has not received the consent address yet.");
  const url = new URL(value);
  if (
    !baseUrl ||
    url.protocol !== "https:" ||
    url.origin !== new URL(baseUrl).origin ||
    url.username ||
    url.password
  )
    throw new Error("The Toolyard consent destination does not match this instance.");
  return url.href;
}
function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
const toneIcons: Record<ToolyardConnectionTone, typeof CircleCheckIcon> = {
  success: CircleCheckIcon,
  warning: TriangleAlertIcon,
  error: CircleXIcon,
  info: ClockIcon,
  secondary: CircleDashedIcon,
};
/** A fold the user controls, opened automatically when it starts holding something that needs attention. */
function useAttentionDisclosure(attention: boolean) {
  const [open, setOpen] = useState(attention);
  const [previous, setPrevious] = useState(attention);
  if (previous !== attention) {
    setPrevious(attention);
    if (attention) setOpen(true);
  }
  return [open, setOpen] as const;
}
function FoldTrigger({
  label,
  open,
  children,
}: {
  readonly label: string;
  readonly open: boolean;
  readonly children: string;
}) {
  return (
    <CollapsibleTrigger aria-label={label} render={<Button size="xs" variant="ghost-muted" />}>
      <ChevronRightIcon
        aria-hidden
        className={cn(
          "transition-transform duration-150 motion-reduce:transition-none",
          open && "rotate-90",
        )}
      />
      {children}
    </CollapsibleTrigger>
  );
}
export interface ToolyardSettingsEnvironment {
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
/**
 * One server's Toolyard card. `compact` drops the server suffix and own Refresh for a per-server
 * group; a changed `refreshVersion` re-reads the status.
 */
export function EnvironmentToolyardSettings({
  environment,
  refreshVersion,
  compact = false,
}: {
  readonly environment: ToolyardSettingsEnvironment;
  readonly refreshVersion?: number;
  readonly compact?: boolean;
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
      compact={compact}
      {...(refreshVersion === undefined ? {} : { refreshVersion })}
    />
  ) : (
    <SettingsSection title={compact ? "Toolyard" : `Toolyard — ${environment.label}`}>
      <p className="px-3 py-3 text-sm text-muted-foreground sm:px-4">
        Authenticate with this server to configure Toolyard.
      </p>
    </SettingsSection>
  );
}
function ToolyardSettingsContent({
  environment,
  userScope,
  refreshVersion,
  compact,
}: {
  readonly environment: ToolyardSettingsEnvironment;
  readonly userScope: string;
  readonly refreshVersion?: number;
  readonly compact: boolean;
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
  const [confirmOpen, setConfirmOpen] = useState(false);
  // Kept after close so the dialog text does not change during its exit transition.
  const [confirmAction, setConfirmAction] = useState<"disconnect" | "remove">("disconnect");
  const [detailsOpen, setDetailsOpen] = useState(false);
  const summaryRef = useRef<HTMLDivElement>(null);
  const { copyToClipboard, isCopied } = useCopyToClipboard<string>({
    target: "Toolyard identifier",
  });
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const current = draft ?? {
    baseUrl: status?.baseUrl ?? "",
    enabled: status?.enabled ?? false,
    revision: status?.revision ?? 0,
  };
  const mode = current.mode ?? status?.mode ?? "team";
  const modeChange = status?.connection === "connected" && mode !== (status.mode ?? "team");
  const canDisconnect =
    status?.connection === "connected" &&
    (status.mode === "api-key" || status.mode === "host" || modeChange);
  const view = toolyardConnectionPresentation(status);
  const pendingRequest =
    status?.pendingConnection?.status === "pending" ? status.pendingConnection : null;
  const revisionConflict = draft !== null && status !== null && status.revision !== draft.revision;
  const setupDraft =
    draft !== null &&
    status !== null &&
    (draft.baseUrl !== (status.baseUrl ?? "") || draft.enabled !== status.enabled);
  const [manageOpen, setManageOpen] = useAttentionDisclosure(modeChange);
  const [setupOpen, setSetupOpen] = useAttentionDisclosure(
    Boolean(
      status?.administrator &&
      (setupDraft || revisionConflict || browserDraft || !status.baseUrl || status.removed),
    ),
  );
  const refresh = useCallback(() => appAtomRegistry.refresh(statusAtom), [statusAtom]);
  const seenRefreshVersion = useRef(refreshVersion);
  useEffect(() => {
    // The grouped server Refresh re-reads this status; mounting already reads it once.
    if (seenRefreshVersion.current === refreshVersion) return;
    seenRefreshVersion.current = refreshVersion;
    refresh();
  }, [refreshVersion, refresh]);
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
    if (status?.pendingConnection?.status !== "pending") return;
    const timer = window.setInterval(refresh, 3000);
    return () => window.clearInterval(timer);
  }, [status?.pendingConnection?.status, refresh]);
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
  const save = async (remove = false, disconnect = false, hostAction?: "begin" | "cancel") => {
    if (!status) return;
    setBusy(true);
    setError(null);
    let hostBrowser: ToolyardBrowserHandoffTarget | null = null;
    try {
      if (mode === "host" && current.enabled && !remove && !disconnect && hostAction !== "cancel")
        hostBrowser = createToolyardBrowserHandoffTarget();
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
          ...(mode === "host" && current.enabled && !remove && !disconnect
            ? { hostAction: hostAction ?? "begin" }
            : {}),
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
        if (
          hostBrowser &&
          saved.value.pendingConnection?.status === "pending" &&
          saved.value.pendingConnection.authorizationUrl
        ) {
          await hostBrowser.open(
            checkedConsentUrl(saved.value.pendingConnection.authorizationUrl, saved.value.baseUrl),
          );
        }
        setNotice(
          remove
            ? "The Toolyard instance was removed from this server."
            : mode === "host" && !disconnect
              ? hostAction === "cancel"
                ? "The connection request was cancelled."
                : null
              : disconnect
                ? "Your Toolyard connection was removed."
                : mode === "api-key"
                  ? "Your API key connection is ready. Local decisions arrive through outbound requests."
                  : null,
        );
        // The confirmed action can remove the control that held focus.
        if (remove || disconnect) summaryRef.current?.focus();
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
      hostBrowser?.close();
      setBusy(false);
    }
  };
  const cancelConsent = async () => {
    if (!status?.baseUrl) return;
    setBusy(true);
    setError(null);
    try {
      const saved = await configure({
        environmentId,
        input: {
          expectedRevision: status.revision,
          baseUrl: status.baseUrl,
          origin: status.origin ?? "",
          enabled: true,
          mode: "host",
          hostAction: "cancel",
        },
      });
      refresh();
      if (!AsyncResult.isSuccess(saved))
        setError("The connection request could not be cancelled. Select Refresh, then try again.");
    } catch {
      setError("The connection request could not be cancelled. Select Refresh, then try again.");
    } finally {
      setBusy(false);
    }
  };
  const resumeConsent = async () => {
    if (!status?.pendingConnection) return;
    let browser: ToolyardBrowserHandoffTarget | null = null;
    setError(null);
    try {
      browser = createToolyardBrowserHandoffTarget();
      await browser.open(
        checkedConsentUrl(status.pendingConnection.authorizationUrl, status.baseUrl),
      );
    } catch {
      setError("The browser did not open the consent page. Select Refresh, then try again.");
    } finally {
      browser?.close();
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
  const askToConfirm = (action: "disconnect" | "remove") => {
    setConfirmAction(action);
    setConfirmOpen(true);
  };
  const chooseMode = (next: "team" | "api-key" | "host") => {
    setApiKey("");
    setDraft({ ...current, mode: next, ...(next === "team" ? {} : { enabled: true }) });
  };
  const label = environment.label;
  const StatusIcon = toneIcons[view.tone];
  const retryable = view.phase === "unavailable" || AsyncResult.isFailure(result);
  // Only a state with something to submit offers the main connect action.
  const showSave =
    status !== null &&
    (draft !== null ||
      apiKey !== "" ||
      ((view.phase === "not_connected" ||
        view.phase === "request_ended" ||
        view.phase === "revoked") &&
        (mode === "api-key" || mode === "host")));
  const saveLabel =
    mode === "host" && current.enabled
      ? view.phase === "request_ended"
        ? "Start a new request"
        : view.phase === "revoked"
          ? "Reconnect my Toolyard account"
          : "Connect my Toolyard account"
      : mode === "api-key"
        ? "Save and connect"
        : "Save and verify trust";
  const meta = [
    view.host ?? `${label} (host name not reported)`,
    view.method ?? "Method not reported",
    ...(view.connected
      ? [
          status?.expiresAt
            ? `Access expires ${formatTime(status.expiresAt)}`
            : "No expiry reported",
        ]
      : []),
    ...(status?.agentId ? [`Agent ${shortToolyardId(status.agentId)}`] : []),
  ].join(" · ");
  const copyable = (field: string, value: string | null | undefined, fallback: string) =>
    value ? (
      <span className="flex min-w-0 items-start gap-1">
        <span className="min-w-0 font-mono break-all select-all">{value}</span>
        <Button
          size="icon-micro"
          variant="ghost-muted"
          aria-label={`Copy ${field}`}
          onClick={() => {
            setCopiedField(field);
            copyToClipboard(value, field);
          }}
        >
          {isCopied && copiedField === field ? <CheckIcon /> : <CopyIcon />}
        </Button>
      </span>
    ) : (
      <span className="text-muted-foreground">{fallback}</span>
    );
  const details: ReadonlyArray<readonly [string, ReactNode]> = status
    ? [
        ["Account", status.email ?? "Not reported"],
        ["Host", status.hostName ?? `${label} (host name not reported)`],
        ["Method", view.method ?? "Not reported"],
        ["Agent ID", copyable("agent ID", status.agentId, "None")],
        ["Toolyard owner ID", copyable("Toolyard owner ID", status.ownerId, "None")],
        ["Instance URL", status.baseUrl ?? "Not set up"],
        ["Instance ID", copyable("instance ID", status.instanceId, "Not reported")],
        [
          "Callback transport",
          status.callbackTransport === "pull"
            ? "This server pulls callbacks from Toolyard"
            : status.callbackTransport === "push"
              ? "Toolyard pushes callbacks to this server"
              : "Not reported",
        ],
        ["Access expiry", status.expiresAt ? formatTime(status.expiresAt) : "Not reported"],
        [
          "Last connection request",
          status.pendingConnection ? (
            <span key="last-request" className="space-y-0.5">
              <span className="block">
                {view.requestOutcome ?? "Pending"} · expires{" "}
                {formatTime(status.pendingConnection.expiresAt)}
              </span>
              {copyable("request ID", status.pendingConnection.requestId, "None")}
            </span>
          ) : (
            "None"
          ),
        ],
        ["Settings revision", String(status.revision)],
      ]
    : [];
  const methodChoices = status?.apiKeyAllowed ? (
    <div className="space-y-2">
      <RadioGroup
        aria-label={`Toolyard connection method on ${label}`}
        value={mode}
        disabled={busy}
        onValueChange={(value) => {
          if (value === "team" || value === "api-key" || value === "host") chooseMode(value);
        }}
      >
        {[
          ...(status.hostConsentAllowed
            ? [
                {
                  value: "host" as const,
                  title: "Account consent",
                  description:
                    "Authorize this host with your Toolyard account in the browser. Each user receives a separate agent.",
                  disabled: false,
                },
              ]
            : []),
          {
            value: "team" as const,
            title: "Team connection",
            description:
              status.teamAvailable === false
                ? "Unavailable: this server has no verified team identity."
                : "Use this server's verified team identity.",
            disabled: status.teamAvailable === false,
          },
          {
            value: "api-key" as const,
            title: "API key connection",
            description:
              "Use a Toolyard agent API key. Decisions can arrive while your browser is closed.",
            disabled: false,
          },
        ].map((choice) => (
          <label key={choice.value} className="flex items-start gap-2 text-sm">
            <span className="mt-0.5 flex">
              <Radio value={choice.value} disabled={choice.disabled} />
            </span>
            <span className="min-w-0">
              <span className="block font-medium">{choice.title}</span>
              <span className="block text-xs text-muted-foreground">{choice.description}</span>
            </span>
          </label>
        ))}
      </RadioGroup>
      {mode === "api-key" ? (
        <SettingsRow
          title="Your API key"
          description="T3 stores a separate server credential. The key you enter is not saved in this browser."
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
    </div>
  ) : null;
  return (
    <SettingsSection
      title={compact ? "Toolyard" : `Toolyard — ${label}`}
      headerAction={
        compact ? null : (
          <Button
            size="xs"
            variant="outline"
            aria-label={`Refresh Toolyard status for ${label}`}
            onClick={refresh}
            disabled={busy}
          >
            <RefreshCwIcon />
            Refresh
          </Button>
        )
      }
    >
      <div className="space-y-3 px-3 py-3 sm:px-4">
        <div ref={summaryRef} tabIndex={-1} className="min-w-0 space-y-1 outline-none">
          <Badge variant={view.tone}>
            <StatusIcon aria-hidden />
            {view.label}
          </Badge>
          {view.account ? <p className="text-sm font-medium break-words">{view.account}</p> : null}
          {status ? <p className="text-xs break-words text-muted-foreground">{meta}</p> : null}
          <p className="text-xs text-muted-foreground">
            {view.connected
              ? "Toolyard Inbox asks you to decide on restricted calls."
              : view.description}
          </p>
          {status?.mode === "team" && view.phase === "revoked" ? (
            <p className="text-xs text-muted-foreground">
              Select an available connection method below to authorize access. A settings save does
              not restore revoked access.
            </p>
          ) : null}
          {userScope === "local-user" ? (
            <p className="text-xs text-muted-foreground">
              All clients authorized for this local profile use the same Toolyard account.
            </p>
          ) : null}
        </div>
        {AsyncResult.isFailure(result) ? (
          <p role="alert" className="text-xs text-destructive-foreground">
            The server did not return the latest Toolyard status. Select Retry.
          </p>
        ) : null}
        {status && status.revocationPending > 0 ? (
          <p role="alert" className="text-xs text-destructive-foreground">
            Remote permission cleanup is pending for {status.revocationPending} instance(s). T3 will
            retry it.
          </p>
        ) : null}
        {pendingRequest ? (
          <p role="status" className="text-xs text-muted-foreground">
            Awaiting your Toolyard account decision. The request expires{" "}
            {formatTime(pendingRequest.expiresAt)}.
          </p>
        ) : null}
        {pendingRequest?.lastError ? (
          <p role="alert" className="text-xs text-destructive-foreground">
            The server could not read the decision. It will retry while the request remains valid.
          </p>
        ) : null}
        {modeChange ? (
          <p role="alert" className="text-xs text-muted-foreground">
            Select Disconnect my account before you save a different connection method.
          </p>
        ) : null}
        {draft && status && revisionConflict ? (
          <div role="alert" className="flex flex-wrap items-center gap-2">
            <p className="text-xs text-destructive-foreground">
              Your draft uses revision {draft.revision}. The current server revision is{" "}
              {status.revision}.
            </p>
            <Button
              size="xs"
              variant="outline"
              onClick={() => setDraft({ ...draft, revision: status.revision })}
            >
              Use current revision
            </Button>
          </div>
        ) : null}
        {notice ? (
          <p role="status" className="text-xs text-muted-foreground">
            {notice}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-xs text-destructive-foreground">
            {error}
          </p>
        ) : null}
        <Collapsible open={manageOpen} onOpenChange={setManageOpen}>
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
            {view.connected ? (
              <Button
                size="sm"
                aria-label={`Open Toolyard for ${label}`}
                onClick={() => void open()}
                disabled={busy}
              >
                <ExternalLinkIcon />
                Open Toolyard
              </Button>
            ) : null}
            {pendingRequest ? (
              <>
                <Button
                  size="sm"
                  variant={view.connected ? "outline" : "default"}
                  aria-label={`Open account consent for Toolyard on ${label}`}
                  disabled={busy || !pendingRequest.authorizationUrl}
                  onClick={() => void resumeConsent()}
                >
                  <ExternalLinkIcon />
                  Open account consent
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  aria-label={`Cancel connection request for Toolyard on ${label}`}
                  disabled={busy}
                  onClick={() => void cancelConsent()}
                >
                  Cancel connection request
                </Button>
              </>
            ) : null}
            {retryable ? (
              <Button
                size="sm"
                variant="outline"
                aria-label={`Retry Toolyard status for ${label}`}
                onClick={refresh}
                disabled={busy}
              >
                <RefreshCwIcon />
                Retry
              </Button>
            ) : null}
            {status?.connection === "connected" ? (
              <CollapsibleTrigger
                aria-label={`Manage connection for Toolyard on ${label}`}
                render={<Button size="sm" variant="outline" />}
              >
                Manage connection
              </CollapsibleTrigger>
            ) : null}
          </div>
          {status?.connection === "connected" ? (
            <CollapsiblePanel keepMounted>
              <div className="mt-3 space-y-3 border-t border-border/50 pt-3">
                {methodChoices}
                {canDisconnect ? (
                  <div className="space-y-1">
                    <Button
                      size="sm"
                      variant="destructive-outline"
                      aria-label={`Disconnect my account from Toolyard on ${label}`}
                      disabled={busy}
                      onClick={() => askToConfirm("disconnect")}
                    >
                      Disconnect my account
                    </Button>
                    <p className="text-xs text-muted-foreground">
                      Ends only your Toolyard connection on this server. Disconnect before you
                      change the connection method.
                    </p>
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    Your team connection uses the verified team identity of this server. Choose
                    another method to disconnect it.
                  </p>
                )}
              </div>
            </CollapsiblePanel>
          ) : null}
        </Collapsible>
        {status && status.connection !== "connected" ? methodChoices : null}
      </div>
      {status ? (
        <Collapsible open={detailsOpen} onOpenChange={setDetailsOpen}>
          <div className="px-3 pb-2 sm:px-4">
            <FoldTrigger label={`Toolyard connection details for ${label}`} open={detailsOpen}>
              Connection details
            </FoldTrigger>
          </div>
          <CollapsiblePanel keepMounted>
            <dl className="grid gap-x-4 gap-y-1.5 px-3 pb-3 text-xs sm:grid-cols-[minmax(8rem,auto)_minmax(0,1fr)] sm:px-4">
              {details.map(([term, value]) => (
                <div key={term} className="contents">
                  <dt className="text-muted-foreground">{term}</dt>
                  <dd className="min-w-0 break-words">{value}</dd>
                </div>
              ))}
            </dl>
          </CollapsiblePanel>
        </Collapsible>
      ) : null}
      {status?.administrator ? (
        <Collapsible open={setupOpen} onOpenChange={setSetupOpen}>
          <div className="px-3 pb-2 sm:px-4">
            <FoldTrigger label={`Toolyard server setup for ${label}`} open={setupOpen}>
              Server setup — administrator
            </FoldTrigger>
          </div>
          <CollapsiblePanel keepMounted>
            <SettingsRow
              title="Hosted instance"
              description="Use one HTTPS Toolyard instance for this server. Account consent does not require a public address for your Mac."
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
            <div className="space-y-1 px-3 pb-3 sm:px-4">
              <Button
                size="sm"
                variant="destructive-outline"
                aria-label={`Remove instance: Toolyard on ${label}`}
                disabled={busy || !status.baseUrl || status.removed}
                onClick={() => askToConfirm("remove")}
              >
                Remove instance
              </Button>
              <p className="text-xs text-muted-foreground">
                Removes the server integration for every user. To stop only your access, use
                Disconnect my account.
              </p>
            </div>
          </CollapsiblePanel>
        </Collapsible>
      ) : null}
      {showSave && status ? (
        <div className="flex flex-col gap-2 px-3 pb-4 sm:flex-row sm:flex-wrap sm:px-4">
          <Button
            size="sm"
            disabled={
              busy ||
              modeChange ||
              (mode === "team" && status.teamAvailable === false) ||
              (mode === "host" && status.pendingConnection?.status === "pending") ||
              (!draft && !apiKey && !status.removed && mode !== "host") ||
              ((mode === "api-key" || mode === "host") && !status.baseUrl && !status.administrator)
            }
            onClick={() => void save()}
          >
            {saveLabel}
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
        </div>
      ) : null}
      <AlertDialog
        open={confirmOpen}
        onOpenChange={(next) => {
          if (!busy) setConfirmOpen(next);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirmAction === "remove"
                ? `Remove the Toolyard instance from ${label}?`
                : `Disconnect your Toolyard account on ${label}?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirmAction === "remove"
                ? "This affects every user on this server. T3 disables the integration, ends all Toolyard connections here, and asks Toolyard to revoke this server's trust. T3 will not restore the instance automatically. An administrator must set it up again."
                : "T3 ends your Toolyard connection on this server, cancels a pending consent request, and asks Toolyard to revoke this server's credential for your account. If Toolyard is unreachable, T3 retries the cleanup. Other users and the server setup stay unchanged."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => {
                setConfirmOpen(false);
                void (confirmAction === "remove" ? save(true) : save(false, true));
              }}
            >
              {confirmAction === "remove" ? "Remove instance" : "Disconnect"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </SettingsSection>
  );
}
