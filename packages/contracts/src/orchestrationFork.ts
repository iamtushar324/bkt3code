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
import { THREAD_CUSTOM_GROUP_MAX_LENGTH, ThreadCustomGroup } from "./threadCustomGroup.ts";
import {
  ThreadLinearLink,
  ThreadLinearLinksAdd,
  ThreadLinearLinksRemove,
} from "./threadLinearLink.ts";
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
  // Every Linear tag, in tag order. Absent on threads tagged before
  // multi-tagging; read through `threadLinearLinks`, which folds in
  // `linearIssueUrl`.
  linearLinks: Schema.optional(Schema.Array(ThreadLinearLink)),
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
  // Add or remove single Linear tags against the thread's current list, so two
  // writers tagging at once cannot overwrite each other.
  linearLinksAdd: Schema.optional(ThreadLinearLinksAdd),
  linearLinksRemove: Schema.optional(ThreadLinearLinksRemove),
  mattermostThreadUrl: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  parentThreadId: Schema.optional(Schema.NullOr(ThreadId)),
  parentEnvironmentId: Schema.optional(Schema.NullOr(EnvironmentId)),
};

/**
 * BK sidebar custom group on the APIs that create sessions (XFN-59), so an
 * automation files the sessions it starts under a group the way a person
 * does. One definition for every creation tool; validation is the shared
 * `ThreadCustomGroup` schema (trimmed, non-blank, at most
 * THREAD_CUSTOM_GROUP_MAX_LENGTH characters).
 */
const forkCustomGroupDescription = `BK sidebar custom group label for the new session; 1–${THREAD_CUSTOM_GROUP_MAX_LENGTH} chars. Files the session under that group in the sidebar's Custom view. Labels match case-insensitively, so reuse an existing label (t3_list_sessions shows them) to join its group. Omit to leave the session ungrouped.`;

/** `customGroup` for a tool that creates sessions now (t3_thread_launch, create_threads). */
export const ForkCustomGroupCreateField = {
  customGroup: Schema.optional(
    ThreadCustomGroup.annotate({ description: forkCustomGroupDescription }),
  ),
};

const forkScheduledTaskCustomGroupDescription = `BK sidebar custom group label for the new session each run creates; 1–${THREAD_CUSTOM_GROUP_MAX_LENGTH} chars. Applies only to runs that launch a fresh thread (bindToCurrentThread:false); a task bound to a thread keeps the label for when it is unbound. Labels match case-insensitively, so reuse an existing label to join its group.`;

/** `customGroup` for schedule_task: the group of the sessions the task's runs create. */
export const ForkScheduledTaskCustomGroupFields = {
  customGroup: Schema.optional(
    ThreadCustomGroup.annotate({ description: forkScheduledTaskCustomGroupDescription }),
  ),
};

/** `customGroup` for update_scheduled_task: a label sets it, null removes it, omitted keeps it. */
export const ForkScheduledTaskCustomGroupUpdateFields = {
  customGroup: Schema.optional(
    Schema.NullOr(ThreadCustomGroup).annotate({
      description: `${forkScheduledTaskCustomGroupDescription} Pass null to remove the label; omit to keep it.`,
    }),
  ),
};

/** The label a scheduled task's runs file their sessions under, in task summaries. */
export const ForkScheduledTaskCustomGroupResultFields = {
  customGroup: Schema.optional(
    Schema.String.annotate({
      description:
        "BK sidebar custom group of the sessions this task's runs create. Absent when the task has none.",
    }),
  ),
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
