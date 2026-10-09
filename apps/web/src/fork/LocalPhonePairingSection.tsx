// T3-CUSTOM(expbkt3): BK Add-ons → "Connect phone to local server" (managed desktop only).
/**
 * A managed BK desktop's primary environment is the central server, so the
 * Connections page and every other pairing surface target that server. The
 * desktop also runs a bundled local backend as a secondary environment. This
 * section pairs a phone (the T3 Code mobile app) with that local backend:
 *
 * 1. the local server's status and address,
 * 2. how a phone reaches it (network access and Tailscale HTTPS, both handled by
 *    the desktop bridge, which in a managed build acts on the bundled backend),
 * 3. an admin pairing link, code and QR code minted on the local server with the
 *    renderer's existing connection to it.
 *
 * Pure decisions and copy live in `localPhonePairing.logic.ts`; the HTTP calls
 * live in `localServerPairing.ts`.
 *
 * @module fork/LocalPhonePairingSection
 */
import {
  type AdvertisedEndpoint,
  AuthAccessWriteScope,
  AuthAdministrativeScopes,
  sessionGrantsScope,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { RefreshCwIcon } from "lucide-react";
import { type ReactNode, useCallback, useMemo, useState } from "react";

import { isTailscaleHttpsEndpoint } from "../components/settings/ConnectionsSettings.logic";
import {
  SettingsRow,
  SettingsSection,
  useRelativeTimeTick,
} from "../components/settings/settingsLayout";
import { searchableSetting } from "../components/settings/settingsSearch";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { QRCodeSvg } from "../components/ui/qr-code";
import { Switch } from "../components/ui/switch";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { requestConfirmDialog } from "../confirmDialog";
import { useCopyToClipboard } from "../hooks/useCopyToClipboard";
import { cn } from "../lib/utils";
import {
  desktopNetworkAccessStateAtom,
  refreshDesktopNetworkAccessState,
} from "../state/desktopNetworkAccess";
import {
  type EnvironmentPresentation,
  useEnvironmentHttpBaseUrl,
  useEnvironments,
} from "../state/environments";
import { useEnvironmentQuery } from "../state/query";
import { useEnvironmentSessionState } from "../state/session";
import {
  bridgeChangeConfirmation,
  describeLocalPairingError,
  findBundledBackendEnvironment,
  LOCAL_PHONE_PAIRING_LABEL,
  localServerStatus,
  type LocalServerStatus,
  networkAccessDescription,
  NO_PHONE_ADDRESS_MESSAGE,
  PAIR_PHONE_DESCRIPTION,
  phonePairingExpiryLabel,
  phonePairingHostUrl,
  phonePairingUrl,
  phoneReachableEndpoints,
  selectPhonePairingEndpoint,
  tailscaleHttpsDescription,
} from "./localPhonePairing.logic";
import {
  createLocalServerPairingCredential,
  revokeLocalServerPairingLink,
} from "./localServerPairing";
import { isBkManagedPrimary } from "./managedEnvironment";

const EMPTY_ENDPOINTS: ReadonlyArray<AdvertisedEndpoint> = [];
/** Tailscale Serve's port when the desktop has none saved (as on the Connections page). */
const DEFAULT_TAILSCALE_SERVE_PORT = 443;
const MISSING_SERVER_STATUS = localServerStatus({
  present: false,
  phase: null,
  error: null,
  sessionChecked: false,
  canWriteAccess: false,
});

type BridgeChange = "network" | "tailscale";

interface IssuedPairing {
  readonly id: string;
  readonly credential: string;
  readonly expiresAtMs: number;
}

/** Renders only in a managed desktop build, the one build with a central primary. */
export function LocalPhonePairingSection() {
  if (typeof window === "undefined" || window.desktopBridge === undefined) return null;
  if (!isBkManagedPrimary()) return null;
  return <LocalPhonePairingSettings />;
}

function statusBadgeVariant(status: LocalServerStatus): "success" | "secondary" | "warning" {
  switch (status.kind) {
    case "ready":
      return "success";
    case "starting":
    case "checking":
      return "secondary";
    case "missing":
    case "failed":
    case "no-access":
      return "warning";
  }
}

function LocalPhonePairingSettings() {
  const { environments } = useEnvironments();
  const bundled = useMemo(() => findBundledBackendEnvironment(environments), [environments]);
  const networkAccess = useEnvironmentQuery(desktopNetworkAccessStateAtom);
  const exposure = networkAccess.data?.serverExposureState ?? null;
  const advertisedEndpoints = networkAccess.data?.advertisedEndpoints ?? EMPTY_ENDPOINTS;
  const networkAccessible = exposure?.mode === "network-accessible";
  const tailscalePort = exposure?.tailscaleServePort ?? DEFAULT_TAILSCALE_SERVE_PORT;
  const tailscaleHttpsEndpoint = useMemo(
    () => advertisedEndpoints.find(isTailscaleHttpsEndpoint) ?? null,
    [advertisedEndpoints],
  );
  const candidates = useMemo(
    () => phoneReachableEndpoints({ endpoints: advertisedEndpoints, networkAccessible }),
    [advertisedEndpoints, networkAccessible],
  );
  const [selectedEndpointId, setSelectedEndpointId] = useState<string | null>(null);
  const endpoint = selectPhonePairingEndpoint(candidates, selectedEndpointId);
  const [updating, setUpdating] = useState<BridgeChange | null>(null);
  const [bridgeError, setBridgeError] = useState<string | null>(null);

  // Both bridge calls relaunch the whole app to rebind the bundled backend, so
  // each one is confirmed first. A missing confirm host counts as "no".
  const changeBridge = useCallback(
    async (kind: BridgeChange, enable: boolean) => {
      const bridge = window.desktopBridge;
      if (!bridge) return;
      const confirmed = await requestConfirmDialog(
        bridgeChangeConfirmation({ kind, enable, tailscalePort }),
      );
      if (confirmed !== true) return;
      setUpdating(kind);
      setBridgeError(null);
      try {
        if (kind === "network") {
          await bridge.setServerExposureMode(enable ? "network-accessible" : "local-only");
        } else {
          await bridge.setTailscaleServeEnabled({ enabled: enable, port: tailscalePort });
        }
        refreshDesktopNetworkAccessState();
      } catch (cause) {
        const title = kind === "network" ? "Network access" : "Tailscale HTTPS";
        const message = describeLocalPairingError(cause, `Could not change ${title}.`);
        setBridgeError(message);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: `Could not change ${title}`,
            description: message,
          }),
        );
      } finally {
        setUpdating(null);
      }
    },
    [tailscalePort],
  );

  const reachabilityRows = (
    <>
      <SettingsRow
        title="Reachable on my network"
        description={networkAccessDescription({
          mode: exposure?.mode ?? null,
          loadError: networkAccess.error,
        })}
        status={bridgeError ? <span className="text-destructive">{bridgeError}</span> : null}
        control={
          <Switch
            checked={networkAccessible}
            disabled={exposure === null || updating !== null}
            onCheckedChange={(checked) => void changeBridge("network", Boolean(checked))}
            aria-label="Make the local server reachable on my network"
          />
        }
      />
      <SettingsRow
        title="Tailscale HTTPS"
        description={tailscaleHttpsDescription(tailscaleHttpsEndpoint)}
        control={
          tailscaleHttpsEndpoint === null ? undefined : (
            <Switch
              checked={tailscaleHttpsEndpoint.status === "available"}
              disabled={updating !== null}
              onCheckedChange={(checked) => void changeBridge("tailscale", Boolean(checked))}
              aria-label="Serve the local server over Tailscale HTTPS"
            />
          )
        }
      />
      {candidates.length > 1 ? (
        <EndpointPicker
          candidates={candidates}
          selectedId={endpoint?.id ?? null}
          onSelect={setSelectedEndpointId}
        />
      ) : null}
    </>
  );

  return (
    <SettingsSection
      {...searchableSetting("connect-phone-local")}
      headerAction={
        <Button
          size="xs"
          variant="ghost"
          aria-label="Refresh the local server's addresses"
          onClick={networkAccess.refresh}
        >
          <RefreshCwIcon />
          Refresh
        </Button>
      }
    >
      {bundled === null ? (
        <>
          <LocalServerStatusRow status={MISSING_SERVER_STATUS} address={null} />
          {reachabilityRows}
        </>
      ) : (
        <BundledServerRows
          environment={bundled}
          endpoint={endpoint}
          endpointsLoaded={exposure !== null}
          reachability={reachabilityRows}
        />
      )}
    </SettingsSection>
  );
}

