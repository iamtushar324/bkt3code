/** T3-CUSTOM(expbkt3): Server-owned Toolyard across authenticated mobile environments. */
import { useAtomValue } from "@effect/atom-react";
import { useAuth } from "@clerk/expo";
import { hasCloudPublicConfig } from "../cloud/publicConfig";
import { usePhaseSidebarViewerUserId } from "../phasesidebar/usePhaseSidebarRows";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { useEffect, useMemo, useState } from "react";
import {
  createToolyardSettingsContinuation,
  toolyardCommittedDraftMatches,
  toolyardSettingsFailureCode,
  toolyardSettingsFailureMessage,
  toolyardSettingsOrigin,
  type ToolyardSettingsDraft,
} from "@t3tools/client-runtime/toolyard-trust-setup";
import { Linking, Pressable, Switch, TextInput, View } from "react-native";
import { AppText as Text } from "../../components/AppText";
import { appAtomRegistry } from "../../state/atom-registry";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { useSettingsEnvironmentFilter, type SettingsTarget } from "./settings-environment-filter";
import { usePreparedConnection } from "../../state/session";

const noAdminToken = async () => null;
function ClerkEnvironmentToolyard({ target }: { readonly target: SettingsTarget }) {
  const { getToken } = useAuth();
  return <EnvironmentToolyard target={target} readAdminToken={getToken} />;
}
function EnvironmentToolyard({
  target,
  readAdminToken = noAdminToken,
}: {
  readonly target: SettingsTarget;
  readonly readAdminToken?: () => Promise<string | null>;
}) {
  const userId = usePhaseSidebarViewerUserId(target.environmentId);
  return (
    <EnvironmentToolyardContent
      key={`${target.environmentId}:${userId}`}
      target={target}
      readAdminToken={readAdminToken}
      userScope={userId ?? "unverified"}
    />
  );
}
function EnvironmentToolyardContent({
  target,
  readAdminToken,
  userScope,
}: {
  readonly target: SettingsTarget;
  readonly readAdminToken: () => Promise<string | null>;
  readonly userScope: string;
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
  const status = Option.getOrNull(AsyncResult.value(result));
  const configure = useAtomCommand(
    serverEnvironment.configureToolyardIntegration,
    "Toolyard settings",
  );
  const handoff = useAtomCommand(serverEnvironment.openToolyardDashboard, "Open Toolyard");
  const prepared = Option.getOrNull(usePreparedConnection(target.environmentId));
  const [draft, setDraft] = useState<{
    baseUrl: string;
    enabled: boolean;
    revision: number;
    mode?: "team" | "api-key";
  } | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [browserDraft, setBrowserDraft] = useState<
    (ToolyardSettingsDraft & { mode?: "team" | "api-key" }) | null
  >(null);
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
    status?.connection === "connected" && (status.mode === "api-key" || modeChange);
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
          ...(mode === "api-key" && submittedKey && !remove && !disconnect
            ? { apiKey: submittedKey }
            : {}),
          ...(adminToken ? { adminToken } : {}),
        },
      });
      appAtomRegistry.refresh(atom);
      if (AsyncResult.isSuccess(saved)) {
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
            "Complete the administrator trust setup in your browser. Then select Refresh status. Your draft remains.",
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
  return (
    <View className="gap-2 p-3">
      <Text className="font-semibold text-foreground">Toolyard — {target.label}</Text>
      <Text className="text-sm text-foreground-muted">
        T3 owns your connection. Credentials stay on the server.
      </Text>
      <Text className="text-foreground">
        {status?.connection ?? "Unavailable"}
        {status?.email ? ` · ${status.email}` : ""}
      </Text>
      {status?.removed ? (
        <Text className="text-foreground-muted">The administrator removed this instance.</Text>
      ) : null}
      {error ? (
        <Text accessibilityRole="alert" className="text-danger-foreground">
          {error}
        </Text>
      ) : null}
      <View className="flex-row flex-wrap gap-2">
        <Pressable
          accessibilityRole="button"
          disabled={busy}
          onPress={() => appAtomRegistry.refresh(atom)}
        >
          <Text className="p-2 text-foreground">Refresh status</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          disabled={busy || status?.connection !== "connected"}
          onPress={() => void open()}
        >
          <Text className="p-2 text-foreground">Open Toolyard</Text>
        </Pressable>
      </View>
      {status?.apiKeyAllowed ? (
        <>
          <Text className="font-semibold text-foreground">Connection method</Text>
          <View className="flex-row flex-wrap gap-2">
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ selected: mode === "team" }}
              disabled={busy || status.teamAvailable === false}
              onPress={() => {
                setApiKey("");
                setDraft({ ...current, mode: "team" });
              }}
            >
              <Text className="p-2 text-foreground">Team connection</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ selected: mode === "api-key" }}
              disabled={busy}
              onPress={() => {
                setApiKey("");
                setDraft({ ...current, mode: "api-key", enabled: true });
              }}
            >
              <Text className="p-2 text-foreground">API key connection</Text>
            </Pressable>
          </View>
          {status.teamAvailable === false ? (
            <Text className="text-sm text-foreground-muted">
              This server has no verified team identity. Use your Toolyard API key.
            </Text>
          ) : null}
          {modeChange ? (
            <Text accessibilityRole="alert" className="text-sm text-foreground-muted">
              Select Disconnect my account before you save a different connection method. Team
              access requires administrator authorization.
            </Text>
          ) : null}
          {mode === "api-key" ? (
            <>
              <Text className="text-sm text-foreground-muted">
                Use your own Toolyard agent API key. Decisions arrive through outbound requests.
              </Text>
              <TextInput
                accessibilityLabel="Toolyard API key"
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="off"
                className="rounded-lg border border-border p-3 text-foreground"
                value={apiKey}
                placeholder="Enter your Toolyard API key"
                onChangeText={setApiKey}
              />
              {!status.administrator && !status.baseUrl ? (
                <Text className="text-foreground-muted">
                  An administrator must set the Toolyard URL first.
                </Text>
              ) : null}
            </>
          ) : null}
        </>
      ) : null}
      {status?.administrator ? (
        <>
          <TextInput
            accessibilityLabel="Toolyard base URL"
            className="rounded-lg border border-border p-3 text-foreground"
            autoCapitalize="none"
            autoCorrect={false}
            value={current.baseUrl}
            placeholder="https://toolyard.dev.beknown.live"
            onChangeText={(baseUrl) => setDraft({ ...current, baseUrl })}
          />
          <View className="flex-row items-center justify-between">
            <Text className="text-foreground">Enable integration</Text>
            <Switch
              accessibilityLabel="Enable Toolyard integration"
              value={current.enabled}
              onValueChange={(enabled) => setDraft({ ...current, enabled })}
            />
          </View>
        </>
      ) : null}
      {status && (status.administrator || mode === "api-key" || canDisconnect) ? (
        <View className="flex-row flex-wrap gap-2">
          <Pressable
            accessibilityRole="button"
            disabled={
              busy ||
              modeChange ||
              (mode === "team" && status.teamAvailable === false) ||
              (!draft && !apiKey && !status.removed) ||
              (mode === "api-key" && !status.baseUrl && !status.administrator)
            }
            onPress={() => void save()}
          >
            <Text className="p-2 text-foreground">
              {mode === "api-key" ? "Save and connect" : "Save and verify trust"}
            </Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            disabled={busy || (!draft && !apiKey)}
            onPress={() => {
              setDraft(null);
              setApiKey("");
              setError(null);
              setBrowserDraft(null);
            }}
          >
            <Text className="p-2 text-foreground">Discard</Text>
          </Pressable>
          {canDisconnect ? (
            <Pressable
              accessibilityRole="button"
              disabled={busy}
              onPress={() => void save(false, true)}
            >
              <Text className="p-2 text-danger-foreground">Disconnect my account</Text>
            </Pressable>
          ) : null}
          {status.administrator ? (
            <Pressable
              accessibilityRole="button"
              disabled={busy || !status.baseUrl || status.removed}
              onPress={() => void save(true)}
            >
              <Text className="p-2 text-danger-foreground">Remove instance</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
export function ToolyardSettingsSection() {
  const { selectedTargets } = useSettingsEnvironmentFilter();
  return (
    <>
      {selectedTargets.map((target) =>
        hasCloudPublicConfig() ? (
          <ClerkEnvironmentToolyard key={target.environmentId} target={target} />
        ) : (
          <EnvironmentToolyard key={target.environmentId} target={target} />
        ),
      )}
    </>
  );
}
