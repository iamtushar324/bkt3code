/** T3-CUSTOM(expbkt3): inspect agent-created destinations without exposing callback secrets. */
import { useAtomValue } from "@effect/atom-react";
import { EnvironmentId, type SessionWebhookView } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { useMemo, useState } from "react";
import { useCurrentUserId } from "../state/identity";
import { usePrimaryEnvironmentId } from "../state/environments";
import { serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { Button } from "../components/ui/button";
import { SettingsSection } from "../components/settings/settingsLayout";
export function SessionWebhookSettingsSection() {
  const userScope = useCurrentUserId() ?? "signed-out";
  const environmentId = usePrimaryEnvironmentId() ?? EnvironmentId.make("unavailable");
  const atom = useMemo(
    () => serverEnvironment.sessionWebhooksList({ environmentId, input: { userScope } }),
    [environmentId, userScope],
  );
  const result = useAtomValue(atom);
  const webhooks = Option.getOrNull(AsyncResult.value(result));
  const update = useAtomCommand(serverEnvironment.sessionWebhooksUpdate, "session webhook update");
  const [busy, setBusy] = useState<string | null>(null);
  const change = async (webhook: SessionWebhookView, action: "disable" | "rotate" | "remove") => {
    setBusy(webhook.id);
    try {
      await update({
        environmentId,
        input: { id: webhook.id, action, expectedRevision: webhook.revision },
      });
      appAtomRegistry.refresh(atom);
    } finally {
      setBusy(null);
    }
  };
  return (
    <SettingsSection title="Session webhooks">
      <p className="text-sm text-muted-foreground">
        Agents create a webhook for one session. Toolyard decisions queue after the active turn. A
        callback does not grant permission.
      </p>
      <div>
        <Button size="sm" variant="outline" onClick={() => appAtomRegistry.refresh(atom)}>
          Refresh status
        </Button>
      </div>
      {webhooks === null ? (
        <p className="text-sm text-muted-foreground">
          The webhook status is unavailable. Check the environment connection.
        </p>
      ) : webhooks.length === 0 ? (
        <p className="text-sm text-muted-foreground">No session webhooks exist for your account.</p>
      ) : (
        webhooks.map((webhook) => (
          <div key={webhook.id} className="min-w-0 space-y-2 rounded-lg border p-3">
            <p className="break-all text-sm">Session: {webhook.threadId}</p>
            <p className="text-sm">
              {webhook.status}
              {webhook.terminalReason ? `: ${webhook.terminalReason}` : ""}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={busy !== null || webhook.status !== "active"}
                onClick={() => void change(webhook, "rotate")}
              >
                Rotate secret
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy !== null || webhook.status !== "active"}
                onClick={() => void change(webhook, "disable")}
              >
                Disable
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy !== null || webhook.status === "removed"}
                onClick={() => void change(webhook, "remove")}
              >
                Remove
              </Button>
            </div>
            {webhook.deliveries.length === 0 ? (
              <p className="text-xs text-muted-foreground">No callback has arrived.</p>
            ) : (
              <ul className="space-y-1 text-xs">
                {webhook.deliveries.map((delivery) => (
                  <li key={delivery.eventId} className="break-all">
                    {delivery.eventId}: {delivery.state}. Attempts: {delivery.attempts}.
                    {delivery.terminalReason ? ` ${delivery.terminalReason}` : ""}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))
      )}
    </SettingsSection>
  );
}
