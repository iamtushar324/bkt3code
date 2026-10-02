/**
 * T3-CUSTOM(expbkt3): The built-in toolyard integration.
 *
 * There is nothing to configure: T3 connects it from the Clerk sign-in both
 * apps share, so this card only says whether that worked, as whom, and offers
 * Reconnect (which rotates the toolyard token) when it did not.
 *
 * Only a client with a Clerk publishable key can mint the token that connect
 * needs — the web app. The managed BK desktop is keyless and pairs by
 * credential, so there it never attempts a connect: it shows the connection
 * the server holds and, when there is none, opens the web app in the system
 * browser so the person connects once from there.
 */
import { ExternalLinkIcon, RefreshCwIcon } from "lucide-react";
import { useState } from "react";

import { hasClerkPublicConfig } from "../../cloud/publicConfig";
import { readBkManagedEnvironment } from "../../fork/managedEnvironment";
import {
  resolveToolyardCardView,
  toolyardConnectErrorMessage,
  toolyardIntegrationOf,
} from "../../fork/toolyardConnect";
import { usePersonalMcpProfile } from "../../hooks/usePersonalMcpProfile";
import { ensureLocalApi } from "../../localApi";
import { readTeamClerkToken } from "../../state/teamIdentityToken";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { Button } from "../ui/button";
import { SettingsRow, SettingsSection } from "./settingsLayout";

export function ToolyardSettingsSection() {
  const { profile, connectToolyard } = usePersonalMcpProfile();
  const toolyard = toolyardIntegrationOf(profile);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canSignIn = hasClerkPublicConfig();
  const view = resolveToolyardCardView({
    toolyard,
    canSignIn,
    webAppUrl: readBkManagedEnvironment()?.httpBaseUrl ?? null,
    formatConnectedAt: formatRelativeTimeLabel,
  });

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

  const openWebApp = async (url: string) => {
    setError(null);
    try {
      await ensureLocalApi().shell.openExternal(url);
    } catch {
      setError(`Could not open the web app. Visit ${url} in your browser to connect.`);
    }
  };

  return (
    <SettingsSection title="toolyard">
      <SettingsRow
        title="Connection"
        description={
          canSignIn
            ? "Connected through your Beknown Google sign-in; no key to paste. Agents see its tools as mcp__toolyard__*."
            : "Connected once from the web app through your Beknown Google sign-in; this app uses that connection. Agents see its tools as mcp__toolyard__*."
        }
        status={view.status}
        control={
          view.action.kind === "reconnect" ? (
            <Button
              size="sm"
              variant="outline"
              disabled={busy || !profile}
              onClick={() => void reconnect()}
            >
              <RefreshCwIcon />
              Reconnect
            </Button>
          ) : view.action.kind === "open-web" ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                if (view.action.kind === "open-web") void openWebApp(view.action.url);
              }}
            >
              <ExternalLinkIcon />
              Open web app
            </Button>
          ) : null
        }
      >
        {error ? <p className="mt-2 mb-3 text-xs text-destructive-foreground">{error}</p> : null}
      </SettingsRow>
    </SettingsSection>
  );
}
