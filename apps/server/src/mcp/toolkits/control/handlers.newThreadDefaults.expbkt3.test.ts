// T3-CUSTOM(expbkt3): t3_create_session fills omitted fields from the saved
// new-thread defaults: the project's override entry, then the host.
import { expect, it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";

import { __testing } from "./handlers.ts";

const projectId = ProjectId.make("project-defaults");
const hostModel = createModelSelection(ProviderInstanceId.make("codex"), "gpt-6-astra", [
  { id: "reasoningEffort", value: "high" },
]);
const projectModel = createModelSelection(ProviderInstanceId.make("claudeAgent"), "claude-opus-5", [
  { id: "effort", value: "max" },
]);
const callerModel = createModelSelection(ProviderInstanceId.make("claudeAgent"), "claude-sonnet-5");
const project = { defaultModelSelection: null, defaultThreadEnvMode: null };

const hostSettings = {
  ...DEFAULT_SERVER_SETTINGS,
  defaultModelSelection: hostModel,
  defaultRuntimeMode: "approval-required" as const,
  defaultThreadInteractionMode: "plan" as const,
  defaultThreadEnvMode: "local" as const,
};

it("uses the host defaults, options included, when the caller and project set nothing", () => {
  expect(
    __testing.resolveCreatedSessionDefaults({
      settings: hostSettings,
      projectId,
      project,
      input: {},
    }),
  ).toEqual({
    modelSelection: hostModel,
    runtimeMode: "approval-required",
    interactionMode: "plan",
    envMode: "local",
  });
});

it("lets the project's override entry beat the host", () => {
  const settings = {
    ...hostSettings,
    projectSettingsOverrides: {
      [projectId]: {
        defaultModelSelection: projectModel,
        defaultRuntimeMode: "full-access" as const,
        defaultThreadInteractionMode: "default" as const,
        defaultThreadEnvMode: "worktree" as const,
      },
    },
  };
  expect(
    __testing.resolveCreatedSessionDefaults({ settings, projectId, project, input: {} }),
  ).toEqual({
    modelSelection: projectModel,
    runtimeMode: "full-access",
    interactionMode: "default",
    envMode: "worktree",
  });
});

it("lets the caller's explicit fields beat every saved default", () => {
  expect(
    __testing.resolveCreatedSessionDefaults({
      settings: hostSettings,
      projectId,
      project,
      input: { modelSelection: callerModel, runtimeMode: "auto", interactionMode: "default" },
    }),
  ).toEqual({
    modelSelection: callerModel,
    runtimeMode: "auto",
    interactionMode: "default",
    envMode: "local",
  });
});

it("falls back to the built-in model and modes when nothing is saved anywhere", () => {
  const defaults = __testing.resolveCreatedSessionDefaults({
    settings: DEFAULT_SERVER_SETTINGS,
    projectId,
    project,
    input: {},
  });
  // A session needs some provider: the deprecated host-wide key's decoded
  // default stands in for an unset model.
  expect(defaults.modelSelection).toEqual(DEFAULT_SERVER_SETTINGS.defaultThreadModelSelection);
  expect(defaults.runtimeMode).toBe(DEFAULT_SERVER_SETTINGS.defaultRuntimeMode);
  expect(defaults.interactionMode).toBe("default");
  // Unset env mode stays null; the handler reads that as "new worktree".
  expect(defaults.envMode).toBeNull();
});
