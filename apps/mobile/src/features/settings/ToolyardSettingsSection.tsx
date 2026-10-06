/** T3-CUSTOM(expbkt3): Server-owned Toolyard across authenticated mobile environments. */
import { useAtomValue } from "@effect/atom-react";
import { useAuth } from "@clerk/expo";
import { hasCloudPublicConfig } from "../cloud/publicConfig";
import { usePhaseSidebarViewerUserId } from "../phasesidebar/usePhaseSidebarRows";
import * as Option from "effect/Option";
import { AsyncResult, type Atom } from "effect/reactivity";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  toolyardConnectionPresentation,
  toolyardMethodLabel,
} from "@t3tools/client-runtime/bk-toolyard-presentation";
import {
  createToolyardSettingsContinuation,
  toolyardCommittedDraftMatches,
  toolyardSettingsFailureCode,
  toolyardSettingsFailureMessage,
  toolyardSettingsOrigin,
  type ToolyardSettingsDraft,
} from "@t3tools/client-runtime/toolyard-trust-setup";
import type { ToolyardIntegrationStatus } from "@t3tools/contracts";
import { Alert, Linking, Pressable, Switch, View } from "react-native";
import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text, AppTextInput } from "../../components/AppText";
import { StatusPill, type StatusTone } from "../../components/StatusPill";
import { cn } from "../../lib/cn";
import { appAtomRegistry } from "../../state/atom-registry";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import type { SettingsTarget } from "./settings-environment-filter";
import { usePreparedConnection } from "../../state/session";

type ToolyardMode = "team" | "api-key" | "host";
type ToolyardDraft = {
  baseUrl: string;
  enabled: boolean;
  revision: number;
  mode?: ToolyardMode;
};

/** Formats a server timestamp, keeping the raw value when it does not parse. */
export function bkAddonTime(value: string | number): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

/** Tones shared by the Toolyard and session callback presentation helpers. */
export type BkAddonTone = "success" | "warning" | "error" | "info" | "secondary" | "neutral";

/** Status colour always travels with a text glyph, so meaning never depends on colour alone. */
export function bkAddonTone(label: string, tone: BkAddonTone): StatusTone {
  switch (tone) {
    case "success":
      return {
        label: `✓ ${label}`,
        pillClassName: "bg-adaptive-emerald-500-a12-a16",
        textClassName: "text-adaptive-emerald-700-300",
      };
    case "warning":
      return {
        label: `! ${label}`,
        pillClassName: "bg-warning",
        textClassName: "text-warning-foreground",
      };
    case "error":
      return {
        label: `! ${label}`,
        pillClassName: "bg-danger",
        textClassName: "text-danger-foreground",
      };
    case "info":
      return { label, pillClassName: "bg-update", textClassName: "text-update-foreground" };
    case "secondary":
    case "neutral":
      return { label, pillClassName: "bg-subtle", textClassName: "text-foreground-secondary" };
  }
}

/** Refreshes `atom` each time the server group's single Refresh action advances `token`. */
export function useBkAddonRefresh<A>(atom: Atom.Atom<A>, token: number) {
  const seen = useRef(token);
  useEffect(() => {
    if (seen.current === token) return;
    seen.current = token;
    appAtomRegistry.refresh(atom);
  }, [atom, token]);
}

export function BkAddonButton(props: {
  readonly label: string;
  readonly accessibilityLabel?: string;
  readonly tone?: "primary" | "secondary" | "danger";
  readonly disabled?: boolean;
  readonly onPress: () => void;
}) {
  const tone = props.tone ?? "secondary";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel ?? props.label}
      accessibilityState={{ disabled: Boolean(props.disabled) }}
      disabled={props.disabled}
      onPress={props.onPress}
      className={cn(
        "min-h-11 justify-center rounded-full px-4 active:opacity-70",
        props.disabled
          ? "bg-subtle-strong"
          : tone === "primary"
            ? "bg-primary"
            : tone === "danger"
              ? "bg-danger"
              : "bg-secondary",
      )}
    >
      <Text
        className={cn(
          "text-center text-sm font-t3-medium",
          props.disabled
            ? "text-foreground-muted"
            : tone === "primary"
              ? "text-primary-foreground"
              : tone === "danger"
                ? "text-danger-foreground"
                : "text-secondary-foreground",
        )}
      >
        {props.label}
      </Text>
    </Pressable>
  );
}

