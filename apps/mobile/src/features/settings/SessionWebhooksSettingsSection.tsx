/** T3-CUSTOM(expbkt3): session callback management through the authenticated environment RPC. */
import { useAtomValue } from "@effect/atom-react";
import { type SessionWebhookView } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { usePhaseSidebarViewerUserId } from "../phasesidebar/usePhaseSidebarRows";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { appAtomRegistry } from "../../state/atom-registry";
import { useSettingsEnvironmentFilter, type SettingsTarget } from "./settings-environment-filter";
function EnvironmentWebhooks({ target }: { readonly target: SettingsTarget }) {
  const userScope = usePhaseSidebarViewerUserId(target.environmentId) ?? "signed-out";
  const atom = useMemo(
    () =>
      serverEnvironment.sessionWebhooksList({
        environmentId: target.environmentId,
        input: { userScope },
      }),
    [target.environmentId, userScope],
  );
  const result = useAtomValue(atom);
  const webhooks = Option.getOrNull(AsyncResult.value(result));
  const update = useAtomCommand(serverEnvironment.sessionWebhooksUpdate, "session webhook update");
  const [busy, setBusy] = useState(false);
  const change = async (webhook: SessionWebhookView, action: "rotate" | "disable" | "remove") => {
    setBusy(true);
    try {
      await update({
        environmentId: target.environmentId,
        input: { id: webhook.id, action, expectedRevision: webhook.revision },
      });
      appAtomRegistry.refresh(atom);
    } finally {
      setBusy(false);
    }
  };
  return (
    <View className="gap-2 p-3">
      <Text className="font-semibold text-foreground">Session webhooks — {target.label}</Text>
      <Text className="text-sm text-foreground-muted">
        Agents create one fixed session destination. Decisions wait for the active turn. A callback
        does not grant permission.
      </Text>
      <Pressable accessibilityRole="button" onPress={() => appAtomRegistry.refresh(atom)}>
        <Text className="p-2 text-foreground">Refresh status</Text>
      </Pressable>
      {webhooks === null ? (
        <Text className="text-foreground-muted">The webhook status is unavailable.</Text>
      ) : webhooks.length === 0 ? (
        <Text className="text-foreground-muted">No session webhooks exist.</Text>
      ) : (
        webhooks.map((webhook) => (
          <View key={webhook.id} className="gap-2 rounded-lg border border-border p-3">
            <Text className="text-sm text-foreground">Session: {webhook.threadId}</Text>
            <Text className="text-foreground-muted">
              {webhook.status}
              {webhook.terminalReason ? `: ${webhook.terminalReason}` : ""}
            </Text>
            <View className="flex-row flex-wrap gap-2">
              {(["rotate", "disable", "remove"] as const)
                .filter((action) =>
                  action === "remove" ? webhook.status !== "removed" : webhook.status === "active",
                )
                .map((action) => (
                  <Pressable
                    key={action}
                    accessibilityRole="button"
                    disabled={busy}
                    onPress={() => void change(webhook, action)}
                  >
                    <Text className="p-2 text-foreground">
                      {action === "rotate"
                        ? "Rotate secret"
                        : action === "disable"
                          ? "Disable"
                          : "Remove"}
                    </Text>
                  </Pressable>
                ))}
            </View>
            <Text className="text-sm font-semibold text-foreground">Toolyard delivery</Text>
            {webhook.deliveryHistoryError && (
              <Text className="text-xs text-foreground-muted">
                Delivery history is unavailable: {webhook.deliveryHistoryError}.
              </Text>
            )}
            {(webhook.deliveryHistory ?? []).map((delivery) => (
              <View key={delivery.eventId} className="gap-1">
                <Text className="text-xs text-foreground-muted">
                  {delivery.eventId}: {delivery.status}. Delivery attempts: {delivery.attempts}.
                  {delivery.terminalReason ? ` ${delivery.terminalReason}` : ""}
                </Text>
                {delivery.history.map((attempt) => (
                  <Text key={attempt.attempt} className="text-xs text-foreground-muted">
                    Attempt {attempt.attempt}, {new Date(attempt.at).toLocaleString()}:
                    {attempt.httpStatus === null
                      ? " No HTTP response."
                      : ` HTTP ${attempt.httpStatus}.`}
                    {` ${attempt.outcome}`}
                  </Text>
                ))}
              </View>
            ))}
            <Text className="text-sm font-semibold text-foreground">T3 notification dispatch</Text>
            {webhook.deliveries.length === 0 && (
              <Text className="text-xs text-foreground-muted">No callback has arrived.</Text>
            )}
            {webhook.deliveries.map((delivery) => (
              <Text key={delivery.eventId} className="text-xs text-foreground-muted">
                {delivery.eventId}: {delivery.state}. Dispatch attempts: {delivery.attempts}.
                {delivery.terminalReason ? ` ${delivery.terminalReason}` : ""}
              </Text>
            ))}
          </View>
        ))
      )}
    </View>
  );
}
export function SessionWebhooksSettingsSection() {
  const { selectedTargets } = useSettingsEnvironmentFilter();
  return (
    <>
      {selectedTargets.map((target) => (
        <EnvironmentWebhooks key={target.environmentId} target={target} />
      ))}
    </>
  );
}