function EndpointPicker({
  candidates,
  selectedId,
  onSelect,
}: {
  readonly candidates: ReadonlyArray<AdvertisedEndpoint>;
  readonly selectedId: string | null;
  readonly onSelect: (id: string) => void;
}) {
  return (
    <SettingsRow
      title="Phone connects through"
      description="Pick an address your phone can reach. A tailnet address works anywhere on your tailnet. A local network address works only on the same Wi-Fi."
    >
      <div
        role="radiogroup"
        aria-label="Address the pairing link uses"
        className="space-y-1.5 py-2"
      >
        {candidates.map((candidate) => {
          const isSelected = candidate.id === selectedId;
          return (
            <button
              key={candidate.id}
              type="button"
              role="radio"
              aria-checked={isSelected}
              className={cn(
                "flex w-full items-baseline gap-2 rounded-lg border px-2.5 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring",
                isSelected
                  ? "border-foreground/60 bg-muted/30"
                  : "border-border/50 hover:bg-muted/20",
              )}
              onClick={() => onSelect(candidate.id)}
            >
              <span
                className={cn(
                  "shrink-0 text-xs font-medium",
                  isSelected ? "text-foreground" : "text-muted-foreground",
                )}
              >
                {candidate.label}
              </span>
              <span className="min-w-0 truncate text-2xs text-muted-foreground/70">
                {phonePairingHostUrl(candidate)}
              </span>
            </button>
          );
        })}
      </div>
    </SettingsRow>
  );
}

