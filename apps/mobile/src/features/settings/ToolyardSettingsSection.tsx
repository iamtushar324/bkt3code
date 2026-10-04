/** T3-CUSTOM(expbkt3): Server-owned Toolyard across authenticated mobile environments. */
import { useAtomValue } from "@effect/atom-react";
import { useAuth } from "@clerk/expo";
import { hasCloudPublicConfig } from "../cloud/publicConfig";
import { usePhaseSidebarViewerUserId } from "../phasesidebar/usePhaseSidebarRows";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { useMemo, useState } from "react";
import { Linking, Pressable, Switch, TextInput, View } from "react-native";
import { AppText as Text } from "../../components/AppText";
import { appAtomRegistry } from "../../state/atom-registry";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { useSettingsEnvironmentFilter, type SettingsTarget } from "./settings-environment-filter";

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
  const [draft, setDraft] = useState<{
    baseUrl: string;
    enabled: boolean;
    revision: number;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = draft ?? {
    baseUrl: status?.baseUrl ?? "",
    enabled: status?.enabled ?? false,
    revision: status?.revision ?? 0,
  };
  const save = async (remove = false) => {
    setBusy(true);
    setError(null);
    try {
      const adminToken = await readAdminToken();
      const publicUrl = target.serverConfig.settings.experimental.externalMcp.publicUrl;
      const origin = status?.origin ?? (publicUrl ? new URL(publicUrl).origin : "");
      const saved = await configure({
        environmentId: target.environmentId,
        input: {
          expectedRevision: current.revision,
          baseUrl: current.baseUrl,
          origin,
          enabled: current.enabled,
          remove,
          ...(adminToken ? { adminToken } : {}),
        },
      });
      appAtomRegistry.refresh(atom);
      if (AsyncResult.isSuccess(saved)) setDraft(null);
      else setError("The settings did not save. Your draft remains.");
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
          <View className="flex-row flex-wrap gap-2">
            <Pressable
              accessibilityRole="button"
              disabled={busy || !draft}
              onPress={() => void save()}
            >
              <Text className="p-2 text-foreground">Save and verify trust</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              disabled={busy || !draft}
              onPress={() => {
                setDraft(null);
                setError(null);
              }}
            >
              <Text className="p-2 text-foreground">Discard</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              disabled={busy || !status.baseUrl || status.removed}
              onPress={() => void save(true)}
            >
              <Text className="p-2 text-danger-foreground">Remove instance</Text>
            </Pressable>
          </View>
        </>
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
