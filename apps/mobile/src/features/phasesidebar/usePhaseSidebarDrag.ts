// T3-CUSTOM(expbkt3): the drag interaction for reordering and re-parenting rows.
//
// Long-press to lift, then pan. That two-stage gesture is deliberate: a pan that
// activates immediately fights the list's own scroll, which is the most common
// way touch drag-and-drop feels broken.
//
// Row geometry is collected by onLayout rather than measured on drop: measuring
// mid-gesture costs a round trip to the native side per frame.
import type { PhaseSidebarRow } from "@t3tools/client-runtime/state/phase-sidebar";
import { useCallback, useMemo, useRef, useState } from "react";

import {
  describePhaseSidebarDropRejection,
  validateReorder,
  validateReparent,
  type PhaseSidebarDropVerdict,
} from "./phaseSidebarDrag";

/** Where a row sits in the list, in list-content coordinates. */
export interface PhaseSidebarRowGeometry {
  readonly y: number;
  readonly height: number;
  readonly depth: number;
}

export type PhaseSidebarDragIntent =
  | { readonly kind: "reparent"; readonly targetKey: string | null }
  | { readonly kind: "reorder"; readonly targetKey: string };

export interface PhaseSidebarDragState {
  readonly subjectKey: string;
  readonly intent: PhaseSidebarDragIntent;
  readonly verdict: PhaseSidebarDropVerdict;
  /** Null while the drop is allowed; wording for the overlay otherwise. */
  readonly rejectionLabel: string | null;
}

/**
 * How much of a row's height counts as its "edges".
 *
 * A drop in the middle band re-parents; the top and bottom bands reorder. A
 * third each keeps both operations reachable with a thumb — narrower edges are
 * unhittable while scrolling settles.
 */
const EDGE_BAND = 1 / 3;

export function resolveDragIntent(input: {
  readonly pointerY: number;
  readonly rows: ReadonlyArray<{
    readonly key: string;
    readonly geometry: PhaseSidebarRowGeometry;
  }>;
}): PhaseSidebarDragIntent {
  for (const entry of input.rows) {
    const { y, height } = entry.geometry;
    if (input.pointerY < y || input.pointerY > y + height) continue;
    const offset = (input.pointerY - y) / Math.max(height, 1);
    if (offset <= EDGE_BAND || offset >= 1 - EDGE_BAND) {
      return { kind: "reorder", targetKey: entry.key };
    }
    return { kind: "reparent", targetKey: entry.key };
  }
  // Past the last row: drop to root.
  return { kind: "reparent", targetKey: null };
}

export interface PhaseSidebarDragController {
  readonly drag: PhaseSidebarDragState | null;
  readonly registerGeometry: (key: string, geometry: PhaseSidebarRowGeometry) => void;
  readonly beginDrag: (subjectKey: string) => void;
  readonly updateDrag: (pointerY: number) => void;
  /** Commits an allowed drop; a refused one is discarded. */
  readonly endDrag: () => void;
  readonly cancelDrag: () => void;
}

export function usePhaseSidebarDrag(input: {
  readonly rows: ReadonlyArray<PhaseSidebarRow>;
  readonly rowKeyFor: (row: PhaseSidebarRow) => string;
  readonly onReparent: (subject: PhaseSidebarRow, parent: PhaseSidebarRow | null) => void;
  readonly onReorder: (subject: PhaseSidebarRow, before: PhaseSidebarRow) => void;
}): PhaseSidebarDragController {
  const geometry = useRef(new Map<string, PhaseSidebarRowGeometry>());
  const [drag, setDrag] = useState<PhaseSidebarDragState | null>(null);
  const { rows, rowKeyFor, onReparent, onReorder } = input;

  const rowsByKey = useMemo(() => {
    const map = new Map<string, PhaseSidebarRow>();
    for (const row of rows) map.set(rowKeyFor(row), row);
    return map;
  }, [rowKeyFor, rows]);

  const registerGeometry = useCallback((key: string, next: PhaseSidebarRowGeometry) => {
    geometry.current.set(key, next);
  }, []);

  const beginDrag = useCallback((subjectKey: string) => {
    // Lifted but not yet over a valid target: the row is its own target, which
    // is refused, so nothing commits if the finger lifts without moving.
    setDrag({
      subjectKey,
      intent: { kind: "reparent", targetKey: subjectKey },
      verdict: { allowed: false, reason: "same-thread" },
      rejectionLabel: null,
    });
  }, []);

  const updateDrag = useCallback(
    (pointerY: number) => {
      setDrag((current) => {
        if (current === null) return null;
        const subject = rowsByKey.get(current.subjectKey);
        if (subject === undefined) return current;

        const ordered = [...geometry.current.entries()]
          .map(([key, value]) => ({ key, geometry: value }))
          .sort((left, right) => left.geometry.y - right.geometry.y);
        const intent = resolveDragIntent({ pointerY, rows: ordered });

        const targetKey = intent.targetKey;
        const target = targetKey === null ? null : (rowsByKey.get(targetKey) ?? null);
        const verdict =
          intent.kind === "reparent"
            ? validateReparent({
                subject,
                target,
                allRows: rows,
                targetDepth: targetKey === null ? 0 : (geometry.current.get(targetKey)?.depth ?? 0),
              })
            : validateReorder({ subject, target });

        return {
          subjectKey: current.subjectKey,
          intent,
          verdict,
          rejectionLabel: verdict.allowed
            ? null
            : describePhaseSidebarDropRejection(verdict.reason),
        };
      });
    },
    [rows, rowsByKey],
  );

  const endDrag = useCallback(() => {
    setDrag((current) => {
      if (current === null || !current.verdict.allowed) return null;
      const subject = rowsByKey.get(current.subjectKey);
      if (subject === undefined) return null;

      if (current.intent.kind === "reparent") {
        const parentKey = current.intent.targetKey;
        onReparent(subject, parentKey === null ? null : (rowsByKey.get(parentKey) ?? null));
      } else {
        const before = rowsByKey.get(current.intent.targetKey);
        if (before !== undefined) onReorder(subject, before);
      }
      return null;
    });
  }, [onReorder, onReparent, rowsByKey]);

  const cancelDrag = useCallback(() => setDrag(null), []);

  return { drag, registerGeometry, beginDrag, updateDrag, endDrag, cancelDrag };
}
