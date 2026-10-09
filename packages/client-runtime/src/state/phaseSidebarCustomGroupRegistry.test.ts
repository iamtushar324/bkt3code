// T3-CUSTOM(expbkt3): coverage for the shared custom-group registry (XFN-59):
// merging hosts' registries, colours, and the settings patches each change sends.
import { THREAD_CUSTOM_GROUP_COLOR_IDS, type ThreadCustomGroupRegistry } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildPhaseSidebarCustomGroupRegistry,
  EMPTY_PHASE_SIDEBAR_CUSTOM_GROUP_REGISTRY,
  PHASE_SIDEBAR_CUSTOM_GROUP_COLOR_OPTIONS,
  phaseSidebarCustomGroupColorValue,
  phaseSidebarCustomGroupDefinition,
  phaseSidebarCustomGroupRegistryEnvironmentIds,
  phaseSidebarCustomGroupRegistrySupported,
  planPhaseSidebarCustomGroupCreate,
  planPhaseSidebarCustomGroupDelete,
  planPhaseSidebarCustomGroupRecolor,
  planPhaseSidebarCustomGroupRename,
  resolvePhaseSidebarCustomGroupHome,
  type PhaseSidebarCustomGroupRegistryConfig,
} from "./phaseSidebarCustomGroupRegistry.ts";

function config(
  threadCustomGroups: ThreadCustomGroupRegistry | undefined,
  supported = true,
): PhaseSidebarCustomGroupRegistryConfig {
  return {
    environment: { capabilities: supported ? { threadCustomGroupRegistry: true } : {} },
    settings: threadCustomGroups === undefined ? {} : { threadCustomGroups },
  };
}

const configs = (
  entries: ReadonlyArray<readonly [string, PhaseSidebarCustomGroupRegistryConfig | null]>,
) => new Map(entries);

describe("custom group colours", () => {
  it("offers every contract colour, with the environment badge's hex value", () => {
    expect(PHASE_SIDEBAR_CUSTOM_GROUP_COLOR_OPTIONS.map((option) => option.id)).toEqual([
      ...THREAD_CUSTOM_GROUP_COLOR_IDS,
    ]);
    expect(phaseSidebarCustomGroupColorValue("blue")).toBe("#3b82f6");
    expect(phaseSidebarCustomGroupColorValue("slate")).toBe("#94a3b8");
  });

  it("reads no colour, and an id from a newer client, as the default look", () => {
    expect(phaseSidebarCustomGroupColorValue(null)).toBeNull();
    expect(phaseSidebarCustomGroupColorValue(undefined)).toBeNull();
    expect(phaseSidebarCustomGroupColorValue("ultraviolet")).toBeNull();
  });

  it("drops an unknown colour from a definition", () => {
    expect(phaseSidebarCustomGroupDefinition("Bugs", "teal")).toEqual({
      label: "Bugs",
      colorId: "teal",
    });
    expect(phaseSidebarCustomGroupDefinition("Bugs", "ultraviolet")).toEqual({ label: "Bugs" });
    expect(phaseSidebarCustomGroupDefinition("Bugs", null)).toEqual({ label: "Bugs" });
  });
});