/** Collapsible group. Callers own the state, so closing it never discards a draft. */
export function BkAddonDisclosure(props: {
  readonly label: string;
  readonly accessibilityLabel?: string;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly children: ReactNode;
}) {
  return (
    <View className="gap-2">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={props.accessibilityLabel ?? props.label}
        accessibilityState={{ expanded: props.expanded }}
        onPress={props.onToggle}
        className="min-h-11 flex-row items-center gap-2 active:opacity-60"
      >
        <SymbolView
          name={props.expanded ? "chevron.down" : "chevron.right"}
          size={12}
          tintColorClassName="accent-icon"
          type="monochrome"
        />
        <Text className="flex-1 text-sm font-t3-medium text-foreground-secondary">
          {props.label}
        </Text>
      </Pressable>
      {props.expanded ? <View className="gap-2 pl-5">{props.children}</View> : null}
    </View>
  );
}

function AlertText(props: { readonly children: ReactNode; readonly tone?: "danger" | "warning" }) {
  return (
    <Text
      accessibilityRole="alert"
      className={cn(
        "text-sm",
        props.tone === "warning" ? "text-warning-foreground" : "text-danger-foreground",
      )}
    >
      {props.children}
    </Text>
  );
}

/**
 * Which Toolyard sections open by default. Routine connected use keeps both closed;
 * an unsaved setup, a revision conflict, or missing setup opens administrator setup.
 */
