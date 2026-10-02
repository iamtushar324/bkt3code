/**
 * T3-CUSTOM(expbkt3): The built-in toolyard integration.
 *
 * There is nothing to configure: T3 connects it from the Clerk sign-in both
 * apps share, so this card only says whether that worked, as whom, and offers
 * Reconnect (which rotates the toolyard token) when it did not.
 */
import { RefreshCwIcon } from "lucide-react";
import { useState } from "react";

import { toolyardConnectErrorMessage, toolyardIntegrationOf } from "../../fork/toolyardConnect";
import { usePersonalMcpProfile } from "../../hooks/usePersonalMcpProfile";
import { readTeamClerkToken } from "../../state/teamIdentityToken";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { Button } from "../ui/button";
import { SettingsRow, SettingsSection } from "./settingsLayout";

export function ToolyardSettingsSection() {
  const { profile, connectToolyard } = usePersonalMcpProfile();
  const toolyard = toolyardIntegrationOf(profile);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reconnect = async () => {
    setBusy(true);
    setError(null);
    try {
      const token = await readTeamClerkToken();
      if (token === null) {
        setError(toolyardConnectErrorMessage("no_clerk_token"));
        return;
      }
      const result = await connectToolyard(token);
      if (result === null) {
        setError(toolyardConnectErrorMessage(undefined));
      } else if (!result.connected) {
        setError(toolyardConnectErrorMessage(result.error));
      }
    } finally {
      setBusy(false);
    }
  };

  const status = !toolyard
    ? "Loading…"
    : !toolyard.credentialConfigured
      ? "Not connected"
      : [
          `Connected automatically${toolyard.connectedEmail ? ` as ${toolyard.connectedEmail}` : ""}`,
          toolyard.connectedAt
            ? `last connected ${formatRelativeTimeLabel(toolyard.connectedAt)}`
            : null,
        ]
          .filter(Boolean)
          .join(" · ");

  return (
    <SettingsSection title="toolyard">
      <SettingsRow
        title="Connection"
        description="Connected through your Beknown Google sign-in; no key to paste. Agents see its tools as mcp__toolyard__*."
        status={status}
        control={
          <Button
            size="sm"
            variant="outline"
            disabled={busy || !profile}
            onClick={() => void reconnect()}
          >
            <RefreshCwIcon />
            Reconnect
          </Button>
        }
      >
        {error ? <p className="mt-2 mb-3 text-xs text-destructive-foreground">{error}</p> : null}
      </SettingsRow>
    </SettingsSection>
  );
}