describe("buildPhaseSidebarCustomGroupRegistry", () => {
  it("is empty when no host keeps the registry", () => {
    const registry = buildPhaseSidebarCustomGroupRegistry(
      configs([
        ["old", config({ bugs: { label: "Bugs" } }, false)],
        ["offline", null],
      ]),
      "old",
    );
    expect(registry).toBe(EMPTY_PHASE_SIDEBAR_CUSTOM_GROUP_REGISTRY);
    expect(phaseSidebarCustomGroupRegistrySupported(config({}, false))).toBe(false);
    expect(phaseSidebarCustomGroupRegistrySupported(null)).toBe(false);
  });

  it("lists only the hosts that keep the registry", () => {
    expect(
      phaseSidebarCustomGroupRegistryEnvironmentIds(
        configs([
          ["a", config({})],
          ["old", config({}, false)],
          ["offline", null],
          ["b", config(undefined)],
        ]),
      ),
    ).toEqual(["a", "b"]);
  });

  it("merges hosts and lets the preferred host win a conflict, label and colour", () => {
    const registry = buildPhaseSidebarCustomGroupRegistry(
      configs([
        [
          "remote",
          config({
            "sprint 42": { label: "sprint 42", colorId: "red" },
            ops: { label: "Ops" },
          }),
        ],
        ["primary", config({ "sprint 42": { label: "Sprint 42" } })],
      ]),
      "primary",
    );
    expect(registry.get("sprint 42")).toEqual({
      id: "sprint 42",
      label: "Sprint 42",
      colorId: null,
      color: null,
      environmentIds: ["primary", "remote"],
    });
    expect(registry.get("ops")).toEqual({
      id: "ops",
      label: "Ops",
      colorId: null,
      color: null,
      environmentIds: ["remote"],
    });
  });

  it("falls back to map order without a preferred host, and keeps colours", () => {
    const registry = buildPhaseSidebarCustomGroupRegistry(
      configs([
        ["first", config({ bugs: { label: "Bugs", colorId: "teal" } })],
        ["second", config({ bugs: { label: "BUGS", colorId: "red" } })],
      ]),
      null,
    );
    expect(registry.get("bugs")).toMatchObject({
      label: "Bugs",
      colorId: "teal",
      color: "#14b8a6",
      environmentIds: ["first", "second"],
    });
  });

  it("re-keys by label and skips blank and reserved labels", () => {
    const registry = buildPhaseSidebarCustomGroupRegistry(
      configs([
        [
          "host",
          config({
            "wrong key": { label: "  Release   Train " },
            blank: { label: "   " },
            ungrouped: { label: "Ungrouped" },
          }),
        ],
      ]),
      "host",
    );
    expect([...registry.keys()]).toEqual(["release train"]);
    expect(registry.get("release train")?.label).toBe("Release Train");
  });
});

