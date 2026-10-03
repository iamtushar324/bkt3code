// T3-CUSTOM(expbkt3): native V2 payloads must retain the team's durable metadata.
import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  OrchestrationV2Command,
  OrchestrationV2ThreadLaunchInput,
  OrchestrationV2TurnItemJson,
} from "./orchestrationV2.ts";
import { ProjectMutation } from "./project.ts";

const decodeCommand = Schema.decodeUnknownSync(OrchestrationV2Command);
const decodeProjectMutation = Schema.decodeUnknownSync(ProjectMutation);
const decodeTurnItem = Schema.decodeUnknownSync(OrchestrationV2TurnItemJson);
const encodeTurnItem = Schema.encodeSync(OrchestrationV2TurnItemJson);
const launchCodec = Schema.toCodecJson(OrchestrationV2ThreadLaunchInput);
const encodeLaunch = Schema.encodeSync(launchCodec);
const decodeLaunch = Schema.decodeSync(launchCodec);

describe("fork metadata in the V2 protocol", () => {
  it("retains credential selection and cross-environment lineage through launch serialization", () => {
    const launch = Schema.decodeUnknownSync(OrchestrationV2ThreadLaunchInput)({
      commandId: "launch-child",
      threadId: "child",
      projectId: "project",
      title: "Delegated task",
      modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" },
      runtimeMode: "full-access",
      interactionMode: "plan",
      workspaceStrategy: { type: "root" },
      ownerUserId: "user-owner",
      memberUserIds: ["user-reader"],
      sourceControlProfileId: "profile-owner",
      parentThreadId: "parent",
      parentEnvironmentId: "parent-environment",
      priority: 1,
      customGroup: "Upstream merge",
      linearIssueUrl: "https://linear.app/beknown/issue/TEC-1",
      mattermostThreadUrl: "https://mattermost.beknown.work/team/pl/message",
    });
    expect(decodeLaunch(encodeLaunch(launch))).toEqual(launch);
    expect(launch).toMatchObject({
      sourceControlProfileId: "profile-owner",
      parentThreadId: "parent",
      parentEnvironmentId: "parent-environment",
      ownerUserId: "user-owner",
      memberUserIds: ["user-reader"],
      priority: 1,
    });
  });
  it("retains the inherited audience and credential profile at thread creation", () => {
    const command = decodeCommand({
      type: "thread.create",
      commandId: "create-child",
      threadId: "child",
      projectId: "project",
      title: "Delegated task",
      createdBy: "agent",
      creationSource: "mcp",
      modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" },
      runtimeMode: "full-access",
      interactionMode: "plan",
      branch: null,
      worktreePath: null,
      ownerUserId: "user-owner",
      memberUserIds: ["user-reader"],
      sourceControlProfileId: "profile-owner",
      priority: 1,
      customGroup: "Upstream merge",
      linearIssueUrl: "https://linear.app/beknown/issue/TEC-1",
      mattermostThreadUrl: "https://mattermost.beknown.work/team/pl/message",
      parentThreadId: "parent",
      parentEnvironmentId: "parent-environment",
    });
    expect(command).toMatchObject({
      ownerUserId: "user-owner",
      memberUserIds: ["user-reader"],
      sourceControlProfileId: "profile-owner",
      priority: 1,
      customGroup: "Upstream merge",
      linearIssueUrl: "https://linear.app/beknown/issue/TEC-1",
      mattermostThreadUrl: "https://mattermost.beknown.work/team/pl/message",
      parentThreadId: "parent",
      parentEnvironmentId: "parent-environment",
    });
  });

  it("keeps explicit metadata clears separate from omitted updates", () => {
    const clear = decodeCommand({
      type: "thread.metadata.update",
      commandId: "clear-tags",
      threadId: "thread",
      priority: null,
      customGroup: null,
      linearIssueUrl: null,
      mattermostThreadUrl: null,
      sourceControlProfileId: null,
      parentThreadId: null,
      parentEnvironmentId: null,
    });
    expect(clear).toMatchObject({
      priority: null,
      customGroup: null,
      linearIssueUrl: null,
      mattermostThreadUrl: null,
      sourceControlProfileId: null,
      parentThreadId: null,
      parentEnvironmentId: null,
    });
    expect(
      decodeCommand({
        type: "thread.metadata.update",
        commandId: "rename",
        threadId: "thread",
        title: "New title",
      }),
    ).not.toHaveProperty("priority");
  });

  it("retains membership mutations in their native thread and project APIs", () => {
    expect(
      decodeCommand({
        type: "thread.member.add",
        commandId: "tag",
        threadId: "thread",
        userId: "user-reader",
      }),
    ).toMatchObject({ userId: "user-reader" });
    expect(
      decodeProjectMutation({
        type: "project.owner.transfer",
        commandId: "transfer",
        projectId: "project",
        userId: "user-owner",
      }),
    ).toMatchObject({ userId: "user-owner" });
  });

  it("retains the human sender in a serialized user message item", () => {
    const item = decodeTurnItem({
      id: "message-item",
      type: "user_message",
      threadId: "thread",
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      title: null,
      status: "completed",
      startedAt: null,
      completedAt: null,
      updatedAt: "2026-10-03T00:00:00.000Z",
      createdBy: "user",
      creationSource: "web",
      messageId: "message",
      inputIntent: "turn_start",
      text: "Apply the merge",
      attachments: [],
      sentByUserId: "user-owner",
    });
    expect(item).toMatchObject({ sentByUserId: "user-owner" });
    expect(encodeTurnItem(item)).toMatchObject({
      sentByUserId: "user-owner",
    });
  });
});
