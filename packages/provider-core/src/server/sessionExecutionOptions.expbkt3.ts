// T3-CUSTOM(expbkt3): per-thread source-control and session identity at provider spawn.
import type { RunId, SourceControlProfileId, UserId } from "@t3tools/contracts";

export interface ProviderSessionExecutionOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly actorUserId?: UserId | null;
  readonly backgroundGrantHash?: string | undefined;
  readonly backgroundRunId?: RunId | undefined;
  readonly sourceControlProfileId?: SourceControlProfileId | null;
  readonly identityEnvironment?: NodeJS.ProcessEnv;
}
