// T3-CUSTOM(expbkt3): the shared custom-group registry on web (XFN-59).
//
// Reads every connected host's `threadCustomGroups` server setting into one
// registry and sends the settings patches that client-runtime plans. A new
// group goes to the primary environment (or the first host this session may
// write); a rename, recolour or delete goes to every host whose registry
// holds the group. Hosts too old to keep the registry, or that this session
// may not write, are left out: the sidebar then keeps its device-local
// placeholder groups, as before. Relabelling the sessions themselves stays
// with the caller, which already does it per thread.
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

import { serverEnvironment } from "../../state/server";
import { useEnvironmentsWithScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { toastManager } from "../ui/toast";

export interface PhaseSidebarCustomGroupRegistryControls {
  /** Every connected host's groups, merged; the primary environment wins a conflict. */
  readonly registry: PhaseSidebarCustomGroupRegistry;
  /**
   * The host a new group is written to. Null when no connected host keeps the
   * registry for this session: groups are then device-local placeholders.
   */
  readonly homeEnvironmentId: EnvironmentId | null;
  /**
   * Registers a group on the home host. Returns its id when the registry holds
   * it or now receives it; null when the caller must fall back to a
   * device-local placeholder.
   */
  readonly createGroup: (label: string) => string | null;
  /** The registry half of a rename; the caller relabels the sessions. */
  readonly renameGroup: (id: string, label: string) => void;
  /** The registry half of a delete; the caller ungroups the sessions. */
  readonly deleteGroup: (id: string) => void;
  /** `colorId` null restores the default look. */
  readonly recolorGroup: (id: string, label: string, colorId: string | null) => void;
}

export function usePhaseSidebarCustomGroupRegistry(input: {
  readonly serverConfigs: ReadonlyMap<EnvironmentId, ServerConfig>;
  readonly primaryEnvironmentId: EnvironmentId | null;
}): PhaseSidebarCustomGroupRegistryControls {
  const { serverConfigs, primaryEnvironmentId } = input;
  const registry = useMemo(
    () => buildPhaseSidebarCustomGroupRegistry(serverConfigs, primaryEnvironmentId),
    [primaryEnvironmentId, serverConfigs],
  );
  // Keyed by the id list, not the config map, so a settings update on any host
  // does not resubscribe every grant.
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
    primaryEnvironmentId,
  ) as EnvironmentId | null;

  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, "custom group update");
  const send = useCallback(
    (plan: PhaseSidebarCustomGroupWritePlan) => {
      for (const write of plan.writes) {
        void updateSettings({
          environmentId: write.environmentId as EnvironmentId,
          input: { patch: { threadCustomGroups: write.patch } },
        });
      }
      if (plan.skippedEnvironmentIds.length > 0) {
        toastManager.add({
          type: "warning",
          title: "Group not changed on every environment",
          description:
            "This connection cannot change settings on some environments that share this group.",
        });
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