describe("planning custom group writes", () => {
  const registry = buildPhaseSidebarCustomGroupRegistry(
    configs([
      ["primary", config({ bugs: { label: "Bugs", colorId: "red" }, ops: { label: "Ops" } })],
      ["remote", config({ bugs: { label: "Bugs" }, docs: { label: "Docs", colorId: "lime" } })],
    ]),
    "primary",
  );

  it("picks the preferred host when writable, else the first writable one", () => {
    expect(resolvePhaseSidebarCustomGroupHome(["remote", "primary"], "primary")).toBe("primary");
    expect(resolvePhaseSidebarCustomGroupHome(["remote"], "primary")).toBe("remote");
    expect(resolvePhaseSidebarCustomGroupHome([], "primary")).toBeNull();
    expect(resolvePhaseSidebarCustomGroupHome(["remote"], null)).toBe("remote");
  });

  it("creates a new group on the home host only", () => {
    expect(
      planPhaseSidebarCustomGroupCreate({
        registry,
        label: "  New   Work ",
        homeEnvironmentId: "primary",
      }),
    ).toEqual({
      id: "new work",
      writes: [{ environmentId: "primary", patch: { "new work": { label: "New Work" } } }],
      skippedEnvironmentIds: [],
    });
    expect(
      planPhaseSidebarCustomGroupCreate({
        registry,
        label: "Teal one",
        colorId: "teal",
        homeEnvironmentId: "remote",
      }).writes,
    ).toEqual([
      { environmentId: "remote", patch: { "teal one": { label: "Teal one", colorId: "teal" } } },
    ]);
  });

  it("writes nothing for an existing group, a blank or reserved name, or no home", () => {
    expect(
      planPhaseSidebarCustomGroupCreate({ registry, label: "BUGS", homeEnvironmentId: "primary" }),
    ).toEqual({ id: "bugs", writes: [], skippedEnvironmentIds: [] });
    expect(
      planPhaseSidebarCustomGroupCreate({ registry, label: "  ", homeEnvironmentId: "primary" }).id,
    ).toBeNull();
    expect(
      planPhaseSidebarCustomGroupCreate({
        registry,
        label: "ungrouped",
        homeEnvironmentId: "primary",
      }).id,
    ).toBeNull();
    expect(
      planPhaseSidebarCustomGroupCreate({ registry, label: "Fresh", homeEnvironmentId: null }),
    ).toEqual({ id: "fresh", writes: [], skippedEnvironmentIds: [] });
  });

  it("recolours a group on every host that holds it", () => {
    expect(
      planPhaseSidebarCustomGroupRecolor({
        registry,
        id: "bugs",
        label: "Bugs",
        colorId: "violet",
        writableEnvironmentIds: ["primary", "remote"],
        homeEnvironmentId: "primary",
      }),
    ).toEqual({
      writes: [
        { environmentId: "primary", patch: { bugs: { label: "Bugs", colorId: "violet" } } },
        { environmentId: "remote", patch: { bugs: { label: "Bugs", colorId: "violet" } } },
      ],
      skippedEnvironmentIds: [],
    });
  });

  it("clears a colour by writing the definition without one", () => {
    expect(
      planPhaseSidebarCustomGroupRecolor({
        registry,
        id: "docs",
        label: "Docs",
        colorId: null,
        writableEnvironmentIds: ["primary", "remote"],
        homeEnvironmentId: "primary",
      }).writes,
    ).toEqual([{ environmentId: "remote", patch: { docs: { label: "Docs" } } }]);
  });

  it("registers a thread-only group on the home host when it is recoloured", () => {
    expect(
      planPhaseSidebarCustomGroupRecolor({
        registry,
        id: "agent work",
        label: "Agent Work",
        colorId: "amber",
        writableEnvironmentIds: ["primary"],
        homeEnvironmentId: "primary",
      }).writes,
    ).toEqual([
      {
        environmentId: "primary",
        patch: { "agent work": { label: "Agent Work", colorId: "amber" } },
      },
    ]);
  });

  it("reports the hosts it may not write", () => {
    expect(
      planPhaseSidebarCustomGroupDelete({
        registry,
        id: "bugs",
        writableEnvironmentIds: ["primary"],
      }),
    ).toEqual({
      writes: [{ environmentId: "primary", patch: { bugs: null } }],
      skippedEnvironmentIds: ["remote"],
    });
    expect(
      planPhaseSidebarCustomGroupDelete({
        registry,
        id: "only on threads",
        writableEnvironmentIds: ["primary"],
      }),
    ).toEqual({ writes: [], skippedEnvironmentIds: [] });
  });

  it("renames by removing the old key and writing the new one, keeping the colour", () => {
    expect(
      planPhaseSidebarCustomGroupRename({
        registry,
        id: "bugs",
        label: "Defects",
        writableEnvironmentIds: ["primary", "remote"],
      }),
    ).toEqual({
      nextId: "defects",
      writes: [
        {
          environmentId: "primary",
          patch: { bugs: null, defects: { label: "Defects", colorId: "red" } },
        },
        {
          environmentId: "remote",
          patch: { bugs: null, defects: { label: "Defects", colorId: "red" } },
        },
      ],
      skippedEnvironmentIds: [],
    });
  });

  it("rewrites in place when only the spelling changes", () => {
    expect(
      planPhaseSidebarCustomGroupRename({
        registry,
        id: "ops",
        label: "OPS",
        writableEnvironmentIds: ["primary"],
      }).writes,
    ).toEqual([{ environmentId: "primary", patch: { ops: { label: "OPS" } } }]);
  });

  it("keeps the target's colour when a rename merges into an existing group", () => {
    expect(
      planPhaseSidebarCustomGroupRename({
        registry,
        id: "bugs",
        label: "docs",
        writableEnvironmentIds: ["primary", "remote"],
      }).writes[0]?.patch,
    ).toEqual({ bugs: null, docs: { label: "docs", colorId: "lime" } });
  });

  it("leaves a thread-only group's rename to the session relabel", () => {
    expect(
      planPhaseSidebarCustomGroupRename({
        registry,
        id: "agent work",
        label: "Agents",
        writableEnvironmentIds: ["primary"],
      }),
    ).toEqual({ nextId: "agents", writes: [], skippedEnvironmentIds: [] });
  });
});
