/**
 * T3-CUSTOM(expbkt3): The machine-readable record beside a session's digest.
 *
 * The digest is written for an agent to read; the manifest is written for a
 * tool to parse — a search indexer, a backfill reconciler, an auditor asking
 * "who did what". It duplicates the digest's metadata on purpose: the manifest
 * has to stand alone once the projection rows that produced it are gone.
 *
 * Pure: takes plain data, returns a JSON string. Timestamps come in from the
 * caller because this repo bans ambient clock reads in pure modules.
 */
import type { SessionArchiveRawTranscript } from "@t3tools/contracts";

import type { HistoryGitState } from "./historyMarkdown.ts";

/** Bumped when a field changes meaning, so old manifests stay parseable. */
export const SESSION_MANIFEST_SCHEMA_VERSION = 1;

export interface ManifestMessageSender {
  readonly userId: string | null;
  readonly role: string;
  readonly messageCount: number;
}

export interface ManifestFileEntry {
  readonly name: string;
  readonly bytes: number | null;
}

export interface SessionManifestInput {
  readonly threadId: string;
  readonly title: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly workspaceRoot: string;
  readonly worktreePath: string | null;
  readonly branch: string | null;
  readonly providerInstanceId: string | null;
  readonly model: string | null;
  readonly ownerUserId: string | null;
  readonly createdAt: string | null;
  readonly archivedAt: string | null;
  /** Non-null when this session was soft-deleted rather than archived. */
  readonly deletedAt: string | null;
  readonly exportedAt: string;
  readonly linearIssueUrl: string | null;
  readonly parentThreadId: string | null;
  readonly messageCount: number;
  readonly activityCount: number;
  readonly messageSenders: ReadonlyArray<ManifestMessageSender>;
  readonly git: HistoryGitState | null;
  readonly reclaimNote: string | null;
  readonly files: ReadonlyArray<ManifestFileEntry>;
  readonly rawTranscripts: ReadonlyArray<SessionArchiveRawTranscript>;
}

/**
 * Who sent what, aggregated from the message stream.
 *
 * Assistant messages carry a null sender; they are grouped under the role so
 * the manifest still answers "how much of this thread was the agent".
 */
export function summarizeMessageSenders(
  messages: ReadonlyArray<{ readonly role: string; readonly sentByUserId: string | null }>,
): ReadonlyArray<ManifestMessageSender> {
  const counts = new Map<string, ManifestMessageSender>();
  for (const message of messages) {
    const key = `${message.role}\0${message.sentByUserId ?? ""}`;
    const existing = counts.get(key);
    if (existing === undefined) {
      counts.set(key, {
        userId: message.sentByUserId,
        role: message.role,
        messageCount: 1,
      });
    } else {
      counts.set(key, { ...existing, messageCount: existing.messageCount + 1 });
    }
  }
  return [...counts.values()].sort(
    (left, right) =>
      right.messageCount - left.messageCount ||
      left.role.localeCompare(right.role) ||
      (left.userId ?? "").localeCompare(right.userId ?? ""),
  );
}

/** Render the manifest. Key order is fixed by construction for stable diffs. */
export function renderSessionManifest(input: SessionManifestInput): string {
  return `${JSON.stringify(
    {
      schemaVersion: SESSION_MANIFEST_SCHEMA_VERSION,
      threadId: input.threadId,
      title: input.title,
      project: {
        id: input.projectId,
        name: input.projectName,
        workspaceRoot: input.workspaceRoot,
      },
      worktreePath: input.worktreePath,
      branch: input.branch,
      provider: {
        instanceId: input.providerInstanceId,
        model: input.model,
      },
      ownerUserId: input.ownerUserId,
      createdAt: input.createdAt,
      archivedAt: input.archivedAt,
      deletedAt: input.deletedAt,
      deleted: input.deletedAt !== null,
      exportedAt: input.exportedAt,
      linearIssueUrl: input.linearIssueUrl,
      parentThreadId: input.parentThreadId,
      messageCount: input.messageCount,
      activityCount: input.activityCount,
      messageSenders: input.messageSenders,
      git: input.git,
      reclaimNote: input.reclaimNote,
      files: input.files,
      rawTranscripts: input.rawTranscripts,
    },
    null,
    2,
  )}\n`;
}
