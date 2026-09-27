/**
 * T3-CUSTOM(expbkt3): Session context handoff actions.
 *
 * One header menu with three ways out of a session — copy its full context,
 * or seed a new / child thread's draft composer with it. Normally it is served
 * by the `threadContext.export` RPC, which reads the projection and the
 * worktree only, so these actions keep working while the session's provider
 * is erroring — that broken-session escape hatch is the reason this exists.
 *
 * When the host itself is unreachable the RPC cannot answer, and that is
 * precisely when an operator most wants to move the work somewhere that still
 * runs. So the menu stays open and the digest is rendered from the client's
 * cached copy of the thread instead, using the same renderer the host uses.
 * The fallback is chosen from the connection phase rather than by trying the
 * RPC first: while a connection is retrying, an environment call parks instead
 * of failing, which would hang the menu on exactly the hosts that need it.
 *
 * Kept self-contained (data fetching, clipboard, draft seeding) so ChatHeader
 * stays a one-line mounting seam, mirroring T3ConductorLinearIssueControl.
 */
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadContextExportResult, ThreadId } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { renderCachedThreadDigest } from "@t3tools/client-runtime/handoff";
import { connectionProjectionPhase } from "@t3tools/client-runtime/connection";
import { threadHasOlderTurns } from "@t3tools/client-runtime/state/threads";
import {
  ClipboardCopyIcon,
  DownloadIcon,
  FileOutputIcon,
  GitForkIcon,
  MessageSquarePlusIcon,
} from "lucide-react";
import { useState } from "react";

import { useComposerDraftStore } from "~/composerDraftStore";
import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { pinThreadCacheForHandoff } from "../../connection/storage";
// T3-CUSTOM(expbkt3): the same writer the plan export uses.
import { downloadPlanAsTextFile } from "../../proposedPlan";
import { useProject, useThread, useThreadShell } from "../../state/entities";
import { useEnvironmentConnectionState } from "../../state/environments";
import { useEnvironmentThread } from "../../state/threads";
import { sessionArchiveEnvironment } from "../../state/sessionArchive";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { stackedThreadToast, toastManager } from "../ui/toast";