export function toolyardDisclosureDefaults(input: {
  readonly status: ToolyardIntegrationStatus;
  readonly draft: ToolyardDraft | null;
  readonly apiKeyEntered: boolean;
  readonly connected: boolean;
  readonly pending: boolean;
}) {
  const { status, draft } = input;
  const conflict = draft !== null && draft.revision !== status.revision;
  const setupDraft =
    draft !== null &&
    (draft.baseUrl !== (status.baseUrl ?? "") || draft.enabled !== status.enabled);
  const setupMissing = !status.baseUrl || status.removed || !status.enabled;
  const methodChange =
    input.connected && draft?.mode !== undefined && draft.mode !== (status.mode ?? "team");
  return {
    conflict,
    adminExpanded: status.administrator && (setupDraft || conflict || setupMissing),
    manageExpanded:
      methodChange ||
      input.apiKeyEntered ||
      (!input.connected && !input.pending && status.connection !== "unavailable" && !setupMissing),
  };
}

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
const noAdminToken = async () => null;
type ToolyardServerProps = {
  readonly target: SettingsTarget;
  readonly userScope: string;
  readonly refreshToken: number;
};
/** Toolyard for one selected server. The caller supplies the authenticated user scope. */
export function ToolyardServerSettings(props: ToolyardServerProps) {
  return hasCloudPublicConfig() ? (
    <ClerkEnvironmentToolyard {...props} />
  ) : (
    <EnvironmentToolyardContent
      key={`${props.target.environmentId}:${props.userScope}`}
      {...props}
      readAdminToken={noAdminToken}
    />
  );
}
function ClerkEnvironmentToolyard(props: ToolyardServerProps) {
  const { getToken, userId: clerkUserId } = useAuth();
  const viewerUserId = usePhaseSidebarViewerUserId(props.target.environmentId);
  const readAdminToken = async () =>
    viewerUserId && viewerUserId === clerkUserId ? getToken() : null;
  return (
    <EnvironmentToolyardContent
      key={`${props.target.environmentId}:${props.userScope}`}
      {...props}
      readAdminToken={readAdminToken}
    />
  );
}
function EnvironmentToolyardContent({
  target,
  readAdminToken,
  userScope,
  refreshToken,
}: ToolyardServerProps & {
  readonly readAdminToken: () => Promise<string | null>;
}) {
  const atom = useMemo(
    () =>
      serverEnvironment.toolyardIntegrationStatus({
        environmentId: target.environmentId,
        input: { userScope },
      }),
    [target.environmentId, userScope],
  );
  const result = useAtomValue(atom);
  useBkAddonRefresh(atom, refreshToken);
  const status = Option.getOrNull(AsyncResult.value(result));
  const refreshFailed = AsyncResult.isFailure(result);
  const configure = useAtomCommand(
    serverEnvironment.configureToolyardIntegration,
    "Toolyard settings",
  );
  const handoff = useAtomCommand(serverEnvironment.openToolyardDashboard, "Open Toolyard");
  const prepared = Option.getOrNull(usePreparedConnection(target.environmentId));
  const [draft, setDraft] = useState<ToolyardDraft | null>(null);
  // The key stays in component memory only; it never enters a draft, continuation, or log.
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [browserDraft, setBrowserDraft] = useState<
    (ToolyardSettingsDraft & { mode?: ToolyardMode }) | null
  >(null);
  // `null` follows the state-derived default until the user opens or closes a section.
  const [manageOpen, setManageOpen] = useState<boolean | null>(null);
  const [adminOpen, setAdminOpen] = useState<boolean | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  useEffect(() => {
    if (browserDraft && status && toolyardCommittedDraftMatches(browserDraft, status)) {
      setDraft((value) =>
        value &&
        value.baseUrl === browserDraft.baseUrl &&
        value.enabled === browserDraft.enabled &&
        value.revision === browserDraft.revision &&
        value.mode === browserDraft.mode
          ? null
          : value,
      );
      setBrowserDraft(null);
      setError(null);
    }
  }, [browserDraft, status]);
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
  const presentation = toolyardConnectionPresentation(status);
  const connected = presentation.connected;
  const pending = presentation.pending;
  const defaults = status
    ? toolyardDisclosureDefaults({
        status,
        draft,
        apiKeyEntered: apiKey !== "",
        connected,
        pending,
      })
    : null;
  const refresh = () => appAtomRegistry.refresh(atom);
  const save = async (remove = false, disconnect = false) => {
    setBusy(true);
    setError(null);
    try {
      const submittedKey = apiKey;
      const submittedDraft = draft;
      const adminToken = mode === "team" && !disconnect ? await readAdminToken() : null;
      const publicUrl = target.serverConfig.settings.experimental.externalMcp.publicUrl;
      const origin =
        status?.origin ??
        toolyardSettingsOrigin(prepared?.httpBaseUrl ?? "") ??
        toolyardSettingsOrigin(publicUrl ?? "") ??
        "";
      const saved = await configure({
        environmentId: target.environmentId,
        input: {
          expectedRevision: current.revision,
          baseUrl: current.baseUrl,
          origin,
          enabled: current.enabled,
          remove,
          mode,
          ...(disconnect ? { disconnect: true } : {}),
          ...(mode === "host" && current.enabled && !remove && !disconnect
            ? { hostAction: "begin" as const }
            : {}),
          ...(mode === "api-key" && submittedKey && !remove && !disconnect
            ? { apiKey: submittedKey }
            : {}),
          ...(adminToken ? { adminToken } : {}),
        },
      });
      appAtomRegistry.refresh(atom);
      if (AsyncResult.isSuccess(saved)) {
        if (
          mode === "host" &&
          saved.value.pendingConnection?.status === "pending" &&
          saved.value.pendingConnection.authorizationUrl &&
          !remove &&
          !disconnect
        )
          await Linking.openURL(
            checkedConsentUrl(saved.value.pendingConnection.authorizationUrl, saved.value.baseUrl),
          );
        // A newer edit remains a draft after this request completes.
        if (!disconnect) {
          setDraft((value) => (value === submittedDraft ? null : value));
          setApiKey((value) => (value === submittedKey ? "" : value));
        }
      } else {
        const code = toolyardSettingsFailureCode(saved.cause);
        if (
          mode === "team" &&
          !remove &&
          !adminToken &&
          code === "admin_trust_registration_required"
        ) {
          const url = createToolyardSettingsContinuation(
            prepared?.httpBaseUrl ?? "",
            target.environmentId,
            userScope,
            current,
            Date.now(),
          );
          await Linking.openURL(url);
          setBrowserDraft(current);
          setError(
            "Complete the administrator trust setup in your browser. Then select Refresh. Your draft remains.",
          );
        } else
          setError(
            toolyardSettingsFailureMessage(
              mode === "api-key" && code === "invalid_assertion" ? "invalid_api_key" : code,
            ),
          );
      }
    } catch {
      setError("The server trust registration failed. Your draft remains.");
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (status?.pendingConnection?.status !== "pending") return;
    const timer = setInterval(() => appAtomRegistry.refresh(atom), 3000);
    return () => clearInterval(timer);
  }, [status?.pendingConnection?.status, atom]);
  const consentAction = async (cancel: boolean) => {
    if (!status?.pendingConnection || !status.baseUrl) return;
    setError(null);
    setBusy(true);
    try {
      if (cancel) {
        const result = await configure({
          environmentId: target.environmentId,
          input: {
            expectedRevision: status.revision,
            baseUrl: status.baseUrl,
            origin: status.origin ?? "",
            enabled: true,
            mode: "host",
            hostAction: "cancel",
          },
        });
        appAtomRegistry.refresh(atom);
        if (!AsyncResult.isSuccess(result))
          setError(
            "The connection request could not be cancelled. Select Refresh, then try again.",
          );
      } else
        await Linking.openURL(
          checkedConsentUrl(status.pendingConnection.authorizationUrl, status.baseUrl),
        );
    } catch {
      setError("The account consent request failed. Select Refresh, then try again.");
    } finally {
      setBusy(false);
    }
  };
  const open = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await handoff({ environmentId: target.environmentId, input: {} });
      if (!AsyncResult.isSuccess(response)) {
        setError("Toolyard could not create a browser handoff.");
        return;
      }
      await Linking.openURL(response.value.url);
    } catch {
      setError("The default browser did not open. Try again.");
    } finally {
      setBusy(false);
    }
  };
  const discard = () => {
    setDraft(null);
    setApiKey("");
    setError(null);
    setBrowserDraft(null);
  };
  const confirmDisconnect = () =>
    Alert.alert(
      `Disconnect your Toolyard account on ${target.label}?`,
      "T3 removes your Toolyard connection on this server and asks Toolyard to revoke its credential. A pending connection request is cancelled. The server's Toolyard setup stays in place for other users.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Disconnect", style: "destructive", onPress: () => void save(false, true) },
      ],
    );
  const confirmRemove = () =>
    Alert.alert(
      `Remove the Toolyard instance from ${target.label}?`,
      "This disables Toolyard on this server for every user, ends their connections, and asks Toolyard to revoke access. T3 will not restore the instance automatically. To end only your own connection, use Disconnect my account instead.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Remove instance", style: "destructive", onPress: () => void save(true) },
      ],
    );
  const saveDisabled =
    !status ||
    busy ||
    modeChange ||
    (mode === "team" && status.teamAvailable === false) ||
    (mode === "host" && status.pendingConnection?.status === "pending") ||
    (!draft && !apiKey && !status.removed && mode !== "host") ||
    ((mode === "api-key" || mode === "host") && !status.baseUrl && !status.administrator);
  const saveLabel =
    mode === "host" && current.enabled
      ? presentation.phase === "request_ended"
        ? "Start a new request"
        : presentation.phase === "revoked"
          ? "Reconnect my Toolyard account"
          : "Connect my Toolyard account"
      : mode === "api-key"
        ? "Save and connect"
        : "Save and verify trust";
  // With no status at all, a failed read is an outage, never a lost connection.
  const badge =
    !status && refreshFailed
      ? bkAddonTone("Status unavailable", "warning")
      : bkAddonTone(presentation.label, presentation.tone);
  const summary = connected
    ? [
        presentation.host ?? target.label,
        presentation.method,
        status?.expiresAt ? `Access expires ${bkAddonTime(status.expiresAt)}` : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : null;
  const manageExpanded = manageOpen ?? defaults?.manageExpanded ?? false;
  const adminExpanded = adminOpen ?? defaults?.adminExpanded ?? false;
  return (
    <View className="gap-3 p-4">
      <View className="flex-row flex-wrap items-center justify-between gap-2">
        <Text className="text-base font-t3-bold text-foreground">Toolyard</Text>
        <StatusPill size="compact" {...badge} />
      </View>
      {status === null ? (
        <Text className="text-sm text-foreground-muted">
          {refreshFailed
            ? "The server could not read the Toolyard status."
            : "Reading the Toolyard status from this server."}
        </Text>
      ) : connected ? (
        <View className="gap-1">
          <Text selectable className="text-base text-foreground">
            {presentation.account ?? "Toolyard did not report an account email."}
          </Text>
          {summary ? <Text className="text-sm text-foreground-muted">{summary}</Text> : null}
          <Text className="text-sm text-foreground-muted">
            Toolyard Inbox asks you to decide on restricted calls.
          </Text>
        </View>
      ) : (
        <>
          <Text className="text-sm text-foreground-muted">{presentation.description}</Text>
          {status?.mode === "team" && presentation.phase === "revoked" ? (
            <Text className="text-sm text-foreground-muted">
              Select an available method under Connect your account to authorize access. A settings
              save does not restore revoked access.
            </Text>
          ) : null}
        </>
      )}
      {refreshFailed && status ? (
        <AlertText tone="warning">
          Refresh failed. This shows the last status the server returned.
        </AlertText>
      ) : null}
      {status && status.revocationPending > 0 ? (
        <AlertText>
          Remote permission cleanup is pending for {status.revocationPending} instance(s). T3 will
          retry it.
        </AlertText>
      ) : null}
      {pending && status?.pendingConnection ? (
        <View className="gap-1">
          <Text className="text-sm text-foreground">
            {connected ? "A new connection request awaits your decision in Toolyard. " : ""}
            The request expires {bkAddonTime(status.pendingConnection.expiresAt)}.
          </Text>
          {status.pendingConnection.lastError ? (
            <AlertText>
              The server could not read the decision. It will retry while the request remains valid.
            </AlertText>
          ) : null}
        </View>
      ) : null}
      {userScope === "local-user" ? (
        <Text className="text-sm text-foreground-muted">
          All clients authorized for this local profile use the same Toolyard account.
        </Text>
      ) : null}
      {error ? <AlertText>{error}</AlertText> : null}
      {status && draft && defaults?.conflict ? (
        <View className="gap-2">
          <AlertText>
            Your draft uses revision {draft.revision}. The current server revision is{" "}
            {status.revision}. Review the setup before you save.
          </AlertText>
          <View className="flex-row flex-wrap gap-2">
            <BkAddonButton
              label="Use current revision"
              accessibilityLabel={`Use the current Toolyard settings revision on ${target.label}`}
              onPress={() => setDraft({ ...draft, revision: status.revision })}
            />
          </View>
        </View>
      ) : null}
      <View className="flex-row flex-wrap gap-2">
        {status === null || status.connection === "unavailable" ? (
          <BkAddonButton
            label="Retry"
            accessibilityLabel={`Retry Toolyard status on ${target.label}`}
            disabled={busy}
            onPress={refresh}
          />
        ) : null}
        {pending ? (
          <>
            <BkAddonButton
              tone="primary"
              label="Open account consent"
              accessibilityLabel={`Open Toolyard account consent for ${target.label}`}
              disabled={busy || !status?.pendingConnection?.authorizationUrl}
              onPress={() => void consentAction(false)}
            />
            <BkAddonButton
              label="Cancel request"
              accessibilityLabel={`Cancel the Toolyard connection request on ${target.label}`}
              disabled={busy}
              onPress={() => void consentAction(true)}
            />
          </>
        ) : null}
        {connected ? (
          <BkAddonButton
            tone="primary"
            label="Open Toolyard ↗"
            accessibilityLabel={`Open Toolyard for ${target.label} in the default browser`}
            disabled={busy}
            onPress={() => void open()}
          />
        ) : null}
      </View>
      {status ? (
        <>
          <BkAddonDisclosure
            label="Connection details"
            accessibilityLabel={`Toolyard connection details for ${target.label}`}
            expanded={detailsOpen}
            onToggle={() => setDetailsOpen((value) => !value)}
          >
            <ToolyardDetails status={status} hostFallback={target.label} />
          </BkAddonDisclosure>
          <BkAddonDisclosure
            label={connected ? "Manage connection" : "Connect your account"}
            accessibilityLabel={`${connected ? "Manage" : "Connect"} your Toolyard account on ${target.label}`}
            expanded={manageExpanded}
            onToggle={() => setManageOpen(!manageExpanded)}
          >
            {status.apiKeyAllowed ? (
              <>
                <Text className="text-sm font-t3-medium text-foreground">Connection method</Text>
                <View className="flex-row flex-wrap gap-2">
                  {status.hostConsentAllowed ? (
                    <MethodChoice
                      label="Account consent"
                      selected={mode === "host"}
                      disabled={busy}
                      onPress={() => {
                        setApiKey("");
                        setDraft({ ...current, mode: "host", enabled: true });
                      }}
                    />
                  ) : null}
                  <MethodChoice
                    label="Team connection"
                    selected={mode === "team"}
                    disabled={busy || status.teamAvailable === false}
                    onPress={() => {
                      setApiKey("");
                      setDraft({ ...current, mode: "team" });
                    }}
                  />
                  <MethodChoice
                    label="API key connection"
                    selected={mode === "api-key"}
                    disabled={busy}
                    onPress={() => {
                      setApiKey("");
                      setDraft({ ...current, mode: "api-key", enabled: true });
                    }}
                  />
                </View>
                {status.teamAvailable === false ? (
                  <Text className="text-sm text-foreground-muted">
                    Team connection is unavailable: this server has no verified team identity.
                    Authorize your Toolyard account in the browser.
                  </Text>
                ) : null}
                {modeChange ? (
                  <AlertText tone="warning">
                    Select Disconnect my account before you save a different connection method. Team
                    access requires administrator authorization.
                  </AlertText>
                ) : null}
                {mode === "api-key" ? (
                  <>
                    <Text className="text-sm text-foreground-muted">
                      Use your own Toolyard agent API key. Decisions arrive through outbound
                      requests.
                    </Text>
                    <AppTextInput
                      accessibilityLabel={`Toolyard API key for ${target.label}`}
                      secureTextEntry
                      autoCapitalize="none"
                      autoCorrect={false}
                      autoComplete="off"
                      value={apiKey}
                      placeholder="Enter your Toolyard API key"
                      onChangeText={setApiKey}
                    />
                    {!status.administrator && !status.baseUrl ? (
                      <Text className="text-sm text-foreground-muted">
                        An administrator must set the Toolyard URL first.
                      </Text>
                    ) : null}
                  </>
                ) : null}
              </>
            ) : null}
            {mode === "host" ? (
              <Text className="text-sm text-foreground-muted">
                Toolyard records your account as the host agent owner. Restricted calls still
                require an Inbox decision.
              </Text>
            ) : null}
            {!connected && mode === "team" ? (
              <Text className="text-sm text-foreground-muted">
                A team connection is verified through the administrator server setup.
              </Text>
            ) : null}
            <View className="flex-row flex-wrap gap-2">
              {!connected && (mode === "api-key" || mode === "host") ? (
                <BkAddonButton
                  tone="primary"
                  label={saveLabel}
                  accessibilityLabel={`${saveLabel} on ${target.label}`}
                  disabled={saveDisabled}
                  onPress={() => void save()}
                />
              ) : null}
              {draft?.mode !== undefined || apiKey ? (
                <BkAddonButton
                  label="Discard"
                  accessibilityLabel={`Discard Toolyard changes on ${target.label}`}
                  disabled={busy}
                  onPress={discard}
                />
              ) : null}
              {canDisconnect ? (
                <BkAddonButton
                  tone="danger"
                  label="Disconnect my account"
                  accessibilityLabel={`Disconnect your Toolyard account on ${target.label}`}
                  disabled={busy}
                  onPress={confirmDisconnect}
                />
              ) : null}
            </View>
          </BkAddonDisclosure>
          {status.administrator ? (
            <BkAddonDisclosure
              label="Server setup — administrator"
              accessibilityLabel={`Toolyard server setup for ${target.label}, administrator`}
              expanded={adminExpanded}
              onToggle={() => setAdminOpen(!adminExpanded)}
            >
              <Text className="text-sm text-foreground-muted">
                These settings apply to every user on this server.
              </Text>
              <AppTextInput
                accessibilityLabel={`Toolyard base URL for ${target.label}`}
                autoCapitalize="none"
                autoCorrect={false}
                value={current.baseUrl}
                placeholder="https://toolyard.dev.beknown.live"
                onChangeText={(baseUrl) => setDraft({ ...current, baseUrl })}
              />
              <View className="flex-row items-center justify-between gap-3">
                <Text className="flex-1 text-foreground">Enable integration</Text>
                <Switch
                  accessibilityLabel={`Enable Toolyard integration on ${target.label}`}
                  value={current.enabled}
                  onValueChange={(enabled) => setDraft({ ...current, enabled })}
                />
              </View>
              <View className="flex-row flex-wrap gap-2">
                <BkAddonButton
                  tone="primary"
                  label={saveLabel}
                  accessibilityLabel={`${saveLabel} on ${target.label}`}
                  disabled={saveDisabled}
                  onPress={() => void save()}
                />
                <BkAddonButton
                  label="Discard"
                  accessibilityLabel={`Discard Toolyard setup changes on ${target.label}`}
                  disabled={busy || (!draft && !apiKey)}
                  onPress={discard}
                />
                <BkAddonButton
                  tone="danger"
                  label="Remove instance"
                  accessibilityLabel={`Remove the Toolyard instance from ${target.label}`}
                  disabled={busy || !status.baseUrl || status.removed}
                  onPress={confirmRemove}
                />
              </View>
              <Text className="text-sm text-foreground-muted">
                Remove instance affects the whole server integration. It is different from
                disconnecting your own account.
              </Text>
            </BkAddonDisclosure>
          ) : null}
        </>
      ) : null}
    </View>
  );
}
function MethodChoice(props: {
  readonly label: string;
  readonly selected: boolean;
  readonly disabled: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityLabel={props.label}
      accessibilityState={{ checked: props.selected, disabled: props.disabled }}
      disabled={props.disabled}
      onPress={props.onPress}
      className={cn(
        "min-h-11 justify-center rounded-full border px-4 active:opacity-70",
        props.selected ? "border-primary bg-primary" : "border-border bg-transparent",
        props.disabled && "opacity-[0.45]",
      )}
    >
      <Text
        className={cn(
          "text-sm font-t3-medium",
          props.selected ? "text-primary-foreground" : "text-foreground",
        )}
      >
        {props.label}
      </Text>
    </Pressable>
  );
}
function ToolyardDetails({
  status,
  hostFallback,
}: {
  readonly status: ToolyardIntegrationStatus;
  readonly hostFallback: string;
}) {
  const rows: Array<readonly [string, string]> = [
    ["Host", status.hostName ?? hostFallback],
    ["Method", toolyardMethodLabel(status.mode) ?? "Not reported"],
    ["Agent ID", status.agentId ?? "Not connected"],
    ["Toolyard owner ID", status.ownerId ?? "Not reported"],
    ["Instance URL", status.baseUrl ?? "Not set"],
    ["Instance ID", status.instanceId ?? "Not set"],
    [
      "Callback transport",
      status.callbackTransport === "push"
        ? "Push"
        : status.callbackTransport === "pull"
          ? "Pull"
          : "Not reported",
    ],
    ["Access expires", status.expiresAt ? bkAddonTime(status.expiresAt) : "Not reported"],
    ["Settings revision", String(status.revision)],
  ];
  const request = status.pendingConnection;
  return (
    <View className="gap-1">
      {rows.map(([label, value]) => (
        <Text key={label} selectable className="text-xs text-foreground-muted">
          {label}: <Text className="text-xs text-foreground">{value}</Text>
        </Text>
      ))}
      {request ? (
        <Text selectable className="text-xs text-foreground-muted">
          Last connection request {request.requestId}: {request.status}, expires{" "}
          {bkAddonTime(request.expiresAt)}.
          {request.lastError ? ` Last error: ${request.lastError}.` : ""}
        </Text>
      ) : (
        <Text className="text-xs text-foreground-muted">No connection request on record.</Text>
      )}
    </View>
  );
}
