// T3-CUSTOM(expbkt3): BK Add-ons → "Connect phone to local server" (managed desktop only).
/**
 * A managed BK desktop's primary environment is the central server, so the
 * Connections page and every other pairing surface target that server. The
 * desktop also runs a bundled local backend as a secondary environment. This
 * section pairs a phone (the T3 Code mobile app) with that local backend:
 *
 * 1. the local server's status and address,
 * 2. how a phone reaches it: network access (the desktop bridge, which in a
 *    managed build acts on the bundled backend) and a direct address to dial:
 *    the Mac's MagicDNS name first (one name for every tailnet the Mac is shared
 *    with), then its Tailscale IP, then its local network IP. No Tailscale Serve,
 * 3. an admin pairing link, code and QR code minted on the local server with the
 *    renderer's existing connection to it,
 * 4. the devices paired with the local server, each with a Revoke button.
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
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";

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
  describeLocalPairingError,
  findBundledBackendEnvironment,
  localServerStatus,
  type LocalServerStatus,
  networkAccessDescription,
  networkChangeConfirmation,
  NO_PHONE_ADDRESS_MESSAGE,
  PAIR_PHONE_DESCRIPTION,
  type PairedDevice,
  pairedDevices,
  phonePairingExpiryLabel,
  phonePairingHostUrl,
  phonePairingLabel,
  phonePairingUrl,
  phoneReachableEndpoints,
  selectPhonePairingEndpoint,
} from "./localPhonePairing.logic";
import {
  createLocalServerPairingCredential,
  listLocalServerClients,
  revokeLocalServerClient,
  revokeLocalServerPairingLink,
} from "./localServerPairing";
import { isBkManagedPrimary } from "./managedEnvironment";

const EMPTY_ENDPOINTS: ReadonlyArray<AdvertisedEndpoint> = [];
/** How often the paired devices list re-reads the server while it is on screen. */
const PAIRED_DEVICES_REFRESH_MS = 15_000;
const MISSING_SERVER_STATUS = localServerStatus({
  present: false,
  phase: null,
  error: null,
  sessionChecked: false,
  canWriteAccess: false,
});

interface IssuedPairing {
  readonly id: string;
  readonly credential: string;
  readonly expiresAtMs: number;
  /** The address the link was made for; its label names this path. */
  readonly endpoint: AdvertisedEndpoint;
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
  const candidates = useMemo(
    () => phoneReachableEndpoints({ endpoints: advertisedEndpoints, networkAccessible }),
    [advertisedEndpoints, networkAccessible],
  );
  const [selectedEndpointId, setSelectedEndpointId] = useState<string | null>(null);
  const endpoint = selectPhonePairingEndpoint(candidates, selectedEndpointId);
  const [updating, setUpdating] = useState(false);
  const [bridgeError, setBridgeError] = useState<string | null>(null);

  // The bridge relaunches the whole app to rebind the bundled backend, so the
  // change is confirmed first. A missing confirm host counts as "no".
  const changeNetwork = useCallback(async (enable: boolean) => {
    const bridge = window.desktopBridge;
    if (!bridge) return;
    const confirmed = await requestConfirmDialog(networkChangeConfirmation(enable));
    if (confirmed !== true) return;
    setUpdating(true);
    setBridgeError(null);
    try {
      await bridge.setServerExposureMode(enable ? "network-accessible" : "local-only");
      refreshDesktopNetworkAccessState();
    } catch (cause) {
      const message = describeLocalPairingError(cause, "Could not change network access.");
      setBridgeError(message);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not change network access",
          description: message,
        }),
      );
    } finally {
      setUpdating(false);
    }
  }, []);

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
            disabled={exposure === null || updating}
            onCheckedChange={(checked) => void changeNetwork(Boolean(checked))}
            aria-label="Make the local server reachable on my network"
          />
        }
      />
      {candidates.length > 0 ? (
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
      description="Select the address for this link. The MagicDNS name works from every tailnet you share this Mac with, so keep the Mac on one Tailscale profile and share it. The Tailscale IP belongs to the profile that is active now. The local network IP works only on the same Wi-Fi."
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
    if (endpoint === null) return;
    setGenerating(true);
    setError(null);
    const previous = issued;
    try {
      const created = await createLocalServerPairingCredential(environmentId, {
        label: phonePairingLabel(endpoint),
        scopes: AuthAdministrativeScopes,
      });
      setIssued({
        id: created.id,
        credential: created.credential,
        expiresAtMs: DateTime.toEpochMillis(created.expiresAt),
        endpoint,
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
  }, [endpoint, environmentId, issued]);

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
          <IssuedPairingPanel issued={issued} revoking={revoking} onRevoke={() => void revoke()} />
        ) : null}
      </SettingsRow>
      {ready ? <PairedDevicesRow environmentId={environmentId} /> : null}
    </>
  );
}

