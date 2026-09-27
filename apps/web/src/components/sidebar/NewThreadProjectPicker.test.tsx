// T3-CUSTOM(expbkt3): the picker shows one row per nickname, and the host
// overlay only asks when a nickname really lives in more than one place.
//
// The rows are asserted through the portal-free list components: the dialog
// itself renders nothing until it is mounted in a browser.
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import type { Project } from "../../types";
import { NewThreadHostList, NewThreadProjectOptionList } from "./NewThreadProjectPicker";
import {
  buildNewThreadProjectOptions,
  type NewThreadProjectOption,
} from "./NewThreadProjectPicker.logic";

const localEnvironmentId = EnvironmentId.make("environment-local");
const remoteEnvironmentId = EnvironmentId.make("environment-remote");

function makeProject(
  id: string,
  options: {
    readonly title?: string;
    readonly environment?: EnvironmentId;
    readonly projectIcon?: Project["projectIcon"];
  } = {},
): Project {
  return {
    id: ProjectId.make(id),
    environmentId: options.environment ?? localEnvironmentId,
    title: options.title ?? id,
    workspaceRoot: `/home/ubuntu/repos/${id}`,
    projectIcon: options.projectIcon,
  } as unknown as Project;
}

const labels: Record<string, string> = {
  [localEnvironmentId]: "dev-server-1",
  [remoteEnvironmentId]: "tushar-mbp",
};

function optionsFor(projects: ReadonlyArray<Project>): readonly NewThreadProjectOption[] {
  return buildNewThreadProjectOptions({
    projects,
    activeProject: null,
    primaryEnvironmentId: localEnvironmentId,
    resolveEnvironmentLabel: (environmentId) => labels[environmentId] ?? null,
  });
}

function renderOptions(projects: ReadonlyArray<Project>): string {
  return renderToStaticMarkup(
    <NewThreadProjectOptionList options={optionsFor(projects)} onChoose={() => {}} />,
  );
}

const duplicatedNickname = [
  makeProject("bks-local", { title: "bks" }),
  makeProject("bks-remote", { title: "bks", environment: remoteEnvironmentId }),
];

describe("NewThreadProjectOptionList", () => {
  it("renders one row for a nickname that exists on two hosts", () => {
    const markup = renderOptions(duplicatedNickname);

    const rows = markup.match(/data-testid="new-thread-project-option-/g) ?? [];
    expect(rows).toHaveLength(1);
    expect(markup).toContain('data-testid="new-thread-project-option-bks"');
    // The duplicate row is replaced by a count, so the second host stays
    // visible as information without being a second thing to choose between.
    expect(markup).toContain("2 hosts");
  });

  it("names the single host inline instead of promising a second step", () => {
    const markup = renderOptions([makeProject("hermes", { title: "hermes" })]);

    expect(markup).toContain("dev-server-1");
    expect(markup).not.toContain("hosts");
  });

  it("renders the saved project icon override", () => {
    const markup = renderOptions([
      makeProject("hermes", {
        title: "hermes",
        projectIcon: { kind: "emoji", emoji: "🛰️" },
      }),
    ]);

    expect(markup).toContain("🛰️");
  });

  it("keeps distinct nicknames as separate rows", () => {
    const markup = renderOptions([
      makeProject("hermes", { title: "hermes" }),
      makeProject("skep", { title: "Skep" }),
    ]);

    const rows = markup.match(/data-testid="new-thread-project-option-/g) ?? [];
    expect(rows).toHaveLength(2);
    expect(markup).toContain("hermes");
    expect(markup).toContain("Skep");
  });

  it("asks for a host only when the nickname resolves to more than one", () => {
    const chosen: string[] = [];
    const options = optionsFor([...duplicatedNickname, makeProject("hermes", { title: "hermes" })]);
    for (const option of options) {
      // What the dialog's click handler branches on.
      if (option.requiresHostChoice) chosen.push(option.key);
    }

    expect(chosen).toEqual(["bks"]);
    expect(options.find((option) => option.key === "hermes")?.defaultHost.project.id).toBe(
      "hermes",
    );
  });
});

describe("NewThreadHostList", () => {
  it("lists every host with the path that tells them apart", () => {
    const markup = renderToStaticMarkup(
      <NewThreadHostList
        option={optionsFor(duplicatedNickname)[0]!}
        appearanceFor={() => null}
        onSelect={() => {}}
      />,
    );

    expect(markup).toContain("dev-server-1");
    expect(markup).toContain("tushar-mbp");
    expect(markup).toContain("/home/ubuntu/repos/bks-local");
    expect(markup).toContain("/home/ubuntu/repos/bks-remote");
    const rows = markup.match(/data-testid="new-thread-host-option-/g) ?? [];
    expect(rows).toHaveLength(2);
  });

  it("hands back the project belonging to the chosen host", () => {
    const option = optionsFor(duplicatedNickname)[0]!;
    const remoteHost = option.hosts.find((host) => host.label === "tushar-mbp");

    expect(remoteHost?.project.id).toBe("bks-remote");
    expect(remoteHost?.project.environmentId).toBe(remoteEnvironmentId);
  });
});
