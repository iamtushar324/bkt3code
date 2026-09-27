/**
 * T3-CUSTOM(expbkt3): "Your devices" — a member pairs their own clients.
 *
 * Upstream's "Authorized clients" panel needs `access:write`, which ordinary
 * members do not hold, so pairing a laptop or phone needed an environment
 * administrator every time. This is the member-scoped counterpart: their own
 * pending codes and paired devices, nothing else.
 *
 * The server does the narrowing — these endpoints return only the caller's own
 * records for a session without `access:read`/`access:write` — so this component
 * carries no authorization logic of its own beyond deciding to render.
 *
 * @module fork/MemberDevicesSection
 */
import { useCallback, useEffect, useState } from "react";

import {
  createServerPairingCredential,
  listServerClientSessions,
  listServerPairingLinks,
  revokeServerClientSession,
  revokeServerPairingLink,
  type ServerClientSessionRecord,
} from "../environments/primary";
import { SettingsRow, SettingsSection } from "../components/settings/settingsLayout";
import { Button } from "../components/ui/button";
import { Checkbox } from "../components/ui/checkbox";
import { Input } from "../components/ui/input";
import {
  memberPairingErrorMessage,
  toMemberDeviceSessions,
  toMemberPendingPairings,
  type MemberDeviceSession,
  type MemberPendingPairing,
} from "./memberDevices";

interface MemberDevicesState {
  readonly pending: ReadonlyArray<MemberPendingPairing>;
  readonly devices: ReadonlyArray<MemberDeviceSession>;
}

const EMPTY_STATE: MemberDevicesState = { pending: [], devices: [] };

export function MemberDevicesSection() {
  const [state, setState] = useState<MemberDevicesState>(EMPTY_STATE);
  const [error, setError] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [label, setLabel] = useState("");
  const [deviceBound, setDeviceBound] = useState(false);
  const [issuedCredential, setIssuedCredential] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [pairingLinks, clientSessions] = await Promise.all([
        listServerPairingLinks(),
        listServerClientSessions(),
      ]);
      setState({
        pending: toMemberPendingPairings(pairingLinks),
        devices: toMemberDeviceSessions(clientSessions),
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load your devices.");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleCreate = useCallback(async () => {
    setIsBusy(true);
    setError(null);
    try {
      const created = await createServerPairingCredential({
        label,
        ...(deviceBound ? { requireProofOfPossession: true } : {}),
      });
      // Shown once: the server never returns it again.
      setIssuedCredential(created.credential);
      setLabel("");
      setDeviceBound(false);
      await refresh();
    } catch (cause) {
      setError(memberPairingErrorMessage(cause));
    } finally {
      setIsBusy(false);
    }
  }, [deviceBound, label, refresh]);

  const handleRevokePending = useCallback(
    async (id: string) => {
      setIsBusy(true);
      try {
        await revokeServerPairingLink(id);
        await refresh();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Could not revoke that code.");
      } finally {
        setIsBusy(false);
      }
    },
    [refresh],
  );

  const handleRevokeDevice = useCallback(
    async (sessionId: ServerClientSessionRecord["sessionId"]) => {
      setIsBusy(true);
      try {
        await revokeServerClientSession(sessionId);
        await refresh();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Could not revoke that device.");
      } finally {
        setIsBusy(false);
      }
    },
    [refresh],
  );

  return (
    <SettingsSection title="Your devices">
      <SettingsRow
        title="Pair a device"
        description="Generate a code, then enter it in the app you want to connect. The code is shown once."
        control={
          <div className="flex items-center gap-2">
            <Input
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder="e.g. Work laptop"
              disabled={isBusy}
              className="w-44"
            />
            <Button size="xs" disabled={isBusy} onClick={() => void handleCreate()}>
              {isBusy ? "Working…" : "Generate"}
            </Button>
          </div>
        }
      />
      <SettingsRow
        title="Desktop app"
        description="Device-bound: valid for 2 hours and usable only by the app that redeems it."
        control={
          <Checkbox
            checked={deviceBound}
            disabled={isBusy}
            onCheckedChange={(checked) => setDeviceBound(checked === true)}
            aria-label="Pair a BK desktop app"
          />
        }
      />
      {issuedCredential ? (
        <div className="px-3 py-2.5">
          <p className="text-xs font-medium text-foreground">Your pairing code</p>
          <code className="mt-1 block font-mono text-sm break-all text-foreground">
            {issuedCredential}
          </code>
          <p className="mt-1 text-xs text-muted-foreground">
            Copy it now — it will not be shown again.
          </p>
          <Button
            size="xs"
            variant="outline"
            className="mt-2"
            onClick={() => setIssuedCredential(null)}
          >
            Done
          </Button>
        </div>
      ) : null}
      {error ? <p className="px-3 py-2 text-xs text-destructive">{error}</p> : null}
      {state.pending.map((pending) => (
        <SettingsRow
          key={pending.id}
          title={pending.label ?? "Unnamed code"}
          description={`Waiting to be used · expires ${pending.expiresAt}`}
          control={
            <Button
              size="xs"
              variant="destructive-outline"
              disabled={isBusy}
              onClick={() => void handleRevokePending(pending.id)}
            >
              Cancel
            </Button>
          }
        />
      ))}
      {state.devices.map((device) => (
        <SettingsRow
          key={device.sessionId}
          title={device.label ?? "Paired device"}
          description={[
            device.deviceBound ? "Device-bound" : "Bearer",
            device.current ? "This device" : null,
            device.lastConnectedAt ? `Last seen ${device.lastConnectedAt}` : null,
          ]
            .filter((part) => part !== null)
            .join(" · ")}
          control={
            device.current ? undefined : (
              <Button
                size="xs"
                variant="destructive-outline"
                disabled={isBusy}
                onClick={() => void handleRevokeDevice(device.sessionId)}
              >
                Revoke
              </Button>
            )
          }
        />
      ))}
      {state.pending.length === 0 && state.devices.length === 0 ? (
        <p className="px-3 py-2 text-xs text-muted-foreground">No paired devices yet.</p>
      ) : null}
    </SettingsSection>
  );
}