function PairedDevicesRow({
  environmentId,
}: {
  readonly environmentId: EnvironmentPresentation["environmentId"];
}) {
  const [devices, setDevices] = useState<ReadonlyArray<PairedDevice> | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const sessions = await listLocalServerClients(environmentId);
      const formatTime = (epochMs: number) =>
        new Date(epochMs).toLocaleString([], {
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        });
      setDevices(pairedDevices(sessions, formatTime));
      setLoadError(null);
    } catch (cause) {
      setLoadError(describeLocalPairingError(cause, "Could not read the paired devices."));
    }
  }, [environmentId]);

  // A phone pairs on its own time, so the list re-reads the server while it shows.
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), PAIRED_DEVICES_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  const revoke = useCallback(
    async (device: PairedDevice) => {
      const confirmed = await requestConfirmDialog(
        `Revoke ${device.title}?\nThis device loses its access to the local server at once. Pair it again to reconnect.`,
      );
      if (confirmed !== true) return;
      setRevokingId(device.sessionId);
      try {
        const revoked = await revokeLocalServerClient(environmentId, device.sessionId);
        toastManager.add({
          type: "success",
          title: revoked ? "Device revoked" : "Device already gone",
        });
        await load();
      } catch (cause) {
        const message = describeLocalPairingError(cause, "Could not revoke the device.");
        toastManager.add(
          stackedThreadToast({ type: "error", title: "Could not revoke", description: message }),
        );
      } finally {
        setRevokingId(null);
      }
    },
    [environmentId, load],
  );

  let description = "Phones and other clients paired with the local server on this Mac.";
  if (devices !== null && devices.length === 0) description = "No device is paired yet.";
  return (
    <SettingsRow
      title="Paired devices"
      description={description}
      status={loadError ? <span className="text-destructive">{loadError}</span> : null}
    >
      {devices !== null && devices.length > 0 ? (
        <ul className="divide-y divide-border/50 border-t border-border/50">
          {devices.map((device) => (
            <li key={device.sessionId} className="flex items-center gap-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-medium text-foreground">{device.title}</p>
                <p className="truncate text-2xs text-muted-foreground">{device.detail}</p>
              </div>
              <Button
                size="xs"
                variant="destructive-outline"
                disabled={revokingId !== null}
                onClick={() => void revoke(device)}
              >
                {revokingId === device.sessionId ? "Revoking…" : "Revoke"}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </SettingsRow>
  );
}

type CopyTarget = "Pairing link" | "Pairing code" | "Server address";

function IssuedPairingPanel({
  issued,
  revoking,
  onRevoke,
}: {
  readonly issued: IssuedPairing;
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
  const url = phonePairingUrl(issued.endpoint, issued.credential);
  const host = phonePairingHostUrl(issued.endpoint);
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
        <CopyableValue
          label="Pairing link"
          value={url}
          onCopy={() => copyToClipboard(url, "Pairing link")}
        />
        <CopyableValue
          label="Server address"
          value={host}
          onCopy={() => copyToClipboard(host, "Server address")}
        />
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
      <div className="w-fit shrink-0 self-center rounded-xl bg-white p-3 sm:self-start">
        <QRCodeSvg
          value={url}
          size={168}
          level="M"
          marginSize={1}
          title="Pairing link. Scan it with the T3 Code app on your phone."
        />
      </div>
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
