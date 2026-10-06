/**
 * T3-CUSTOM(expbkt3): Current authenticated user's automation/MCP profile.
 */
import { useAtomValue } from "@effect/atom-react";
import {
  EnvironmentId,
  type PersonalMcpProfile,
  type PersonalMcpProfileUpdate,
  type PersonalMcpToolyardConnectResult,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import * as Option from "effect/Option";
import { useCallback, useMemo } from "react";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { usePrimaryEnvironmentId } from "../state/environments";
import { serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";

export function usePersonalMcpProfile() {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const environmentId = primaryEnvironmentId ?? EnvironmentId.make("unavailable");
  const target = useMemo(() => ({ environmentId, input: {} }), [environmentId]);
  const profileAtom = useMemo(() => serverEnvironment.personalMcpProfile(target), [target]);
  const result = useAtomValue(profileAtom);
  const profile = Option.getOrNull(AsyncResult.value(result));
  const updateCommand = useAtomCommand(
    serverEnvironment.updatePersonalMcpProfile,
    "personal MCP profile update",
  );
  const rotateCommand = useAtomCommand(
    serverEnvironment.rotatePersonalMcpToken,
    "personal MCP token rotation",
  );
  const revokeCommand = useAtomCommand(
    serverEnvironment.revokePersonalMcpToken,
    "personal MCP token revocation",
  );
  // Quiet on failure: the auto-connect runs unattended and the settings card
  // words the outcome itself.
  const connectToolyardCommand = useAtomCommand(serverEnvironment.connectToolyard, {
    label: "toolyard connect",
    reportFailure: false,
    reportDefect: false,
  });
  const refresh = useCallback(() => appAtomRegistry.refresh(profileAtom), [profileAtom]);

  const update = useCallback(
    async (input: PersonalMcpProfileUpdate): Promise<PersonalMcpProfile | null> => {
      if (primaryEnvironmentId === null) return null;
      const updated = await updateCommand({ environmentId: primaryEnvironmentId, input });
      if (!AsyncResult.isSuccess(updated)) return null;
      refresh();
      return updated.value;
    },
    [primaryEnvironmentId, refresh, updateCommand],
  );

  const rotateToken = useCallback(async (): Promise<string | null> => {
    if (primaryEnvironmentId === null) return null;
    const rotated = await rotateCommand({ environmentId: primaryEnvironmentId, input: {} });
    if (!AsyncResult.isSuccess(rotated)) return null;
    refresh();
    return rotated.value.token ?? null;
  }, [primaryEnvironmentId, refresh, rotateCommand]);

  const revokeToken = useCallback(async (): Promise<boolean> => {
    if (primaryEnvironmentId === null) return false;
    const revoked = await revokeCommand({ environmentId: primaryEnvironmentId, input: {} });
    if (!AsyncResult.isSuccess(revoked)) return false;
    refresh();
    return true;
  }, [primaryEnvironmentId, refresh, revokeCommand]);

  /**
   * Connects the built-in toolyard integration with a fresh Clerk token. The
   * token is consumed once by the server; the result never carries a credential.
   * `null` means the RPC itself failed (transport, authorization).
   */
  const connectToolyard = useCallback(
    async (clerkToken: string): Promise<PersonalMcpToolyardConnectResult | null> => {
      if (primaryEnvironmentId === null) return null;
      const connected = await connectToolyardCommand({
        environmentId: primaryEnvironmentId,
        input: { clerkToken },
      });
      if (!AsyncResult.isSuccess(connected)) return null;
      refresh();
      return connected.value;
    },
    [connectToolyardCommand, primaryEnvironmentId, refresh],
  );

  return {
    profile,
    loading: result.waiting,
    update,
    rotateToken,
    revokeToken,
    connectToolyard,
    refresh,
  };
}
