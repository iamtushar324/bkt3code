// T3-CUSTOM(expbkt3): shared host appearance across all connection modes.
import {
  environmentAppearanceFromSettings,
  resolveEnvironmentAppearance,
  type ResolvedEnvironmentAppearance,
} from "./environmentAppearance";
import { localEnvironmentAppearanceDefaults } from "../fork/localEnvironmentAppearance";
import { useAtomValue } from "@effect/atom-react";
import {
  connectionCatalogDisplayUrl,
  hasRelayRoute,
  type EnvironmentPresentation as BaseEnvironmentPresentation,
} from "@t3tools/client-runtime/connection";
import { Discovery } from "@t3tools/client-runtime/relay";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { useMemo } from "react";

import { environmentCatalog } from "../connection/catalog";
import {
  environmentPresentations,
  environmentSummaries,
  useEnvironmentPresentation,
} from "./presentation";
import { primaryEnvironmentIdAtom } from "./primaryEnvironment";
// T3-CUSTOM(expbkt3): retained for useEnvironmentConnectionState below.
import { useEnvironmentQuery } from "./query";
import { relayEnvironmentDiscovery } from "./relay";
import { usePreparedConnection } from "./session";

// T3-CUSTOM(expbkt3): BEGIN — resolved appearance travels with every environment view.
export interface EnvironmentPresentation extends BaseEnvironmentPresentation {
  readonly environmentId: EnvironmentId;
  /** The host's shared nickname when it has one, else the connection label. */
  readonly label: string;
  /** The connection's own label, as saved on this device. */
  readonly connectionLabel: string;
  readonly appearance: ResolvedEnvironmentAppearance;
  readonly displayUrl: string | null;
  readonly relayManaged: boolean;
}
// T3-CUSTOM(expbkt3): END

// T3-CUSTOM(expbkt3): BEGIN — resolve environment identity into presentations.
function projectEnvironmentPresentation(
  environmentId: EnvironmentId,
  presentation: BaseEnvironmentPresentation,
): EnvironmentPresentation {
  const appearance = resolveEnvironmentAppearance({
    environmentId,
    label: presentation.entry.target.label,
    appearance: environmentAppearanceFromSettings(presentation.serverConfig?.settings),
    defaults: localEnvironmentAppearanceDefaults(presentation.entry.target),
  });
  return {
    ...presentation,
    environmentId,
    label: appearance.name,
    connectionLabel: presentation.entry.target.label,
    appearance,
    displayUrl: connectionCatalogDisplayUrl(presentation.entry),
    relayManaged: hasRelayRoute(presentation.entry),
  };
}
// T3-CUSTOM(expbkt3): END

export function useEnvironments() {
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const networkStatus = useAtomValue(environmentCatalog.networkStatusValueAtom);
  const presentationById = useAtomValue(environmentPresentations.presentationsAtom);

  const environments = useMemo(
    () =>
      [...presentationById.entries()].map(([environmentId, presentation]) =>
        projectEnvironmentPresentation(environmentId, presentation),
      ),
    [presentationById],
  );

  return {
    isReady: catalog.isReady,
    networkStatus,
    environments,
    presentationById,
  };
}

export function usePrimaryEnvironmentId(): EnvironmentId | null {
  return useAtomValue(primaryEnvironmentIdAtom);
}

export function useEnvironment(
  environmentId: EnvironmentId | null,
): EnvironmentPresentation | null {
  const { presentation } = useEnvironmentPresentation(environmentId);
  return useMemo(
    () =>
      environmentId === null || presentation === null
        ? null
        : projectEnvironmentPresentation(environmentId, presentation),
    [environmentId, presentation],
  );
}

export function usePrimaryEnvironment(): EnvironmentPresentation | null {
  return useEnvironment(usePrimaryEnvironmentId());
}

export function useEnvironmentHttpBaseUrl(environmentId: EnvironmentId | null): string | null {
  const prepared = usePreparedConnection(environmentId);
  return Option.isSome(prepared) ? prepared.value.httpBaseUrl : null;
}

export function useRelayEnvironmentDiscovery(): Discovery.RelayEnvironmentDiscoveryState {
  return useAtomValue(relayEnvironmentDiscovery.stateValueAtom);
}

export function useEnvironmentIds() {
  return useAtomValue(environmentSummaries.environmentIdsAtom);
}

export function useEnvironmentIdentities() {
  return useAtomValue(environmentSummaries.identitiesAtom);
}

export function usePullRequestsSupported() {
  return useAtomValue(environmentSummaries.pullRequestsSupportedAtom);
}

export function useEnvironmentMachines() {
  return useAtomValue(environmentSummaries.machineByIdAtom);
}

export function useConnectedEnvironmentIds() {
  return useAtomValue(environmentSummaries.connectedEnvironmentIdsAtom);
}

// T3-CUSTOM(expbkt3): upstream removed this as unused (#10225); the fork's
// thread context actions control still reads per-environment connection state.
export function useEnvironmentConnectionState(environmentId: EnvironmentId) {
  return useEnvironmentQuery(environmentCatalog.stateAtom(environmentId));
}
// T3-CUSTOM(expbkt3): BEGIN — per-environment identity for multi-environment clients.

/**
 * The nickname, icon and colour for one environment: the host's shared
 * override, else derived from the environment id so every environment is
 * distinguishable without any configuration.
 */
export function useEnvironmentAppearance(
  environmentId: EnvironmentId | null,
): ResolvedEnvironmentAppearance | null {
  const environment = useEnvironment(environmentId);
  return environment?.appearance ?? null;
}

/**
 * Appearance for every known environment, keyed by id. For lists that render rows
 * from several environments and would otherwise call the single hook in a loop.
 */
export function useEnvironmentAppearances(): ReadonlyMap<string, ResolvedEnvironmentAppearance> {
  const { environments } = useEnvironments();
  return useMemo(
    () =>
      new Map(
        environments.map((environment) => [environment.environmentId, environment.appearance]),
      ),
    [environments],
  );
}

/**
 * Whether this client knows about more than one environment at all.
 *
 * Surfaces that always show everything (settings lists) use this. Surfaces that
 * show a filtered set — the sidebar above all — must instead ask whether *the rows
 * they are about to render* span more than one environment, because a second
 * environment with nothing in view is not a reason to add a column of badges to
 * every row. See `hasMultipleEnvironments` for that case.
 */
export function useHasMultipleEnvironments(): boolean {
  const { environments } = useEnvironments();
  return environments.length > 1;
}

/** True when the supplied rows come from more than one environment. */
export function hasMultipleEnvironments(
  rows: ReadonlyArray<{ readonly environmentId: EnvironmentId }>,
): boolean {
  if (rows.length < 2) return false;
  const first = rows[0]?.environmentId;
  return rows.some((row) => row.environmentId !== first);
}
// T3-CUSTOM(expbkt3): END