export function ThreadContextActionsControl({
  activeThreadEnvironmentId,
  activeThreadId,
}: {
  readonly activeThreadEnvironmentId: EnvironmentId;
  readonly activeThreadId: ThreadId;
}) {
  const threadRef = scopeThreadRef(activeThreadEnvironmentId, activeThreadId);
  const shell = useThreadShell(threadRef);
  const exportContext = useAtomCommand(sessionArchiveEnvironment.exportContext, {
    reportFailure: false,
  });
  const handleNewThread = useNewThreadHandler();
  // T3-CUSTOM(expbkt3): BEGIN — inputs for a digest built without the host.
  const connectionState = useEnvironmentConnectionState(activeThreadEnvironmentId);
  const cachedThread = useThread(threadRef);
  const cachedThreadState = useEnvironmentThread(activeThreadEnvironmentId, activeThreadId);
  const project = useProject(
    shell === null ? null : scopeProjectRef(activeThreadEnvironmentId, shell.projectId),
  );
  // T3-CUSTOM(expbkt3): END
  const [isBusy, setIsBusy] = useState(false);

  if (shell === null) {
    return null;
  }

  // T3-CUSTOM(expbkt3): BEGIN — only a connected host can render the live digest.
  const isHostReachable =
    connectionState.data !== null && connectionProjectionPhase(connectionState.data) === "ready";
  // T3-CUSTOM(expbkt3): END

  const reportError = (title: string, cause: unknown) => {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title,
        description: cause instanceof Error ? cause.message : String(cause),
      }),
    );
  };

  // T3-CUSTOM(expbkt3): BEGIN — cached digest for an unreachable host.
  const cachedDigest = (): ThreadContextExportResult | null => {
    if (cachedThread === null) {
      reportError(
        "No cached copy of this session",
        new Error(
          "This session has not been open on this device since the host went offline, so there is nothing to hand off yet.",
        ),
      );
      return null;
    }
    return renderCachedThreadDigest({
      thread: cachedThread,
      project,
      hasMoreHistory: threadHasOlderTurns(cachedThreadState),
    });
  };
  // T3-CUSTOM(expbkt3): END

  const fetchDigest = async (): Promise<ThreadContextExportResult | null> => {
    // T3-CUSTOM(expbkt3): the host cannot answer, so render from the cache.
    if (!isHostReachable) {
      return cachedDigest();
    }
    const result = await exportContext({
      environmentId: activeThreadEnvironmentId,
      input: { threadId: activeThreadId },
    });
    if (result._tag !== "Success") {
      // T3-CUSTOM(expbkt3): a host that dropped mid-call still has a cached copy.
      const fallback = cachedDigest();
      if (fallback !== null) {
        return fallback;
      }
      reportError("Could not export session context", squashAtomCommandFailure(result as never));
      return null;
    }
    return result.value as ThreadContextExportResult;
  };

  const notifyTruncated = (digest: ThreadContextExportResult) => {
    // T3-CUSTOM(expbkt3): BEGIN — say which limit shortened it, and why.
    if (!isHostReachable) {
      toastManager.add(
        stackedThreadToast({
          type: "warning",
          title: "Built from the local cache",
          description:
            "This host is offline, so the handoff was rendered from this device's copy of the session. Git state is missing, and any messages sent after the last sync are not included.",
        }),
      );
      return;
    }
    // T3-CUSTOM(expbkt3): END
    if (!digest.truncated) return;
    toastManager.add(
      stackedThreadToast({
        type: "warning",
        title: "Context was shortened",
        description:
          "The transcript exceeded the size cap, so older messages were elided. The summary and git state are complete.",
      }),
    );
  };

  const runGuarded = async (action: () => Promise<void>) => {
    if (isBusy) return;
    setIsBusy(true);
    try {
      await action();
    } finally {
      setIsBusy(false);
    }
  };

  const copyContext = () =>
    runGuarded(async () => {
      const digest = await fetchDigest();
      if (digest === null) return;
      try {
        await writeTextToClipboard(digest.markdown, "session context");
      } catch (cause) {
        reportError("Could not copy session context", cause);
        return;
      }
      notifyTruncated(digest);
      toastManager.add(
        stackedThreadToast({
          type: "success",
          title: "Session context copied",
          description: `${digest.messageCount} messages distilled into a handoff digest. Paste it into any session to continue there.`,
        }),
      );
    });

  // T3-CUSTOM(expbkt3): BEGIN — a handoff that leaves the app entirely. The
  // clipboard is fine for pasting into another session; a file is what survives
  // being sent to a colleague, attached to a ticket, or kept while a machine is
  // rebuilt — which is exactly the situation an offline handoff belongs to.
  const saveContextToFile = () =>
    runGuarded(async () => {
      const digest = await fetchDigest();
      if (digest === null) return;
      const slug =
        digest.title
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 60) || "session";
      downloadPlanAsTextFile(`${slug}-handoff.md`, digest.markdown);
      notifyTruncated(digest);
      toastManager.add(
        stackedThreadToast({
          type: "success",
          title: "Session context saved",
          description: `${digest.messageCount} messages written to ${slug}-handoff.md.`,
        }),
      );
    });
  // T3-CUSTOM(expbkt3): END

  const seedThreadWithContext = (mode: "new" | "child") =>
    runGuarded(async () => {
      const digest = await fetchDigest();
      if (digest === null) return;
      const projectRef = scopeProjectRef(activeThreadEnvironmentId, shell.projectId);
      // "New" replaces a broken session: isolate it in a fresh worktree.
      // "Child" continues alongside the source: reuse its worktree and branch
      // so uncommitted work stays visible (or local mode when it had one).
      // T3-CUSTOM(expbkt3): the child records which environment its parent lives
      // on, so the operator can move the draft to a machine that is actually up
      // — the usual reason to hand a session off — without losing the lineage.
      const workspaceOptions =
        mode === "child"
          ? shell.worktreePath
            ? {
                envMode: "worktree" as const,
                worktreePath: shell.worktreePath,
                branch: shell.branch ?? null,
                parentThreadId: activeThreadId,
                parentEnvironmentId: activeThreadEnvironmentId,
              }
            : {
                envMode: "local" as const,
                worktreePath: null,
                branch: null,
                parentThreadId: activeThreadId,
                parentEnvironmentId: activeThreadEnvironmentId,
              }
          : {
              envMode: "worktree" as const,
              worktreePath: null,
              branch: null,
              parentThreadId: null,
              parentEnvironmentId: null,
            };
      // T3-CUSTOM(expbkt3): the work continues elsewhere from this transcript, so
      // keep it cached past the point the operator stops opening it.
      void pinThreadCacheForHandoff(activeThreadEnvironmentId, activeThreadId);
      await handleNewThread(projectRef, workspaceOptions);
      const store = useComposerDraftStore.getState();
      const draftSession = store.getDraftSessionByProjectRef(projectRef);
      if (draftSession === null) {
        reportError(
          "Could not seed the new thread",
          new Error("The draft thread was not found after creation."),
        );
        return;
      }
      const existingPrompt = store.getComposerDraft(draftSession.draftId)?.prompt ?? "";
      const prefill =
        existingPrompt.trim().length > 0
          ? `${digest.markdown}\n\n${existingPrompt}`
          : `${digest.markdown}\n\n`;
      store.setPrompt(draftSession.draftId, prefill);
      notifyTruncated(digest);
    });

  return (
    <Menu>
      <MenuTrigger
        render={<Button size="icon-xs" variant="outline" aria-label="Session context actions" />}
        disabled={isBusy}
      >
        <FileOutputIcon aria-hidden="true" className="size-3.5" />
      </MenuTrigger>
      <MenuPopup align="end">
        {/* T3-CUSTOM(expbkt3): the menu stays usable offline, but says so. */}
        {isHostReachable ? null : (
          <div className="text-muted-foreground px-2 py-1.5 text-xs">
            Host offline — using this device&apos;s cached copy
          </div>
        )}
        <MenuItem disabled={isBusy} onClick={() => void copyContext()}>
          <ClipboardCopyIcon />
          Copy full context
        </MenuItem>
        {/* T3-CUSTOM(expbkt3): a handoff that outlives the app session. */}
        <MenuItem disabled={isBusy} onClick={() => void saveContextToFile()}>
          <DownloadIcon />
          Save full context as file
        </MenuItem>
        <MenuItem disabled={isBusy} onClick={() => void seedThreadWithContext("new")}>
          <MessageSquarePlusIcon />
          New thread with this context…
        </MenuItem>
        <MenuItem disabled={isBusy} onClick={() => void seedThreadWithContext("child")}>
          <GitForkIcon />
          New child thread with this context…
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}
