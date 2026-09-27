// T3-CUSTOM(expbkt3): binds mobile state to the shared sidebar row model.
//
// All the derivation lives in client-runtime (`buildPhaseSidebarRows`), so this
// hook only gathers what mobile already holds — thread shells, projects, server
// configs, the viewer's identity and per-thread visit timestamps — and hands it
// over. Keeping it this thin is the point: the web sidebar and this one cannot
// drift, because they compute nothing themselves.
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, UserId } from "@t3tools/contracts";
import {
  buildPhaseSidebarRows,
  type PhaseSidebarPhaseId,
  type PhaseSidebarRow,
} from "@t3tools/client-runtime/state/phase-sidebar";
import { phaseSidebarLocalCustomGroupForThread } from "@t3tools/client-runtime/state/phase-sidebar-grouping";
import { operatorUserIdFromSessionState } from "@t3tools/client-runtime/state/session";
import { useMemo, useRef } from "react";

import { useProjects, useServerConfigs, useThreadShells } from "../../state/entities";
import { environmentSession } from "../../state/session";
import { usePhaseSidebarGrouping } from "./phaseSidebarGroupingStore";
import { resolveMobileUnread } from "./phaseSidebarPreferences";
import { usePhaseSidebarVisitTimestamps } from "./phaseSidebarVisitStore";

/**
 * The operator id for one environment, or null.
 *
 * BK mobile carries no Clerk key and never signs in, so identity always comes
 * from the environment session — the same derivation authorization uses.
 */
export function usePhaseSidebarViewerUserId(environmentId: EnvironmentId | null): UserId | null {
  // The atom family is keyed, so a stable placeholder key keeps the hook order
  // fixed when no environment is in focus rather than minting an atom a render.
  const sessionState = useAtomValue(
    environmentSession.sessionStateValueAtom(environmentId ?? EMPTY_ENVIRONMENT_ID),
  );
  if (environmentId === null) return null;
  return operatorUserIdFromSessionState(sessionState);
}

// Atom families are keyed, so a stable placeholder avoids creating a new atom
// per render when no environment is selected.
const EMPTY_ENVIRONMENT_ID = "__phase-sidebar-no-environment__" as EnvironmentId;

/**
 * Every sidebar row, across every connected environment.
 *
 * `viewerEnvironmentId` decides whose ownership facets ("mine", "assigned to
 * me") the rows carry. Mobile has no single primary environment, so the caller
 * passes the environment in focus. This mirrors the web sidebar's documented
 * rough edge: on a thread hosted by a different environment, ownership is
 * resolved against the focused environment's operator.
 */
export function usePhaseSidebarRows(input: {
  readonly viewerEnvironmentId: EnvironmentId | null;
}): ReadonlyArray<PhaseSidebarRow> {
  const threads = useThreadShells();
  const projects = useProjects();
  const serverConfigs = useServerConfigs();
  const visitTimestamps = usePhaseSidebarVisitTimestamps();
  const currentUserId = usePhaseSidebarViewerUserId(input.viewerEnvironmentId);
  // Custom groups live on the thread; this device's pre-label placements only
  // fill in for threads that have none yet.
  const grouping = usePhaseSidebarGrouping();
  // Mirrors the web sidebar: this component's own anti-flap memory, not state
  // the row model owns.
  const lastKnownPhaseByThreadKey = useRef(new Map<string, PhaseSidebarPhaseId>());

  return useMemo(
    () =>
      buildPhaseSidebarRows({
        threads,
        projects,
        serverConfigs,
        // Mobile does not aggregate per-thread VCS status yet; the rows simply
        // carry no change-request badge until it does. Everything else is
        // independent of it.
        vcsStatusByThreadKey: EMPTY_VCS_STATUS,
        lastVisitedAtByThreadKey: visitTimestamps,
        currentUserId,
        allEnvironmentShellsLive: true,
        lastKnownPhaseByThreadKey: lastKnownPhaseByThreadKey.current,
        localCustomGroupForKey: (threadKey) =>
          phaseSidebarLocalCustomGroupForThread(grouping, threadKey),
      }).map((row) => {
        // The phone's stricter read/unread rule; see resolveMobileUnread.
        const unread = resolveMobileUnread({
          sharedUnread: row.isUnreadCompletion,
          lastTurnCompletedAt: row.thread.latestTurn?.completedAt,
          lastVisitedAt: visitTimestamps[`${row.thread.environmentId}:${row.thread.id}`],
        });
        return unread === row.isUnreadCompletion ? row : { ...row, isUnreadCompletion: unread };
      }),
    [currentUserId, grouping, projects, serverConfigs, threads, visitTimestamps],
  );
}

const EMPTY_VCS_STATUS = new Map<string, null>();
