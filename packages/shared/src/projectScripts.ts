// T3-CUSTOM(expbkt3): BEGIN — checked-in t3.json setup scripts run automatically.
import type {
  ProjectId,
  ProjectScript,
  ServerSettings,
  T3ProjectFileScript,
} from "@t3tools/contracts";
// T3-CUSTOM(expbkt3): END

type ProjectScriptSettings = Pick<
  ServerSettings,
  | "defaultProjectScripts"
  | "projectScriptOverrides"
  | "projectSettingsOverrides"
  | "projectSettingsFolded"
>;

/**
 * The project's override wins, then environment defaults. Until the legacy
 * fields have been folded into `projectSettingsOverrides`, the old map (null
 * there meant "reset to machine defaults") and the aggregate's own scripts
 * still count, so a server that has not run the fold yet behaves as before.
 */
export function resolveProjectScripts(
  settings: ProjectScriptSettings,
  project: { id: ProjectId; scripts: readonly ProjectScript[] },
): readonly ProjectScript[] {
  const override = settings.projectSettingsOverrides[project.id]?.defaultProjectScripts;
  if (override !== undefined) return override;
  if (settings.projectSettingsFolded) return settings.defaultProjectScripts;
  const legacy = settings.projectScriptOverrides[project.id];
  if (legacy === null) return settings.defaultProjectScripts;
  return legacy ?? (project.scripts.length > 0 ? project.scripts : settings.defaultProjectScripts);
}

export function projectScriptsInheritDefaults(
  settings: ProjectScriptSettings,
  project: { id: ProjectId; scripts: readonly ProjectScript[] },
): boolean {
  if (settings.projectSettingsOverrides[project.id]?.defaultProjectScripts !== undefined) {
    return false;
  }
  if (settings.projectSettingsFolded) return true;
  const legacy = settings.projectScriptOverrides[project.id];
  return legacy === null || (legacy === undefined && project.scripts.length === 0);
}

interface ProjectScriptRuntimeEnvInput {
  project: {
    cwd: string;
  };
  worktreePath?: string | null;
  extraEnv?: Record<string, string>;
}

export function projectScriptCwd(input: {
  project: {
    cwd: string;
  };
  worktreePath?: string | null;
}): string {
  return input.worktreePath ?? input.project.cwd;
}

export function projectScriptRuntimeEnv(
  input: ProjectScriptRuntimeEnvInput,
): Record<string, string> {
  const env: Record<string, string> = {
    T3CODE_PROJECT_ROOT: input.project.cwd,
  };
  if (input.worktreePath) {
    env.T3CODE_WORKTREE_PATH = input.worktreePath;
  }
  if (input.extraEnv) {
    return { ...env, ...input.extraEnv };
  }
  return env;
}

export function setupProjectScript(scripts: readonly ProjectScript[]): ProjectScript | null {
  return scripts.find((script) => script.runOnWorktreeCreate) ?? null;
}
// T3-CUSTOM(expbkt3): BEGIN — a repository can ship its setup action in t3.json
// instead of every teammate importing it once per project, per environment.

/**
 * The `t3.json` script a new worktree should run, if the file declares one.
 * Mirrors {@link setupProjectScript} over the checked-in file's entries.
 */
export function setupT3ProjectFileScript(
  scripts: readonly T3ProjectFileScript[] | undefined,
): T3ProjectFileScript | null {
  return scripts?.find((script) => script.runOnWorktreeCreate === true) ?? null;
}

/**
 * Turn a `t3.json` script entry into a runnable {@link ProjectScript}, filling
 * the fields the file leaves optional. `id` is supplied by the caller because
 * the file has no identity of its own; use a stable value so terminals and
 * receipts stay recognizable across runs.
 */
export function projectScriptFromFileScript(
  id: string,
  fileScript: T3ProjectFileScript,
): ProjectScript {
  return {
    id,
    name: fileScript.name,
    command: fileScript.command,
    icon: fileScript.icon ?? "play",
    runOnWorktreeCreate: fileScript.runOnWorktreeCreate ?? false,
    ...(fileScript.previewUrl === undefined
      ? {}
      : {
          previewUrl: fileScript.previewUrl,
          autoOpenPreview: fileScript.autoOpenPreview ?? false,
        }),
  };
}
// T3-CUSTOM(expbkt3): END
