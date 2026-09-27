/**
 * T3-CUSTOM(expbkt3): Current authenticated user's automation/MCP profile.
 */
import { useAtomValue } from "@effect/atom-react";
import {
  EnvironmentId,
  type PersonalMcpProfile,
  type PersonalMcpProfileUpdate,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
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

  return {
    profile,
    loading: result.waiting,
    update,
    rotateToken,
    revokeToken,
    refresh,
  };
}