function LocalServerStatusRow({
  status,
  address,
}: {
  readonly status: LocalServerStatus;
  readonly address: string | null;
}) {
  return (
    <SettingsRow
      title="Local server"
      description={status.detail}
      status={address ? `Address on this Mac: ${address}` : null}
      control={<Badge variant={statusBadgeVariant(status)}>{status.label}</Badge>}
    />
  );
}

function BundledServerRows({
  environment,
  endpoint,
  endpointsLoaded,
  reachability,
}: {
  readonly environment: EnvironmentPresentation;
  readonly endpoint: AdvertisedEndpoint | null;
  readonly endpointsLoaded: boolean;
  readonly reachability: ReactNode;
}) {
  const environmentId = environment.environmentId;
  const session = useEnvironmentSessionState(environmentId);
  const httpBaseUrl = useEnvironmentHttpBaseUrl(environmentId);
  const canWriteAccess =
    !session.hasError &&
    session.data !== null &&
    sessionGrantsScope(session.data, AuthAccessWriteScope);
  const status = localServerStatus({
    present: true,
    phase: environment.connection.phase,
    error: environment.connection.error,
    sessionChecked: session.data !== null || session.hasError,
    canWriteAccess,
  });
  const [issued, setIssued] = useState<IssuedPairing | null>(null);
  const [generating, setGenerating] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const generate = useCallback(async () => {
    setGenerating(true);
    setError(null);
    const previous = issued;
    try {
      const created = await createLocalServerPairingCredential(environmentId, {
        label: LOCAL_PHONE_PAIRING_LABEL,
        scopes: AuthAdministrativeScopes,
      });
      setIssued({
        id: created.id,
        credential: created.credential,
        expiresAtMs: DateTime.toEpochMillis(created.expiresAt),
      });
      // A replaced admin link must not stay usable for the rest of its five minutes.
      if (previous !== null && previous.expiresAtMs > Date.now()) {
        void revokeLocalServerPairingLink(environmentId, previous.id).catch(() => undefined);
      }
    } catch (cause) {
      setError(describeLocalPairingError(cause, "Could not create a pairing link."));
    } finally {
      setGenerating(false);
    }
  }, [environmentId, issued]);

  const revoke = useCallback(async () => {
    if (issued === null) return;
    setRevoking(true);
    setError(null);
    try {
      const revoked = await revokeLocalServerPairingLink(environmentId, issued.id);
      setIssued(null);
      toastManager.add({
        type: "success",
        title: revoked ? "Pairing link revoked" : "Pairing link already gone",
        description: revoked
          ? "The code no longer works."
          : "The code was already used or has expired.",
      });
    } catch (cause) {
      setError(describeLocalPairingError(cause, "Could not revoke the pairing link."));
    } finally {
      setRevoking(false);
    }
  }, [environmentId, issued]);

  const ready = status.kind === "ready";
  const noAddress = ready && endpointsLoaded && endpoint === null;
  let rowStatus: ReactNode = null;
  if (error) {
    rowStatus = <span className="text-destructive">{error}</span>;
  } else if (noAddress) {
    rowStatus = <span className="text-warning">{NO_PHONE_ADDRESS_MESSAGE}</span>;
  }
  let buttonLabel = "Generate pairing link";
  if (generating) buttonLabel = "Generating…";
  else if (issued) buttonLabel = "Generate new link";

  return (
    <>
      <LocalServerStatusRow status={status} address={httpBaseUrl ?? environment.displayUrl} />
      {reachability}
      <SettingsRow
        title="Pair a phone"
        description={PAIR_PHONE_DESCRIPTION}
        status={rowStatus}
        control={
          <Button
            size="sm"
            variant="outline"
            disabled={!ready || endpoint === null || generating}
            onClick={() => void generate()}
          >
            {buttonLabel}
          </Button>
        }
      >
        {issued ? (
          <IssuedPairingPanel
            issued={issued}
            endpoint={endpoint}
            revoking={revoking}
            onRevoke={() => void revoke()}
          />
        ) : null}
      </SettingsRow>
    </>
  );
}

