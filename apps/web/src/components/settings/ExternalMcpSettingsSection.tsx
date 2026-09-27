/**
 * T3-CUSTOM(expbkt3): Per-user external T3 access and managed upstream MCP
 * integrations. Secret values are write-only and never returned by T3.
 */
import {
  BIFROST_MCP_INTEGRATION_ID,
  BIFROST_MCP_URL,
  ProviderInstanceId,
  type PersonalMcpAuthMode,
  type PersonalMcpIntegration,
  type PersonalMcpIntegrationUpdate,
} from "@t3tools/contracts";
import { CopyIcon, KeyRoundIcon, PlusIcon, RefreshCwIcon, Trash2Icon } from "lucide-react";
import { useMemo, useState } from "react";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { usePersonalMcpProfile } from "../../hooks/usePersonalMcpProfile";
import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { SettingsRow, SettingsSection } from "./settingsLayout";

export function formatExternalMcpApiKey(bytes: Uint8Array): string {
  return `t3exp_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export function buildBifrostIntegration(): PersonalMcpIntegration {
  return {
    id: BIFROST_MCP_INTEGRATION_ID,
    name: "Bifrost",
    url: BIFROST_MCP_URL,
    enabled: true,
    authMode: "x-bf-vk",
    customHeaderName: "",
    credentialConfigured: false,
    providerInstanceIds: [],
    allowedTools: [],
  };
}

const toUpdate = (
  integration: PersonalMcpIntegration,
  credential?: string,
): PersonalMcpIntegrationUpdate => ({
  id: integration.id,
  name: integration.name,
  url: integration.url,
  enabled: integration.enabled,
  authMode: integration.authMode,
  customHeaderName: integration.customHeaderName,
  ...(credential === undefined ? {} : { credential }),
  providerInstanceIds: integration.providerInstanceIds,
  allowedTools: integration.allowedTools,
});

export function ExternalMcpSettingsSection() {
  const settings = usePrimarySettings();
  const updateServerSettings = useUpdatePrimarySettings();
  const { profile, update, rotateToken, revokeToken } = usePersonalMcpProfile();
  const externalMcp = settings.experimental.externalMcp;
  const [urlDraft, setUrlDraft] = useState<string | null>(null);
  const [newToken, setNewToken] = useState<string | null>(null);
  const [credentialDrafts, setCredentialDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const { copyToClipboard: copyToken, isCopied: tokenCopied } = useCopyToClipboard({
    target: "personal T3 MCP token",
  });
  const { copyToClipboard: copyConfig, isCopied: configCopied } = useCopyToClipboard({
    target: "personal T3 MCP configuration",
  });

  const effectiveUrl =
    externalMcp.publicUrl.trim() ||
    (typeof window === "undefined" ? "/mcp" : `${window.location.origin}/mcp`);
  const displayedToken = newToken ?? (profile?.externalTokenPrefix || "<PERSONAL_TOKEN>");
  const configSnippet = useMemo(
    () =>
      JSON.stringify(
        {
          mcpServers: {
            "t3-code": {
              type: "http",
              url: effectiveUrl,
              headers: { Authorization: `Bearer ${displayedToken}` },
            },
          },
        },
        null,
        2,
      ),
    [displayedToken, effectiveUrl],
  );

  const patchExternalMcp = (patch: Partial<typeof externalMcp>) => {
    updateServerSettings({
      experimental: {
        ...settings.experimental,
        externalMcp: { ...externalMcp, ...patch, apiKey: "" },
      },
    });
  };

  const persistIntegrations = async (
    integrations: ReadonlyArray<PersonalMcpIntegration>,
    secretPatch?: { readonly id: string; readonly value: string },
  ) => {
    if (!profile) return;
    await update({
      externalAccessEnabled: profile.externalAccessEnabled,
      integrations: integrations.map((integration) =>
        toUpdate(integration, secretPatch?.id === integration.id ? secretPatch.value : undefined),
      ),
    });
    if (secretPatch) {
      setCredentialDrafts((current) => ({ ...current, [secretPatch.id]: "" }));
    }
  };

  const patchIntegration = (
    id: string,
    patch: Partial<PersonalMcpIntegration>,
  ): ReadonlyArray<PersonalMcpIntegration> =>
    (profile?.integrations ?? []).map((integration) =>
      integration.id === id ? { ...integration, ...patch } : integration,
    );

  const addBifrost = () => {
    if (!profile) return;
    if (profile.integrations.some((entry) => entry.id === BIFROST_MCP_INTEGRATION_ID)) return;
    void persistIntegrations([...profile.integrations, buildBifrostIntegration()]);
  };

  return (
    <>
      <SettingsSection title="Personal T3 MCP access">
        <SettingsRow
          title="Enable MCP endpoint"
          description="Server-wide transport switch. Personal tokens remain user-scoped and cannot become server administrators."
          status={externalMcp.enabled ? `Available at ${effectiveUrl}` : "Disabled"}
          control={
            <Switch
              checked={externalMcp.enabled}
              onCheckedChange={(checked) => patchExternalMcp({ enabled: Boolean(checked) })}
              aria-label="Enable external T3 MCP endpoint"
            />
          }
        />

        <SettingsRow
          title="Public MCP URL"
          description="Shared endpoint URL. Authentication and accessible sessions are resolved separately for each personal token."
        >
          <Input
            className="mt-3 mb-3.5 font-mono text-xs"
            value={urlDraft ?? externalMcp.publicUrl}
            onChange={(event) => setUrlDraft(event.target.value)}
            onFocus={() => setUrlDraft(externalMcp.publicUrl)}
            onBlur={() => {
              const publicUrl = (urlDraft ?? externalMcp.publicUrl).trim();
              setUrlDraft(null);
              if (publicUrl !== externalMcp.publicUrl) patchExternalMcp({ publicUrl });
            }}
            placeholder={effectiveUrl}
            spellCheck={false}
          />
        </SettingsRow>

        <SettingsRow
          title="My external access"
          description="Allows your personal token to connect from agents outside T3. It can access only projects and sessions available to your account."
          control={
            <Switch
              checked={profile?.externalAccessEnabled ?? false}
              disabled={!profile}
              onCheckedChange={(checked) => {
                if (!profile) return;
                void update({
                  externalAccessEnabled: Boolean(checked),
                  integrations: profile.integrations,
                });
              }}
            />
          }
        />

        <SettingsRow
          title="Personal API token"
          description="The complete token is shown once after rotation. T3 stores only a hash; revoke it immediately if it is exposed."
          status={
            profile?.externalTokenConfigured
              ? `Configured as ${profile.externalTokenPrefix}`
              : "No token configured"
          }
        >
          <div className="mt-3 mb-2 flex gap-2">
            <Input
              className="font-mono text-xs"
              value={newToken ?? profile?.externalTokenPrefix ?? ""}
              readOnly
              placeholder="Rotate to create a personal token"
            />
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void rotateToken()
                  .then((token) => setNewToken(token))
                  .finally(() => setBusy(false));
              }}
            >
              <RefreshCwIcon />
              Rotate
            </Button>
            <Button
              size="icon-sm"
              variant="outline"
              disabled={!newToken}
              onClick={() => newToken && copyToken(newToken)}
              aria-label="Copy newly generated personal token"
            >
              <CopyIcon />
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!profile?.externalTokenConfigured || busy}
              onClick={() => {
                setBusy(true);
                void revokeToken()
                  .then(() => setNewToken(null))
                  .finally(() => setBusy(false));
              }}
            >
              Revoke
            </Button>
          </div>
          {newToken ? (
            <p className="mb-3 text-xs text-amber-600">
              Copy this token now. It cannot be revealed again.
              {tokenCopied ? " Copied." : ""}
            </p>
          ) : null}
        </SettingsRow>

        <SettingsRow
          title="Agent configuration"
          description="Use this same connection in Codex, Claude Code, OpenCode, or any Streamable HTTP MCP client."
        >
          <Textarea className="mt-3 min-h-44 font-mono text-xs" value={configSnippet} readOnly />
          <div className="mt-2 mb-3 flex justify-end">
            <Button
              size="sm"
              variant="outline"
              disabled={!newToken}
              onClick={() => copyConfig(configSnippet)}
            >
              <CopyIcon />
              {configCopied ? "Copied" : "Copy configuration"}
            </Button>
          </div>
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="My managed MCP integrations">
        <SettingsRow
          title="Credential routing"
          description="Every ACP receives only a short-lived T3 run token. T3 injects the credential below at its proxy boundary according to the authenticated turn initiator."
          control={
            <Button
              size="sm"
              variant="outline"
              onClick={addBifrost}
              disabled={
                !profile ||
                profile.integrations.some((entry) => entry.id === BIFROST_MCP_INTEGRATION_ID)
              }
            >
              <PlusIcon />
              Add Bifrost
            </Button>
          }
        />

        {(profile?.integrations ?? []).map((integration) => (
          <SettingsRow
            key={integration.id}
            title={integration.name}
            description={`${integration.id} · ${integration.credentialConfigured ? "Credential configured" : "Credential required"}`}
            control={
              <div className="flex items-center gap-2">
                <Switch
                  checked={integration.enabled}
                  onCheckedChange={(checked) =>
                    void persistIntegrations(
                      patchIntegration(integration.id, { enabled: Boolean(checked) }),
                    )
                  }
                />
                <Button
                  size="icon-sm"
                  variant="ghost"
                  onClick={() =>
                    void persistIntegrations(
                      (profile?.integrations ?? []).filter(
                        (candidate) => candidate.id !== integration.id,
                      ),
                    )
                  }
                  aria-label={`Remove ${integration.name}`}
                >
                  <Trash2Icon />
                </Button>
              </div>
            }
          >
            <div className="mt-3 mb-4 grid gap-2 md:grid-cols-2">
              {integration.id === BIFROST_MCP_INTEGRATION_ID ? (
                <Input
                  className="font-mono text-xs md:col-span-2"
                  value={BIFROST_MCP_URL}
                  readOnly
                  aria-label="Bifrost MCP URL"
                />
              ) : (
                <>
                  <Input
                    defaultValue={integration.name}
                    onBlur={(event) =>
                      void persistIntegrations(
                        patchIntegration(integration.id, { name: event.target.value }),
                      )
                    }
                    placeholder="Integration name"
                  />
                  <Input
                    className="font-mono text-xs"
                    defaultValue={integration.url}
                    onBlur={(event) =>
                      void persistIntegrations(
                        patchIntegration(integration.id, { url: event.target.value }),
                      )
                    }
                    placeholder="https://example.com/mcp"
                  />
                </>
              )}
              {integration.id === BIFROST_MCP_INTEGRATION_ID ? null : (
                <Select
                  value={integration.authMode}
                  onValueChange={(value) =>
                    void persistIntegrations(
                      patchIntegration(integration.id, {
                        authMode: value as PersonalMcpAuthMode,
                      }),
                    )
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectPopup>
                    <SelectItem value="x-bf-vk">Bifrost virtual key</SelectItem>
                    <SelectItem value="bearer">Bearer token</SelectItem>
                    <SelectItem value="x-api-key">x-api-key</SelectItem>
                    <SelectItem value="custom-header">Custom header</SelectItem>
                  </SelectPopup>
                </Select>
              )}
              <div className="flex gap-2">
                <Input
                  className="font-mono text-xs"
                  type="password"
                  value={credentialDrafts[integration.id] ?? ""}
                  onChange={(event) =>
                    setCredentialDrafts((current) => ({
                      ...current,
                      [integration.id]: event.target.value,
                    }))
                  }
                  placeholder={
                    integration.id === BIFROST_MCP_INTEGRATION_ID
                      ? integration.credentialConfigured
                        ? "Enter a replacement virtual key"
                        : "Enter your Bifrost virtual key"
                      : integration.credentialConfigured
                        ? "Enter a replacement credential"
                        : "Enter credential"
                  }
                />
                <Button
                  size="icon-sm"
                  variant="outline"
                  disabled={!(credentialDrafts[integration.id] ?? "")}
                  onClick={() =>
                    void persistIntegrations(profile?.integrations ?? [], {
                      id: integration.id,
                      value: credentialDrafts[integration.id] ?? "",
                    })
                  }
                  aria-label={`Save ${integration.name} credential`}
                >
                  <KeyRoundIcon />
                </Button>
              </div>
              {integration.id !== BIFROST_MCP_INTEGRATION_ID &&
              integration.authMode === "custom-header" ? (
                <Input
                  defaultValue={integration.customHeaderName}
                  onBlur={(event) =>
                    void persistIntegrations(
                      patchIntegration(integration.id, {
                        customHeaderName: event.target.value,
                      }),
                    )
                  }
                  placeholder="Header name"
                />
              ) : null}
              {integration.id === BIFROST_MCP_INTEGRATION_ID ? null : (
                <Input
                  className="font-mono text-xs"
                  defaultValue={integration.providerInstanceIds.join(", ")}
                  onBlur={(event) =>
                    void persistIntegrations(
                      patchIntegration(integration.id, {
                        providerInstanceIds: event.target.value
                          .split(",")
                          .map((value) => value.trim())
                          .filter(Boolean)
                          .map((value) => ProviderInstanceId.make(value)),
                      }),
                    )
                  }
                  placeholder="Provider instance IDs; blank means all ACPs"
                />
              )}
              {integration.id === BIFROST_MCP_INTEGRATION_ID ? null : (
                <Input
                  className="font-mono text-xs"
                  defaultValue={integration.allowedTools.join(", ")}
                  onBlur={(event) =>
                    void persistIntegrations(
                      patchIntegration(integration.id, {
                        allowedTools: event.target.value
                          .split(",")
                          .map((value) => value.trim())
                          .filter(Boolean),
                      }),
                    )
                  }
                  placeholder="Allowed tool names; blank means all"
                />
              )}
            </div>
          </SettingsRow>
        ))}
      </SettingsSection>
    </>
  );
}
