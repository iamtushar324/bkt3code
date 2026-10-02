// T3-CUSTOM(expbkt3): "Create new thread" from an experimental-sidebar row.
//
// The point of this entry point is side-by-side sessions that behave like tabs:
// you start one from the session you are already in, type into it later, and
// switching away and back finds it exactly where you left it. That rules out the
// local draft the "New thread" button creates — a draft is one-per-project,
// lives only in this browser, and never appears in the session tree, so it
// cannot be returned to from another row.
//
// So the thread is created for real, eagerly, with no first turn: a plain
// `thread.create` parented to the row that was right-clicked. The server
// persists it, the sidebar nests it under that row, and the chat view opens on
// an empty composer. A "new worktree" choice creates the worktree first (with a
// temporary branch the first turn renames) and hands its path to the create.
import type {
  ModelSelection,
  ProjectId,
  ProviderInteractionMode,
  RuntimeMode,
  SourceControlProfileId,
  ThreadId,
} from "@t3tools/contracts";
import type { CreateThreadInput } from "@t3tools/client-runtime/operations";

/** Which workspace the new session runs in. */
export type NewThreadWorkspaceChoice = "same-worktree" | "new-worktree";

/** The session the new thread is started from. */
export interface NewThreadParentThread {
  readonly id: ThreadId;
  readonly projectId: ProjectId;
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly modelSelection: ModelSelection;
  readonly sourceControlProfileId: SourceControlProfileId | null;
}

/** The checkout the new thread runs in. */
export interface NewThreadWorkspace {
  readonly branch: string | null;
  readonly worktreePath: string | null;
}

/**
 * Placeholder title. Sending the first message retitles the thread from that
 * message, so this only has to read sensibly while the thread is still empty.
 */
export const NEW_THREAD_FROM_ROW_TITLE = "New thread";

/**
 * "Same worktree" follows the parent wherever it runs: its worktree when it has
 * one, otherwise the project checkout it shares.
 */
export function resolveSameWorktreeWorkspace(parent: NewThreadParentThread): NewThreadWorkspace {
  return { branch: parent.branch, worktreePath: parent.worktreePath };
}

/**
 * A new worktree branches from the parent's branch, so the tab starts from the
 * code its parent is working on. Without a parent branch there is nothing to
 * branch from, and the menu entry stays hidden.
 */
export function canCreateWorktreeFromParent(parent: NewThreadParentThread): boolean {
  return parent.branch !== null;
}

export function buildNewThreadFromRowCreateInput(input: {
  readonly parent: NewThreadParentThread;
  readonly threadId: ThreadId;
  readonly workspace: NewThreadWorkspace;
  /** The saved default model with its options; null when none is saved. */
  readonly modelSelection: ModelSelection | null;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly createdAt: string;
}): CreateThreadInput {
  const { parent, threadId, workspace, modelSelection, runtimeMode, interactionMode, createdAt } =
    input;
  return {
    threadId,
    projectId: parent.projectId,
    title: NEW_THREAD_FROM_ROW_TITLE,
    // The saved defaults (project, then host) always win for a new thread. Only
    // when no default model is saved does a tab of the same work answer with
    // the same agent as its parent. The parent's interaction mode never
    // carries: inheriting Plan mode into a fresh session surprises far more
    // often than it helps, so the saved starting mode decides.
    modelSelection: modelSelection ?? parent.modelSelection,
    runtimeMode,
    interactionMode,
    branch: workspace.branch,
    worktreePath: workspace.worktreePath,
    sourceControlProfileId: parent.sourceControlProfileId,
    parentThreadId: parent.id,
    createdAt,
  };
}
