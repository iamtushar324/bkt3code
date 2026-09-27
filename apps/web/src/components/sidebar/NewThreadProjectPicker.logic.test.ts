// T3-CUSTOM(expbkt3): nickname collapsing for the new-thread project picker.
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { Project } from "../../types";
import {
  buildNewThreadProjectOptions,
  findNewThreadProjectOption,
} from "./NewThreadProjectPicker.logic";

const localEnvironmentId = EnvironmentId.make("environment-local");
const remoteEnvironmentId = EnvironmentId.make("environment-remote");

function makeProject(
  id: string,
  options: {
    readonly title?: string;
    readonly environment?: EnvironmentId;
    readonly workspaceRoot?: string;
  } = {},
): Project {
  return {
    id: ProjectId.make(id),
    environmentId: options.environment ?? localEnvironmentId,
    title: options.title ?? id,
    workspaceRoot: options.workspaceRoot ?? `/home/ubuntu/repos/${id}`,
  } as unknown as Project;
}

const labels: Record<string, string> = {
  [localEnvironmentId]: "dev-server-1",
  [remoteEnvironmentId]: "tushar-mbp",
};

function build(
  projects: ReadonlyArray<Project>,
  activeProject: Project | null = null,
  primaryEnvironmentId: EnvironmentId | null = localEnvironmentId,
) {
  return buildNewThreadProjectOptions({
    projects,
    activeProject,
    primaryEnvironmentId,
    resolveEnvironmentLabel: (environmentId) => labels[environmentId] ?? null,
  });
}

describe("buildNewThreadProjectOptions", () => {
  it("collapses a nickname registered on several hosts into one option", () => {
    const options = build([
      makeProject("bks-local", { title: "bks" }),
      makeProject("bks-remote", { title: "bks", environment: remoteEnvironmentId }),
    ]);

    expect(options).toHaveLength(1);
    expect(options[0]!.title).toBe("bks");
    expect(options[0]!.requiresHostChoice).toBe(true);
    expect(options[0]!.hosts.map((host) => host.label)).toEqual(["dev-server-1", "tushar-mbp"]);
  });

  it("does not ask for a host when the nickname resolves to one place", () => {
    const options = build([makeProject("hermes", { title: "hermes" })]);

    expect(options[0]!.requiresHostChoice).toBe(false);
    expect(options[0]!.defaultHost.project.id).toBe("hermes");
  });

  it("keeps two checkouts on the same host apart by workspace path", () => {
    const options = build([
      makeProject("bks-a", { title: "bks", workspaceRoot: "/home/ubuntu/repos/bks" }),
      makeProject("bks-b", { title: "bks", workspaceRoot: "/home/ubuntu/work/bks" }),
    ]);

    expect(options).toHaveLength(1);
    expect(options[0]!.requiresHostChoice).toBe(true);
    expect(options[0]!.hosts.map((host) => host.workspaceRoot)).toEqual([
      "/home/ubuntu/repos/bks",
      "/home/ubuntu/work/bks",
    ]);
  });

  it("matches nicknames case-insensitively but shows the first spelling", () => {
    const options = build([
      makeProject("bks-local", { title: "BKS" }),
      makeProject("bks-remote", { title: "bks", environment: remoteEnvironmentId }),
    ]);

    expect(options).toHaveLength(1);
    expect(options[0]!.title).toBe("BKS");
    expect(options[0]!.key).toBe("bks");
  });

  it("preserves the caller's ordering by first appearance", () => {
    const options = build([
      makeProject("skep", { title: "Skep" }),
      makeProject("bks-local", { title: "bks" }),
      makeProject("bks-remote", { title: "bks", environment: remoteEnvironmentId }),
      makeProject("hermes", { title: "hermes" }),
    ]);

    expect(options.map((option) => option.title)).toEqual(["Skep", "bks", "hermes"]);
  });

  it("orders hosts with this device first", () => {
    const options = build([
      makeProject("bks-remote", { title: "bks", environment: remoteEnvironmentId }),
      makeProject("bks-local", { title: "bks" }),
    ]);

    expect(options[0]!.hosts.map((host) => host.project.id)).toEqual(["bks-local", "bks-remote"]);
  });

  it("labels the primary environment as This device when it has no nickname", () => {
    const options = buildNewThreadProjectOptions({
      projects: [makeProject("bks", { title: "bks" })],
      activeProject: null,
      primaryEnvironmentId: localEnvironmentId,
      resolveEnvironmentLabel: () => null,
    });

    expect(options[0]!.defaultHost.label).toBe("This device");
  });

  it("defaults to the active project's host and marks its option", () => {
    const active = makeProject("bks-remote", { title: "bks", environment: remoteEnvironmentId });
    const options = build([makeProject("bks-local", { title: "bks" }), active], active);

    expect(options[0]!.containsActiveProject).toBe(true);
    expect(options[0]!.defaultHost.project.id).toBe("bks-remote");
    expect(options[0]!.hosts.filter((host) => host.isActive)).toHaveLength(1);
  });

  it("falls back to the primary host when nothing is active", () => {
    const options = build([
      makeProject("bks-remote", { title: "bks", environment: remoteEnvironmentId }),
      makeProject("bks-local", { title: "bks" }),
    ]);

    expect(options[0]!.defaultHost.project.id).toBe("bks-local");
    expect(options[0]!.containsActiveProject).toBe(false);
  });

  it("keeps untitled projects distinct instead of collapsing them together", () => {
    const options = build([
      makeProject("one", { title: "  ", workspaceRoot: "/home/ubuntu/repos/alpha" }),
      makeProject("two", { title: "", workspaceRoot: "/home/ubuntu/repos/beta" }),
    ]);

    expect(options.map((option) => option.title)).toEqual(["alpha", "beta"]);
  });

  it("ignores a project delivered twice", () => {
    const project = makeProject("bks", { title: "bks" });
    const options = build([project, project]);

    expect(options[0]!.hosts).toHaveLength(1);
    expect(options[0]!.requiresHostChoice).toBe(false);
  });

  it("treats every host as remote when there is no primary environment", () => {
    const options = build(
      [
        makeProject("bks-local", { title: "bks" }),
        makeProject("bks-remote", { title: "bks", environment: remoteEnvironmentId }),
      ],
      null,
      null,
    );

    expect(options[0]!.hosts.every((host) => !host.isPrimary)).toBe(true);
    expect(options[0]!.hosts.map((host) => host.label)).toEqual(["dev-server-1", "tushar-mbp"]);
  });
});

describe("findNewThreadProjectOption", () => {
  it("re-reads the option by key", () => {
    const options = build([makeProject("bks", { title: "bks" })]);

    expect(findNewThreadProjectOption(options, "bks")?.title).toBe("bks");
  });

  it("returns null once the nickname is gone", () => {
    const options = build([makeProject("bks", { title: "bks" })]);

    expect(findNewThreadProjectOption(options, "hermes")).toBeNull();
    expect(findNewThreadProjectOption(options, null)).toBeNull();
  });
});
