// T3-CUSTOM(expbkt3): the shared custom-group registry merges per entry (XFN-59).
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { applyServerSettingsPatch } from "./serverSettings.ts";
import { mergeThreadCustomGroupRegistry } from "./threadCustomGroupRegistry.expbkt3.ts";

describe("threadCustomGroups server setting", () => {
  it("starts empty", () => {
    expect(DEFAULT_SERVER_SETTINGS.threadCustomGroups).toEqual({});
  });

  it("upserts one group without replacing the others", () => {
    const first = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      threadCustomGroups: { "sprint 42": { label: "Sprint 42", colorId: "blue" } },
    });
    const second = applyServerSettingsPatch(first, {
      threadCustomGroups: { backlog: { label: "Backlog" } },
    });
    expect(second.threadCustomGroups).toEqual({
      "sprint 42": { label: "Sprint 42", colorId: "blue" },
      backlog: { label: "Backlog" },
    });
  });

  it("replaces an entry whole, so a definition without a colour clears it", () => {
    const coloured = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      threadCustomGroups: { backlog: { label: "Backlog", colorId: "red" } },
    });
    const recoloured = applyServerSettingsPatch(coloured, {
      threadCustomGroups: { backlog: { label: "Backlog", colorId: "teal" } },
    });
    expect(recoloured.threadCustomGroups).toEqual({
      backlog: { label: "Backlog", colorId: "teal" },
    });
    const cleared = applyServerSettingsPatch(recoloured, {
      threadCustomGroups: { backlog: { label: "Backlog" } },
    });
    expect(cleared.threadCustomGroups).toEqual({ backlog: { label: "Backlog" } });
  });

  it("drops a group named like the built-in Ungrouped section", () => {
    const saved = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      threadCustomGroups: {
        ungrouped: { label: "Ungrouped", colorId: "red" },
        backlog: { label: "Backlog" },
      },
    });
    expect(saved.threadCustomGroups).toEqual({ backlog: { label: "Backlog" } });
    expect(mergeThreadCustomGroupRegistry({ x: { label: " UNGROUPED " } }, {})).toEqual({});
  });

  it("removes a group with null and leaves the rest", () => {
    const both = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      threadCustomGroups: {
        backlog: { label: "Backlog" },
        "sprint 42": { label: "Sprint 42" },
      },
    });
    const removed = applyServerSettingsPatch(both, {
      threadCustomGroups: { backlog: null },
    });
    expect(removed.threadCustomGroups).toEqual({ "sprint 42": { label: "Sprint 42" } });
  });

  it("re-keys every entry by its normalized label, whatever key the client sent", () => {
    const saved = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      threadCustomGroups: { "Sprint  42": { label: "Sprint  42" } },
    });
    expect(saved.threadCustomGroups).toEqual({ "sprint 42": { label: "Sprint  42" } });
    // A different spelling of the same group replaces it instead of duplicating it.
    const respelled = applyServerSettingsPatch(saved, {
      threadCustomGroups: { anything: { label: "SPRINT 42", colorId: "lime" } },
    });
    expect(respelled.threadCustomGroups).toEqual({
      "sprint 42": { label: "SPRINT 42", colorId: "lime" },
    });
  });

  it("normalizes the key of a null removal", () => {
    const saved = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      threadCustomGroups: { "sprint 42": { label: "Sprint 42" } },
    });
    const removed = applyServerSettingsPatch(saved, {
      threadCustomGroups: { "  SPRINT   42 ": null },
    });
    expect(removed.threadCustomGroups).toEqual({});
  });

  it("renames with a removal of the old key and a definition for the new one", () => {
    const saved = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      threadCustomGroups: { "sprint 42": { label: "Sprint 42", colorId: "violet" } },
    });
    const renamed = applyServerSettingsPatch(saved, {
      threadCustomGroups: {
        "sprint 42": null,
        "sprint 43": { label: "Sprint 43", colorId: "violet" },
      },
    });
    expect(renamed.threadCustomGroups).toEqual({
      "sprint 43": { label: "Sprint 43", colorId: "violet" },
    });
  });

  it("leaves the registry alone when a patch does not mention it", () => {
    const saved = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      threadCustomGroups: { backlog: { label: "Backlog", colorId: "amber" } },
    });
    const unrelated = applyServerSettingsPatch(saved, { defaultAutoPull: true });
    expect(unrelated.threadCustomGroups).toEqual({
      backlog: { label: "Backlog", colorId: "amber" },
    });
  });

  it("collapses a stored duplicate whose key is not its normalized label", () => {
    expect(
      mergeThreadCustomGroupRegistry(
        { "Sprint 42": { label: "Sprint 42", colorId: "red" } },
        { backlog: { label: "Backlog" } },
      ),
    ).toEqual({
      "sprint 42": { label: "Sprint 42", colorId: "red" },
      backlog: { label: "Backlog" },
    });
  });
});