type CopyTarget = "Pairing link" | "Pairing code" | "Server address";

function IssuedPairingPanel({
  issued,
  endpoint,
  revoking,
  onRevoke,
}: {
  readonly issued: IssuedPairing;
  readonly endpoint: AdvertisedEndpoint | null;
  readonly revoking: boolean;
  readonly onRevoke: () => void;
}) {
  const nowMs = useRelativeTimeTick(1_000);
  const { copyToClipboard } = useCopyToClipboard<CopyTarget>({
    onCopy: (target) => {
      toastManager.add({ type: "success", title: `${target} copied` });
    },
    onError: (copyError, target) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: `Could not copy the ${target.toLowerCase()}`,
          description: copyError.message,
        }),
      );
    },
  });
  const expiryLabel = phonePairingExpiryLabel(issued.expiresAtMs, nowMs);
  if (issued.expiresAtMs <= nowMs) {
    return <p className="py-2 text-xs text-muted-foreground">{expiryLabel}</p>;
  }
  const url = endpoint ? phonePairingUrl(endpoint, issued.credential) : null;
  const host = endpoint ? phonePairingHostUrl(endpoint) : null;
  const expiresAt = new Date(issued.expiresAtMs).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

  return (
    <div className="flex flex-col gap-4 border-t border-border/50 py-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0 flex-1 space-y-2.5">
        <p className="text-xs text-muted-foreground">
          Scan the QR code with the T3 Code app, or paste the link. To enter it by hand, use the
          server address and the pairing code.
        </p>
        {url ? (
          <CopyableValue
            label="Pairing link"
            value={url}
            onCopy={() => copyToClipboard(url, "Pairing link")}
          />
        ) : null}
        {host ? (
          <CopyableValue
            label="Server address"
            value={host}
            onCopy={() => copyToClipboard(host, "Server address")}
          />
        ) : null}
        <CopyableValue
          label="Pairing code"
          value={issued.credential}
          onCopy={() => copyToClipboard(issued.credential, "Pairing code")}
        />
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-xs text-muted-foreground">{`${expiryLabel} (at ${expiresAt})`}</p>
          <Button size="xs" variant="destructive-outline" disabled={revoking} onClick={onRevoke}>
            {revoking ? "Revoking…" : "Revoke"}
          </Button>
        </div>
      </div>
      {url ? (
        <div className="w-fit shrink-0 self-center rounded-xl bg-white p-3 sm:self-start">
          <QRCodeSvg
            value={url}
            size={168}
            level="M"
            marginSize={1}
            title="Pairing link. Scan it with the T3 Code app on your phone."
          />
        </div>
      ) : null}
    </div>
  );
}

function CopyableValue({
  label,
  value,
  onCopy,
}: {
  readonly label: string;
  readonly value: string;
  readonly onCopy: () => void;
}) {
  return (
    <div className="space-y-1">
      <p className="text-2xs text-muted-foreground/70">{label}</p>
      <div className="flex items-center gap-2 rounded-lg border border-border/60 bg-muted/30 px-2.5 py-1.5">
        <code className="min-w-0 flex-1 font-mono text-2xs break-all text-foreground">{value}</code>
        <Button
          size="xs"
          variant="ghost"
          className="shrink-0"
          aria-label={`Copy ${label.toLowerCase()}`}
          onClick={onCopy}
        >
          Copy
        </Button>
      </div>
    </div>
  );
}
