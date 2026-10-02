// T3-CUSTOM(expbkt3): one resolver for what a brand-new thread starts with.
//
// Every surface that mints a thread without a human picking each field — the
// web's new-thread paths, the sidebar's side-by-side rows, `t3_create_session`
// — asks here, so the saved default always wins and wins the same way
// everywhere. The order is upstream's scoped-settings order: the project's
// override entry, then the host value, then the built-in default (which is
// what the host value is when nothing set it).
import type {
  ModelSelection,
  ProjectId,
  ProviderInteractionMode,
  ResolvedServerSettings,
  RuntimeMode,
  ServerSettings,
  T3ProjectFile,
  ThreadEnvMode,
} from "@t3tools/contracts";
import { type LegacyProjectSettingsFields, resolveProjectSettings } from "./projectSettings.ts";

export interface NewThreadDefaults<EnvMode = ThreadEnvMode | null> {
  /** Provider, model and options; null when no tier pins a model. */
  readonly modelSelection: ModelSelection | null;
  readonly runtimeMode: RuntimeMode;
  /** Plan or Build. Callers without a plan toggle coerce this to "default". */
  readonly interactionMode: ProviderInteractionMode;
  /** Null defers to the checkout's t3.json, then the built-in, when no file was given. */
  readonly envMode: EnvMode;
}

/**
 * The saved defaults for a new thread in `projectId` (null for "no project":
 * host values only). `project` carries the aggregate's legacy fields, honoured
 * until the server has folded them, exactly as `resolveProjectSettings` does.
 */
export function resolveNewThreadDefaults(
  settings: ServerSettings,
  projectId: ProjectId | null,
  project?: LegacyProjectSettingsFields | null,
): NewThreadDefaults;
/** With the checkout's t3.json (or null for none), the env mode is concrete. */
export function resolveNewThreadDefaults(
  settings: ServerSettings,
  projectId: ProjectId | null,
  project: LegacyProjectSettingsFields | null | undefined,
  projectFile: T3ProjectFile | null,
): NewThreadDefaults<ThreadEnvMode>;
export function resolveNewThreadDefaults(
  settings: ServerSettings,
  projectId: ProjectId | null,
  project?: LegacyProjectSettingsFields | null,
  projectFile?: T3ProjectFile | null,
): NewThreadDefaults {
  const resolved =
    projectFile === undefined
      ? resolveProjectSettings(settings, projectId, project).settings
      : (resolveProjectSettings(settings, projectId, project, projectFile)
          .settings as ResolvedServerSettings);
  return {
    modelSelection: resolved.defaultModelSelection,
    runtimeMode: resolved.defaultRuntimeMode,
    interactionMode: resolved.defaultThreadInteractionMode,
    envMode: resolved.defaultThreadEnvMode,
  };
}
