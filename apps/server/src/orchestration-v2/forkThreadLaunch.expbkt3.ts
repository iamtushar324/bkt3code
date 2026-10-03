// T3-CUSTOM(expbkt3): retained BK behavior at the native V2 boundary.
/** Forward only caller-controlled fork launch metadata into the native create command. */
import type { OrchestrationV2Command } from "@t3tools/contracts";
type CreateMetadata = Pick<
  Extract<OrchestrationV2Command, { type: "thread.create" }>,
  | "ownerUserId"
  | "memberUserIds"
  | "sourceControlProfileId"
  | "priority"
  | "customGroup"
  | "linearIssueUrl"
  | "mattermostThreadUrl"
  | "parentThreadId"
  | "parentEnvironmentId"
>;
export type ForkThreadLaunchMetadata = {
  readonly [Field in keyof CreateMetadata]?: CreateMetadata[Field] | undefined;
};

export const forkThreadLaunchMetadata = (input: ForkThreadLaunchMetadata) => ({
  ...(input.ownerUserId === undefined ? {} : { ownerUserId: input.ownerUserId }),
  ...(input.memberUserIds === undefined ? {} : { memberUserIds: input.memberUserIds }),
  ...(input.sourceControlProfileId === undefined
    ? {}
    : { sourceControlProfileId: input.sourceControlProfileId }),
  ...(input.priority === undefined ? {} : { priority: input.priority }),
  ...(input.customGroup === undefined ? {} : { customGroup: input.customGroup }),
  ...(input.linearIssueUrl === undefined ? {} : { linearIssueUrl: input.linearIssueUrl }),
  ...(input.mattermostThreadUrl === undefined
    ? {}
    : { mattermostThreadUrl: input.mattermostThreadUrl }),
  ...(input.parentThreadId === undefined ? {} : { parentThreadId: input.parentThreadId }),
  ...(input.parentEnvironmentId === undefined
    ? {}
    : { parentEnvironmentId: input.parentEnvironmentId }),
});
