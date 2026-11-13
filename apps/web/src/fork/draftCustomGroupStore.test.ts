// T3-CUSTOM(expbkt3): the group a draft started from a group header's "+" lands in.
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  DRAFT_CUSTOM_GROUP_STORAGE_KEY,
  draftCustomGroupCreateFields,
  pruneDraftCustomGroupTargets,
  setDraftCustomGroupTarget,
  useDraftCustomGroupStore,
} from "./draftCustomGroupStore";

afterEach(() => {
  useDraftCustomGroupStore.setState({ targets: {} });
  useDraftCustomGroupStore.persist.clearStorage();
});

describe("draft custom group targets", () => {
  it("remembers, replaces and forgets a draft's group", () => {
    const one = setDraftCustomGroupTarget({}, "thread-1", "  Sprint 42 ");
    expect(one).toEqual({ "thread-1": "Sprint 42" });
    expect(setDraftCustomGroupTarget(one, "thread-1", "Sprint 42")).toBe(one);
    expect(setDraftCustomGroupTarget(one, "thread-1", "Bugs")).toEqual({ "thread-1": "Bugs" });
    // A plain New thread reusing the draft clears the choice.
    expect(setDraftCustomGroupTarget(one, "thread-1", null)).toEqual({});
    expect(setDraftCustomGroupTarget(one, "thread-2", null)).toBe(one);
    expect(setDraftCustomGroupTarget(one, "thread-1", "   ")).toEqual({});
  });

  it("forgets the group of a draft that was sent or discarded", () => {
    const targets = { "thread-1": "Bugs", "thread-2": "Leads" };
    expect(pruneDraftCustomGroupTargets(targets, new Set(["thread-1", "thread-2"]))).toBe(targets);
    expect(pruneDraftCustomGroupTargets(targets, new Set(["thread-2"]))).toEqual({
      "thread-2": "Leads",
    });
    expect(pruneDraftCustomGroupTargets(targets, new Set())).toEqual({});
  });

  it("names the group in the create input only for a draft that has one", () => {
    const targets = { "thread-1": "Bugs" };
    expect(draftCustomGroupCreateFields(targets, "thread-1")).toEqual({ customGroup: "Bugs" });
    expect(draftCustomGroupCreateFields(targets, "thread-2")).toEqual({});
    expect(draftCustomGroupCreateFields(targets, undefined)).toEqual({});
    expect(draftCustomGroupCreateFields(targets, null)).toEqual({});
  });

  it("keeps the choice across a reload", async () => {
    useDraftCustomGroupStore.getState().setTarget("thread-1", "Bugs");
    const storage = useDraftCustomGroupStore.persist.getOptions().storage!;
    const saved = (await storage.getItem(DRAFT_CUSTOM_GROUP_STORAGE_KEY)) as {
      readonly state: { readonly targets?: unknown };
    } | null;
    expect(saved?.state.targets).toEqual({ "thread-1": "Bugs" });
    await useDraftCustomGroupStore.persist.rehydrate();
    expect(useDraftCustomGroupStore.getState().targets).toEqual({ "thread-1": "Bugs" });
  });
});
