// T3-CUSTOM(expbkt3): collapsed groups and shelves stay collapsed — across a
// remount and across tabs or windows writing the same blob.
import {
  DEFAULT_PHASE_SIDEBAR_GROUPING,
  isPhaseSidebarSectionCollapsed,
  PHASE_SIDEBAR_SHELF_SECTIONS,
  phaseSidebarSectionKey,
  type PhaseSidebarGroupingPreferences,
} from "@t3tools/client-runtime/state/phase-sidebar-grouping";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import {
  PHASE_SIDEBAR_GROUPING_STORAGE_KEY,
  syncPhaseSidebarGroupingFromStorageEvent,
  usePhaseSidebarGroupingStore,
} from "./phaseSidebarGroupingStore";

const store = () => usePhaseSidebarGroupingStore.getState();
const collapsedKeys = () => new Set(store().grouping.collapsedSectionKeys);
const storage = () => usePhaseSidebarGroupingStore.persist.getOptions().storage!;

async function readStoredGrouping(): Promise<PhaseSidebarGroupingPreferences | undefined> {
  const saved = await storage().getItem(PHASE_SIDEBAR_GROUPING_STORAGE_KEY);
  return saved?.state.grouping;
}

/** What another tab does: write the whole blob straight to storage. */
async function writeFromAnotherTab(grouping: PhaseSidebarGroupingPreferences) {
  await storage().setItem(PHASE_SIDEBAR_GROUPING_STORAGE_KEY, {
    state: { grouping },
    version: 1,
  });
}

const readyKey = phaseSidebarSectionKey("lifecycle", "ready");
const implementingKey = phaseSidebarSectionKey("lifecycle", "implementing");

beforeEach(() => {
  usePhaseSidebarGroupingStore.setState({ grouping: DEFAULT_PHASE_SIDEBAR_GROUPING });
});
afterEach(() => {
  usePhaseSidebarGroupingStore.persist.clearStorage();
});

describe("phase sidebar grouping store", () => {
  it("keeps both parked shelves collapsed until the user opens one", () => {
    expect(
      isPhaseSidebarSectionCollapsed(PHASE_SIDEBAR_SHELF_SECTIONS.snoozed, collapsedKeys()),
    ).toBe(true);
    expect(
      isPhaseSidebarSectionCollapsed(PHASE_SIDEBAR_SHELF_SECTIONS.settled, collapsedKeys()),
    ).toBe(true);
  });

  it("restores a shelf's collapse state after a remount", async () => {
    store().toggleSectionCollapsed(PHASE_SIDEBAR_SHELF_SECTIONS.settled.key);
    expect(await readStoredGrouping()).toMatchObject({
      collapsedSectionKeys: [PHASE_SIDEBAR_SHELF_SECTIONS.settled.key],
    });

    // A remount starts from the stored blob, never from component state.
    await usePhaseSidebarGroupingStore.persist.rehydrate();
    expect(
      isPhaseSidebarSectionCollapsed(PHASE_SIDEBAR_SHELF_SECTIONS.settled, collapsedKeys()),
    ).toBe(false);

    store().toggleSectionCollapsed(PHASE_SIDEBAR_SHELF_SECTIONS.settled.key);
    await usePhaseSidebarGroupingStore.persist.rehydrate();
    expect(
      isPhaseSidebarSectionCollapsed(PHASE_SIDEBAR_SHELF_SECTIONS.settled, collapsedKeys()),
    ).toBe(true);
  });

  it("adopts a collapse made in another tab", async () => {
    await writeFromAnotherTab({
      ...DEFAULT_PHASE_SIDEBAR_GROUPING,
      collapsedSectionKeys: [readyKey],
    });
    expect(collapsedKeys().has(readyKey)).toBe(false);

    expect(
      syncPhaseSidebarGroupingFromStorageEvent({ key: PHASE_SIDEBAR_GROUPING_STORAGE_KEY }),
    ).toBe(true);

    expect(collapsedKeys().has(readyKey)).toBe(true);
  });

  it("does not undo another tab's collapse with its next write", async () => {
    await writeFromAnotherTab({
      ...DEFAULT_PHASE_SIDEBAR_GROUPING,
      collapsedSectionKeys: [readyKey],
    });
    syncPhaseSidebarGroupingFromStorageEvent({ key: PHASE_SIDEBAR_GROUPING_STORAGE_KEY });

    // This tab's own write now carries the other tab's collapse with it.
    store().toggleSectionCollapsed(implementingKey);

    expect((await readStoredGrouping())?.collapsedSectionKeys).toEqual([readyKey, implementingKey]);
  });

  it("ignores storage events for other keys", async () => {
    await writeFromAnotherTab({
      ...DEFAULT_PHASE_SIDEBAR_GROUPING,
      collapsedSectionKeys: [readyKey],
    });

    expect(syncPhaseSidebarGroupingFromStorageEvent({ key: "t3code:something-else" })).toBe(false);

    expect(collapsedKeys().has(readyKey)).toBe(false);
  });
});
