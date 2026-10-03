// T3-CUSTOM(expbkt3): fork actions beside the native thread breadcrumb.
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useProject, useThreadShell } from "../state/entities";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { useHasMultipleEnvironments } from "../state/environments";
import { ThreadMembersControl } from "../components/members/ThreadMembersControl";
import { ThreadContextActionsControl } from "../components/chat/ThreadContextActionsControl";
import { ThreadCostControl } from "../components/chat/ThreadCostControl";
import { EnvironmentBadge } from "../components/environment/EnvironmentBadge";
import { SmartGitButton } from "./smartGit/SmartGitButton";
import { useSmartGitAction } from "./smartGit/useSmartGitAction";
export function ForkChatHeaderControls({
  threadRef,
}: {
  readonly threadRef: ScopedThreadRef | null;
}) {
  const shell = useThreadShell(threadRef);
  const project = useProject(shell ? scopeProjectRef(shell.environmentId, shell.projectId) : null);
  const multiple = useHasMultipleEnvironments();
  const smartGit = useSmartGitAction({
    threadRef,
    gitCwd: shell?.worktreePath ?? project?.workspaceRoot ?? null,
    sourceControlProfileId: shell?.sourceControlProfileId ?? null,
  });
  if (threadRef === null) return null;
  return (
    <div className="flex shrink-0 items-center gap-1">
      {multiple ? (
        <EnvironmentBadge environmentId={threadRef.environmentId} variant="glyph" />
      ) : null}
      <SmartGitButton action={smartGit} presentation="toolbar" />
      <ThreadContextActionsControl
        activeThreadEnvironmentId={threadRef.environmentId}
        activeThreadId={threadRef.threadId}
      />
      <ThreadMembersControl environmentId={threadRef.environmentId} threadId={threadRef.threadId} />
      <ThreadCostControl environmentId={threadRef.environmentId} threadId={threadRef.threadId} />
    </div>
  );
}
