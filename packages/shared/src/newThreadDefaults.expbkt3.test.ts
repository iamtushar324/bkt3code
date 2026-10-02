// T3-CUSTOM(expbkt3): the saved default wins for every new thread.
import { DEFAULT_SERVER_SETTINGS, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { createModelSelection } from "./model.ts";
import { resolveNewThreadDefaults } from "./newThreadDefaults.expbkt3.ts";

const projectId = ProjectId.make("project-a");
const otherProjectId = ProjectId.make("project-b");
const hostModel = createModelSelection(ProviderInstanceId.make("codex"), "gpt-6-astra", [
  { id: "reasoningEffort", value: "high" },
]);
const projectModel = createModelSelection(ProviderInstanceId.make("claudeAgent"), "claude-opus-5", [
  { id: "effort", value: "max" },
  { id: "contextWindow", value: "1m" },
]);

describe("resolveNewThreadDefaults", () => {
  it("falls back to the built-in defaults when nothing is saved", () => {
    const defaults = resolveNewThreadDefaults(DEFAULT_SERVER_SETTINGS, projectId);
    expect(defaults).toEqual({
      modelSelection: null,
      runtimeMode: DEFAULT_SERVER_SETTINGS.defaultRuntimeMode,
      interactionMode: "default",
      envMode: null,
    });
  });

  it("uses the host values, options included, when the project has no override", () => {
    const defaults = resolveNewThreadDefaults(
      {
        ...DEFAULT_SERVER_SETTINGS,
        defaultModelSelection: hostModel,
        defaultRuntimeMode: "approval-required",
        defaultThreadInteractionMode: "plan",
        defaultThreadEnvMode: "local",
      },
      projectId,
    );
    expect(defaults).toEqual({
      modelSelection: hostModel,
      runtimeMode: "approval-required",
      interactionMode: "plan",
      envMode: "local",
    });
    expect(defaults.modelSelection?.options).toEqual(hostModel.options);
  });

  it("lets a project override beat the host for every field", () => {
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      defaultModelSelection: hostModel,
      defaultRuntimeMode: "approval-required" as const,
      defaultThreadInteractionMode: "default" as const,
      defaultThreadEnvMode: "local" as const,
      projectSettingsOverrides: {
        [projectId]: {
          defaultModelSelection: projectModel,
          defaultRuntimeMode: "full-access" as const,
          defaultThreadInteractionMode: "plan" as const,
          defaultThreadEnvMode: "worktree" as const,
        },
      },
    };
    expect(resolveNewThreadDefaults(settings, projectId)).toEqual({
      modelSelection: projectModel,
      runtimeMode: "full-access",
      interactionMode: "plan",
      envMode: "worktree",
    });
    // Another project, and no project at all, still see the host values.
    expect(resolveNewThreadDefaults(settings, otherProjectId).modelSelection).toEqual(hostModel);
    expect(resolveNewThreadDefaults(settings, null).interactionMode).toBe("default");
  });

  it("treats a project's null model override as 'no default model'", () => {
    const defaults = resolveNewThreadDefaults(
      {
        ...DEFAULT_SERVER_SETTINGS,
        defaultModelSelection: hostModel,
        projectSettingsOverrides: { [projectId]: { defaultModelSelection: null } },
      },
      projectId,
    );
    expect(defaults.modelSelection).toBeNull();
  });

  it("honours the aggregate's legacy model until the server has folded it", () => {
    const unfolded = { ...DEFAULT_SERVER_SETTINGS, projectSettingsFolded: false };
    expect(
      resolveNewThreadDefaults(unfolded, projectId, { defaultModelSelection: projectModel })
        .modelSelection,
    ).toEqual(projectModel);
    expect(
      resolveNewThreadDefaults({ ...unfolded, projectSettingsFolded: true }, projectId, {
        defaultModelSelection: projectModel,
      }).modelSelection,
    ).toBeNull();
  });

  it("resolves the env mode through t3.json, then the built-in, when a file is given", () => {
    expect(
      resolveNewThreadDefaults(DEFAULT_SERVER_SETTINGS, projectId, null, {
        defaultThreadEnvMode: "worktree",
      }).envMode,
    ).toBe("worktree");
    expect(resolveNewThreadDefaults(DEFAULT_SERVER_SETTINGS, projectId, null, null).envMode).toBe(
      "local",
    );
  });
});
