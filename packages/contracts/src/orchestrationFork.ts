// T3-CUSTOM(expbkt3): shared team metadata for native V2 projections and commands.
import * as Schema from "effect/Schema";

import {
  CommandId,
  EnvironmentId,
  IsoDateTime,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  UserId,
} from "./baseSchemas.ts";
import { SourceControlProfileId } from "./sourceControlProfiles.ts";
import { ThreadCustomGroup } from "./threadCustomGroup.ts";
import { OrchestrationThreadActivity } from "./orchestration.ts";

export const ThreadPriority = Schema.Literals([0, 1, 2, 3, 4]);
export type ThreadPriority = typeof ThreadPriority.Type;

export const ForkOwnershipFields = {
  ownerUserId: Schema.optionalKey(Schema.NullOr(UserId)),
  memberUserIds: Schema.optionalKey(Schema.Array(UserId)),
};

export const ForkThreadMetadataFields = {
  ...ForkOwnershipFields,
  titleManuallySet: Schema.optionalKey(Schema.Boolean),
  pendingAsyncUserInputIds: Schema.optionalKey(Schema.Array(TrimmedNonEmptyString)),
  sourceControlProfileId: Schema.optionalKey(Schema.NullOr(SourceControlProfileId)),
  priority: Schema.optional(Schema.NullOr(ThreadPriority)),
  customGroup: Schema.optional(Schema.NullOr(ThreadCustomGroup)),
  linearIssueUrl: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  mattermostThreadUrl: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  parentThreadId: Schema.optional(Schema.NullOr(ThreadId)),
  parentEnvironmentId: Schema.optional(Schema.NullOr(EnvironmentId)),
};

export const ForkThreadCreateFields = {
  ownerUserId: Schema.optional(UserId),
  memberUserIds: Schema.optional(Schema.Array(UserId)),
  sourceControlProfileId: Schema.optional(Schema.NullOr(SourceControlProfileId)),
  priority: Schema.optional(Schema.NullOr(ThreadPriority)),
  customGroup: Schema.optional(Schema.NullOr(ThreadCustomGroup)),
  linearIssueUrl: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  mattermostThreadUrl: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  parentThreadId: Schema.optional(Schema.NullOr(ThreadId)),
  parentEnvironmentId: Schema.optional(Schema.NullOr(EnvironmentId)),
};

export const ForkThreadUpdateFields = {
  sourceControlProfileId: Schema.optional(Schema.NullOr(SourceControlProfileId)),
  priority: Schema.optional(Schema.NullOr(ThreadPriority)),
  customGroup: Schema.optional(Schema.NullOr(ThreadCustomGroup)),
  linearIssueUrl: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  mattermostThreadUrl: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  parentThreadId: Schema.optional(Schema.NullOr(ThreadId)),
  parentEnvironmentId: Schema.optional(Schema.NullOr(EnvironmentId)),
};

export const ForkThreadCommands = [
  Schema.Struct({
    type: Schema.Literal("thread.activity.append"),
    commandId: CommandId,
    threadId: ThreadId,
    activity: OrchestrationThreadActivity,
  }),
  Schema.Struct({
    type: Schema.Literal("thread.member.add"),
    commandId: CommandId,
    threadId: ThreadId,
    userId: UserId,
  }),
  Schema.Struct({
    type: Schema.Literal("thread.member.remove"),
    commandId: CommandId,
    threadId: ThreadId,
    userId: UserId,
  }),
  Schema.Struct({
    type: Schema.Literal("thread.owner.transfer"),
    commandId: CommandId,
    threadId: ThreadId,
    userId: UserId,
  }),
  Schema.Struct({
    type: Schema.Literal("thread.source-control-profile.set"),
    commandId: CommandId,
    threadId: ThreadId,
    sourceControlProfileId: SourceControlProfileId,
    createdAt: IsoDateTime,
  }),
] as const;

export const ForkProjectCommands = [
  Schema.Struct({
    type: Schema.Literal("project.member.add"),
    commandId: CommandId,
    projectId: ProjectId,
    userId: UserId,
  }),
  Schema.Struct({
    type: Schema.Literal("project.member.remove"),
    commandId: CommandId,
    projectId: ProjectId,
    userId: UserId,
  }),
  Schema.Struct({
    type: Schema.Literal("project.owner.transfer"),
    commandId: CommandId,
    projectId: ProjectId,
    userId: UserId,
  }),
] as const;
