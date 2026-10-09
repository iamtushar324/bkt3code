// T3-CUSTOM(expbkt3): the shared custom-group registry on mobile (XFN-59).
//
// The same reads and writes as web's hook of the same name: every connected
// host's `threadCustomGroups` server setting merged into one registry, and the
// settings patches client-runtime plans. Mobile has no primary environment, so
// a new group goes to the environment in focus when this session may write
// its settings, else the first host that can take it. Hosts too old to keep
// the registry, or that this session may not write, are left out, and the
// sidebar keeps its device-local placeholder groups for them.
import {
  buildPhaseSidebarCustomGroupRegistry,
  phaseSidebarCustomGroupRegistryEnvironmentIds,
  planPhaseSidebarCustomGroupCreate,
  planPhaseSidebarCustomGroupDelete,
  planPhaseSidebarCustomGroupRecolor,
  planPhaseSidebarCustomGroupRename,
  resolvePhaseSidebarCustomGroupHome,
  type PhaseSidebarCustomGroupRegistry,
  type PhaseSidebarCustomGroupWritePlan,
} from "@t3tools/client-runtime/state/phase-sidebar-custom-group-registry";
import { AuthSettingsWriteScope, type EnvironmentId, type ServerConfig } from "@t3tools/contracts";
import { useCallback, useMemo } from "react";
import { Alert } from "react-native";

import { useServerConfigs } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentsWithScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";

export interface PhaseSidebarCustomGroupRegistryControls {
  readonly registry: PhaseSidebarCustomGroupRegistry;
  /** Where a new group goes; null when groups stay device-local placeholders. */
  readonly homeEnvironmentId: EnvironmentId | null;
  /** Returns the group id when the registry holds or now receives it, else null. */
  readonly createGroup: (label: string) => string | null;
  readonly renameGroup: (id: string, label: string) => void;
  readonly deleteGroup: (id: string) => void;
  /** `colorId` null restores the default look. */
  readonly recolorGroup: (id: string, label: string, colorId: string | null) => void;
}

const EMPTY_SERVER_CONFIGS: ReadonlyMap<EnvironmentId, ServerConfig> = new Map();

export function usePhaseSidebarCustomGroupRegistry(input: {
  /** The environment in focus; it wins a conflict and receives new groups. */
  readonly preferredEnvironmentId: EnvironmentId | null;
  /** Home's environment scope: when set, only that host's groups are shown. */
  readonly scopeEnvironmentId: EnvironmentId | null;
}): PhaseSidebarCustomGroupRegistryControls {
  const { preferredEnvironmentId, scopeEnvironmentId } = input;
  const allServerConfigs = useServerConfigs();
  const serverConfigs = useMemo(() => {
    if (scopeEnvironmentId === null) return allServerConfigs;
    const config = allServerConfigs.get(scopeEnvironmentId);
    return config === undefined
      ? EMPTY_SERVER_CONFIGS
      : new Map<EnvironmentId, ServerConfig>([[scopeEnvironmentId, config]]);
  }, [allServerConfigs, scopeEnvironmentId]);
  const registry = useMemo(
    () => buildPhaseSidebarCustomGroupRegistry(serverConfigs, preferredEnvironmentId),
    [preferredEnvironmentId, serverConfigs],
  );
  // Keyed by the id list, so a settings update does not resubscribe every grant.
  const registryEnvironmentKey =
    phaseSidebarCustomGroupRegistryEnvironmentIds(serverConfigs).join("\n");
  const registryEnvironments = useMemo(
    () =>
      registryEnvironmentKey.length === 0
        ? []
        : registryEnvironmentKey
            .split("\n")
            .map((environmentId) => ({ environmentId: environmentId as EnvironmentId })),
    [registryEnvironmentKey],
  );
  const writable = useEnvironmentsWithScope(registryEnvironments, AuthSettingsWriteScope);
  const writableEnvironmentIds = useMemo(
    () =>
      registryEnvironments
        .map((environment) => environment.environmentId)
        .filter((environmentId) => writable.has(environmentId)),
    [registryEnvironments, writable],
  );
  const homeEnvironmentId = resolvePhaseSidebarCustomGroupHome(
    writableEnvironmentIds,
    preferredEnvironmentId,
  ) as EnvironmentId | null;

  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "custom group update",
    reportFailure: true,
  });
  const send = useCallback(
    (plan: PhaseSidebarCustomGroupWritePlan) => {
      for (const write of plan.writes) {
        void updateSettings({
          environmentId: write.environmentId as EnvironmentId,
          input: { patch: { threadCustomGroups: write.patch } },
        });
      }
      if (plan.skippedEnvironmentIds.length > 0) {
        Alert.alert(
          "Group not changed on every environment",
          "This connection cannot change settings on some environments that share this group.",
        );
      }
    },
    [updateSettings],
  );

  const createGroup = useCallback(
    (label: string) => {
      if (homeEnvironmentId === null) return null;
      const plan = planPhaseSidebarCustomGroupCreate({ registry, label, homeEnvironmentId });
      send(plan);
      return plan.id;
    },
    [homeEnvironmentId, registry, send],
  );
  const renameGroup = useCallback(
    (id: string, label: string) =>
      send(planPhaseSidebarCustomGroupRename({ registry, id, label, writableEnvironmentIds })),
    [registry, send, writableEnvironmentIds],
  );
  const deleteGroup = useCallback(
    (id: string) =>
      send(planPhaseSidebarCustomGroupDelete({ registry, id, writableEnvironmentIds })),
    [registry, send, writableEnvironmentIds],
  );
  const recolorGroup = useCallback(
    (id: string, label: string, colorId: string | null) =>
      send(
        planPhaseSidebarCustomGroupRecolor({
          registry,
          id,
          label,
          colorId,
          writableEnvironmentIds,
          homeEnvironmentId,
        }),
      ),
    [homeEnvironmentId, registry, send, writableEnvironmentIds],
  );

  return useMemo(
    () => ({ registry, homeEnvironmentId, createGroup, renameGroup, deleteGroup, recolorGroup }),
    [createGroup, deleteGroup, homeEnvironmentId, recolorGroup, registry, renameGroup],
  );
}
