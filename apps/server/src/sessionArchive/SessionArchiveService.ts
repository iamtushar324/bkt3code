/**
 * T3-CUSTOM(expbkt3): Reclaim archived sessions' worktrees, keeping their history.
 *
 * Upstream removes a worktree only when a thread is *deleted*, so the only way
 * to reclaim disk is to destroy the record of the work. This service adds the
 * middle path: write the session's history somewhere durable outside the
 * worktree, verify that write landed, and only then give the space back.
 *
 * The ordering is the whole safety argument. Export before delete, always, and
 * a failed export aborts that session's reclaim rather than proceeding.
 */
import {
  CommandId,
  OrchestrationV2AppThreadJson,
  type ProviderDriverKind,
  SessionArchiveError,
  type ModelSelection,
  type ProjectId,
  type SessionArchiveBackfillInput,
  type SessionArchiveBackfillResult,
  type SessionArchiveEntry,
  type SessionArchiveExportResult,
  type SessionArchiveExportedFile,
  type SessionArchiveOrphanedWorktree,
  type SessionArchiveRawTranscript,
  type SessionArchiveReclaimInput,
  type SessionArchiveReclaimMode,
  type SessionArchiveReclaimOutcome,
  type SessionArchiveReclaimResult,
  type SessionArchiveScanResult,
  type OrchestrationThreadShell,
  type ThreadContextExportResult,
  type ThreadId,
} from "@t3tools/contracts";
import * as NodeOS from "node:os";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { ProjectionStoreV2 } from "../orchestration-v2/ProjectionStore.ts";
import { ProjectStoreV2 } from "../orchestration-v2/ProjectStore.ts";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import { ServerConfig } from "../config.ts";
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import { OrchestrationEngineService } from "../orchestration-v2/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration-v2/Services/ProjectionSnapshotQuery.ts";
import { expandHomePath } from "../pathExpansion.ts";

import { resolveClaudeHomePath } from "../provider/Drivers/ClaudeHome.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import {
  DEFAULT_SESSION_HISTORY_DIRNAME,
  SESSION_HISTORY_README_FILENAME,
  sessionHistoryPaths,
} from "./archivePaths.ts";
import { renderThreadContextDigest } from "./contextDigest.ts";
import {
  readSlimTrackedPathInventory,
  readWorktreeGitFacts,
  UNKNOWN_GIT_FACTS,
} from "./gitFacts.ts";
import {
  renderSessionManifest,
  summarizeMessageSenders,
  type ManifestFileEntry,
} from "./manifest.ts";
import {
  claudeProjectsDir,
  claudeTranscriptCandidate,
  codexSessionsDir,
  copyFileGzipped,
  findCodexRolloutFiles,
  parseResumeSessionId,
  parseRuntimeCwd,
} from "./providerTranscripts.ts";
import {
  renderSessionHistoryDigest,
  renderSessionHistoryIndex,
  renderSessionHistoryReadme,
  toOneLineSummary,
  type SessionHistoryIndexEntry,
} from "./historyMarkdown.ts";
import { collectWorktreeUsage, serverOwnedWorktrees } from "./liveWorktrees.ts";
import {
  describeBlockedReason,
  evaluateReclaimEligibility,
  isWorktreeProtected,
} from "./reclaimEligibility.ts";
import { scanWorktree, slimWorktree } from "./worktreeScan.ts";

/**
 * Worktrees sized per scan before the rest report a null size.
 *
 * The panel is worth nothing without sizes, and sizing everything is worth a
 * multi-minute IO storm on a shared box. Bounding it keeps the common case —
 * an operator looking at their largest archived sessions — fast, and the
 * `sizingIncomplete` flag keeps the result honest about what was skipped.
 */
const SIZED_ENTRY_LIMIT = 60;

/** Worktrees sized concurrently. Deliberately small: this host shares its IO. */
const SIZING_CONCURRENCY = 2;

export interface SessionArchiveServiceShape {
  readonly scan: () => Effect.Effect<SessionArchiveScanResult, SessionArchiveError>;
  readonly exportHistory: (
    threadIds: ReadonlyArray<ThreadId>,
  ) => Effect.Effect<SessionArchiveExportResult, SessionArchiveError>;
  readonly reclaim: (
    input: SessionArchiveReclaimInput,
  ) => Effect.Effect<SessionArchiveReclaimResult, SessionArchiveError>;
  // T3-CUSTOM(expbkt3): render a handoff digest for a live or archived thread.
  // Pure read — nothing is written to the history directory.
  readonly exportContext: (
    threadId: ThreadId,
  ) => Effect.Effect<ThreadContextExportResult, SessionArchiveError>;
  /** Retention-gated batch used by the sweeper; returns what it reclaimed. */
  readonly sweep: (input: {
    readonly mode: SessionArchiveReclaimMode;
    readonly minArchivedDays: number;
  }) => Effect.Effect<SessionArchiveReclaimResult, SessionArchiveError>;
  // T3-CUSTOM(expbkt3): one-shot export of every archived or soft-deleted
  // session that has no history file yet. Soft-deleted threads are reachable
  // only through this path — the snapshots the other methods read exclude them.
  readonly backfill: (
    input: SessionArchiveBackfillInput,
  ) => Effect.Effect<SessionArchiveBackfillResult, SessionArchiveError>;
}

export class SessionArchiveService extends Context.Service<
  SessionArchiveService,
  SessionArchiveServiceShape
>()("t3/sessionArchive/SessionArchiveService") {}

const fail = (operation: string, cause: unknown) =>
  new SessionArchiveError({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
  });

/**
 * The fields an export actually reads, decoupled from the snapshot shell.
 *
 * The backfill feeds raw projection rows through the export — including
 * soft-deleted threads, which no snapshot ever surfaces — so the export cannot
 * demand a full `OrchestrationThreadShell`.
 */
interface ArchiveExportSource {
  readonly id: ThreadId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly modelSelection: ModelSelection;
  readonly ownerUserId: string | null;
  readonly createdAt: string;
  readonly archivedAt: string | null;
  readonly deletedAt: string | null;
  readonly linearIssueUrl: string | null;
  readonly parentThreadId: string | null;
}

function shellToExportSource(thread: OrchestrationThreadShell): ArchiveExportSource {
  return {
    id: thread.id,
    projectId: thread.projectId,
    title: thread.title,
    branch: thread.branch,
    worktreePath: thread.worktreePath,
    modelSelection: thread.modelSelection,
    ownerUserId: thread.ownerUserId,
    createdAt: thread.createdAt,
    archivedAt: thread.archivedAt,
    // Snapshots never contain soft-deleted threads.
    deletedAt: null,
    linearIssueUrl: thread.linearIssueUrl ?? null,
    parentThreadId: thread.parentThreadId ?? null,
  };
}

function rowToExportSource(row: OrchestrationV2AppThreadJson): ArchiveExportSource {
  return {
    id: row.id,
    projectId: row.projectId,
    title: row.title,
    branch: row.branch,
    worktreePath: row.worktreePath,
    modelSelection: row.modelSelection,
    ownerUserId: row.ownerUserId ?? null,
    createdAt: DateTime.formatIso(row.createdAt),
    archivedAt: row.archivedAt === null ? null : DateTime.formatIso(row.archivedAt),
    deletedAt: row.deletedAt === null ? null : DateTime.formatIso(row.deletedAt),
    linearIssueUrl: row.linearIssueUrl ?? null,
    parentThreadId: row.parentThreadId ?? null,
  };
}

/** Project names and roots an export renders into the digest and manifest. */
interface ArchiveExportContext {
  readonly projectNames: ReadonlyMap<ProjectId, string>;
  readonly projectRoots: ReadonlyMap<ProjectId, string>;
}

/**
 * Services the helpers below reach for lazily — the filesystem walk, the atomic
 * writes, and the git reads. They are captured once and re-provided to every
 * effect this service hands out, so the public shape stays requirement-free.
 */
type SessionArchivePlatform = FileSystem.FileSystem | Path.Path | GitVcsDriver.GitVcsDriver;

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const settingsService = yield* ServerSettingsService;
  const snapshots = yield* ProjectionSnapshotQuery;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const nativeProjection = yield* ProjectionStoreV2;
  const projectStore = yield* ProjectStoreV2;
  const sql = yield* SqlClient.SqlClient;
  const decodeNativeThread = Schema.decodeUnknownEffect(
    Schema.fromJsonString(OrchestrationV2AppThreadJson),
  );
  const messages = {
    listByThreadId: ({ threadId }: { readonly threadId: ThreadId }) =>
      snapshots
        .getThreadDetailById(threadId)
        .pipe(Effect.map((detail) => (Option.isSome(detail) ? detail.value.messages : []))),
  };
  const activities = {
    listByThreadId: ({ threadId }: { readonly threadId: ThreadId }) =>
      snapshots
        .getThreadDetailById(threadId)
        .pipe(Effect.map((detail) => (Option.isSome(detail) ? detail.value.activities : []))),
  };
  const threadRows = {
    listArchivedOrDeleted: () =>
      sql<{
        readonly payload_json: string;
      }>`SELECT payload_json FROM orchestration_v2_projection_threads`.pipe(
        Effect.flatMap((rows) =>
          Effect.forEach(rows, (row) => decodeNativeThread(row.payload_json)),
        ),
        Effect.map((threads) =>
          threads.filter((thread) => thread.archivedAt !== null || thread.deletedAt !== null),
        ),
      ),
  };
  const providerRuntime = {
    getByThreadId: ({ threadId }: { readonly threadId: ThreadId }) =>
      nativeProjection.getThreadRecords(threadId, ["providerThreads", "providerSessions"]).pipe(
        Effect.map((records) => {
          const nativeThread =
            records.providerThreads.findLast((thread) => thread.ownerNodeId === null) ??
            records.providerThreads.at(-1);
          if (
            nativeThread === undefined ||
            nativeThread.nativeThreadRef === null ||
            nativeThread.nativeThreadRef.nativeId === null
          )
            return Option.none();
          const session = records.providerSessions.find(
            (session) => session.id === nativeThread.providerSessionId,
          );
          const providerName: ProviderDriverKind = nativeThread.driver;
          return Option.some({
            providerName,
            resumeCursor: {
              threadId: nativeThread.nativeThreadRef.nativeId,
              resume: nativeThread.nativeThreadRef.nativeId,
              sessionId: nativeThread.nativeThreadRef.nativeId,
            },
            runtimePayload: { cwd: session?.cwd ?? null },
          });
        }),
      ),
  };
  const gitWorkflow = yield* GitWorkflowService;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* Effect.context<SessionArchivePlatform>();

  const withPlatform = <A, E>(effect: Effect.Effect<A, E, SessionArchivePlatform>) =>
    effect.pipe(Effect.provideContext(platform));

  /** Configured override, or `<baseDir>/session-history`. */
  const resolveHistoryDir = Effect.gen(function* () {
    const settings = yield* settingsService.getSettings;
    const configured = settings.experimental.sessionArchive.historyDir.trim();
    return configured.length > 0
      ? configured
      : path.join(config.baseDir, DEFAULT_SESSION_HISTORY_DIRNAME);
  });

  /**
   * Everything a decision or an export needs, read once.
   *
   * Archived threads come from the archive-specific query, but the *usage*
   * sets are built from the full snapshot: a live worktree has to be protected
   * whether or not its thread is archived.
   */
  const readContext = Effect.gen(function* () {
    const [archived, full] = yield* Effect.all([
      snapshots.getArchivedShellSnapshot(),
      snapshots.getShellSnapshot(),
    ]);

    const usage = collectWorktreeUsage([...full.threads, ...archived.threads]);
    const serverOwned = serverOwnedWorktrees({
      serverCwd: config.cwd,
      worktreesDir: config.worktreesDir,
    });
    const liveWorktreePaths = new Set([...usage.liveWorktreePaths, ...serverOwned]);

    const projectNames = new Map<ProjectId, string>();
    for (const project of [...full.projects, ...archived.projects]) {
      projectNames.set(project.id, project.title);
    }

    return {
      archivedThreads: archived.threads,
      liveWorktreePaths,
      activeThreadWorktreePaths: usage.activeThreadWorktreePaths,
      projectNames,
      projectRoots: new Map(
        [...full.projects, ...archived.projects].map(
          (project) => [project.id, project.workspaceRoot] as const,
        ),
      ),
    };
  });

  /**
   * Re-read just the two protection sets, as late as possible.
   *
   * A batch reclaim runs sequentially and each entry is heavy IO, so the sets
   * captured when the batch started can be minutes stale by the time a given
   * worktree is actually deleted — long enough for someone to unarchive a
   * session or start one on that worktree. This is cheap next to the delete it
   * guards, so it runs immediately before every destructive step.
   */
  const readWorktreeUsage = Effect.gen(function* () {
    const [archived, full] = yield* Effect.all([
      snapshots.getArchivedShellSnapshot(),
      snapshots.getShellSnapshot(),
    ]);
    const usage = collectWorktreeUsage([...full.threads, ...archived.threads]);
    const serverOwned = serverOwnedWorktrees({
      serverCwd: config.cwd,
      worktreesDir: config.worktreesDir,
    });
    return {
      liveWorktreePaths: new Set([...usage.liveWorktreePaths, ...serverOwned]),
      activeThreadWorktreePaths: usage.activeThreadWorktreePaths,
    };
  });

  /**
   * Git facts for a worktree, or the pessimistic default.
   *
   * A worktree that is already gone is reported as `null` so callers can
   * distinguish "nothing to reclaim" from "we could not tell".
   */
  const readGitFacts = (worktreePath: string | null) =>
    Effect.gen(function* () {
      if (worktreePath === null) {
        return null;
      }
      const exists = yield* fs.exists(worktreePath).pipe(Effect.orElseSucceed(() => false));
      if (!exists) {
        return null;
      }
      return yield* readWorktreeGitFacts(worktreePath).pipe(
        Effect.orElseSucceed(() => UNKNOWN_GIT_FACTS),
      );
    });

  /**
   * A slim must prove the tracked state of each target directory. Start with
   * an unfiltered walk only to discover candidates, then ask Git about those
   * candidates rather than buffering the entire repository inventory.
   */
  const scanSlimWorktree = Effect.fn("SessionArchive.scanSlimWorktree")(function* (
    worktreePath: string,
  ) {
    const discovered = yield* scanWorktree({ worktreePath, trackedPaths: new Set() });
    const inventory = yield* readSlimTrackedPathInventory({
      worktreePath,
      candidatePaths: discovered.slimCandidates.map((candidate) => candidate.relativePath),
    });
    if (inventory.state === "unknown") {
      return { state: "unknown" as const };
    }
    return {
      state: "complete" as const,
      sized: yield* scanWorktree({ worktreePath, trackedPaths: inventory.trackedPaths }),
    };
  });

  const digestPathFor = (historyDir: string, source: ArchiveExportSource, projectName: string) =>
    sessionHistoryPaths({
      historyDir,
      projectName,
      threadId: source.id,
      title: source.title,
      // Deleted-but-never-archived threads date under their deletion.
      archivedAt: source.archivedAt ?? source.deletedAt ?? source.createdAt,
    });

  /**
   * Worktree directories on disk that no thread references.
   *
   * Reported, never reclaimed. On the box this was written for these are the
   * majority of the directories, and nothing in the database can say what is
   * safe about any of them.
   */
  const findOrphanedWorktrees = (archivedThreads: ReadonlyArray<OrchestrationThreadShell>) =>
    Effect.gen(function* () {
      const known = new Set<string>();
      const full = yield* snapshots.getShellSnapshot();
      for (const thread of [...full.threads, ...archivedThreads]) {
        if (thread.worktreePath !== null) {
          known.add(thread.worktreePath.trim());
        }
      }

      const projectDirs = yield* fs
        .readDirectory(config.worktreesDir)
        .pipe(Effect.orElseSucceed(() => []));

      const orphans: Array<SessionArchiveOrphanedWorktree> = [];
      for (const projectDir of projectDirs) {
        const absoluteProjectDir = path.join(config.worktreesDir, projectDir);
        const worktreeNames = yield* fs
          .readDirectory(absoluteProjectDir)
          .pipe(Effect.orElseSucceed(() => []));
        for (const name of worktreeNames) {
          const worktreePath = path.join(absoluteProjectDir, name);
          if (known.has(worktreePath)) {
            continue;
          }
          const info = yield* fs.stat(worktreePath).pipe(Effect.option);
          if (info._tag === "None" || info.value.type !== "Directory") {
            continue;
          }
          orphans.push({
            worktreePath,
            // Sizing every orphan is exactly the IO storm this feature exists
            // to avoid; the panel offers sizing on demand instead.
            sizeBytes: null,
            lastModifiedAt: formatOptionalDate(info.value.mtime),
          });
        }
      }
      return orphans;
    });

  /**
   * Rewrite a project's index with this entry merged in.
   *
   * Parsed back out of the existing file rather than kept in a sidecar state
   * file: the index is the durable record, and a re-export has to update its
   * row in place rather than appending a duplicate.
   */
  const refreshProjectIndex = (input: {
    readonly projectDir: string;
    readonly indexPath: string;
    readonly projectName: string;
    readonly entry: SessionHistoryIndexEntry;
  }) =>
    Effect.gen(function* () {
      const existing = yield* fs
        .readFileString(input.indexPath)
        .pipe(Effect.orElseSucceed(() => ""));
      const parsed = parseIndexRows(existing).filter(
        (row) => row.fileName !== input.entry.fileName,
      );
      const merged = [...parsed, input.entry];
      yield* writeFileStringAtomically({
        filePath: input.indexPath,
        contents: renderSessionHistoryIndex(input.projectName, merged),
      });
    });

  const writeReadmeOnce = (historyDir: string) =>
    Effect.gen(function* () {
      const readmePath = path.join(historyDir, SESSION_HISTORY_README_FILENAME);
      const exists = yield* fs.exists(readmePath).pipe(Effect.orElseSucceed(() => false));
      if (exists) {
        return;
      }
      yield* writeFileStringAtomically({
        filePath: readmePath,
        contents: renderSessionHistoryReadme(),
      });
    });

  /**
   * Copy the provider CLI's own transcript files into the archive, gzipped.
   *
   * Best-effort by design: a session whose provider files were pruned, or
   * whose cursor never resolved, still exports everything else. Every attempt
   * is recorded so the manifest can say what was and was not preserved.
   *
   * Home directories come from the default provider settings; per-instance
   * home overrides are rare enough here that the os home fallback covers them.
   */
  const copyProviderTranscripts = (source: ArchiveExportSource, rawDir: string) =>
    Effect.gen(function* () {
      const runtimeOption = yield* providerRuntime
        .getByThreadId({ threadId: source.id })
        .pipe(Effect.orElseSucceed(() => Option.none()));
      if (Option.isNone(runtimeOption)) {
        return [] as ReadonlyArray<SessionArchiveRawTranscript>;
      }
      const runtime = runtimeOption.value;
      const sessionId = parseResumeSessionId(runtime.providerName, runtime.resumeCursor);
      if (sessionId === null) {
        return [] as ReadonlyArray<SessionArchiveRawTranscript>;
      }

      const settings = yield* settingsService.getSettings;
      const osHome = NodeOS.homedir();

      const sourcePaths: Array<string> = [];
      if (runtime.providerName === "claudeAgent") {
        const claudeSettings = settings.providers.claudeAgent;
        const configuredHome =
          claudeSettings.homePath.trim().length > 0
            ? yield* resolveClaudeHomePath(claudeSettings)
            : null;
        const cwd = parseRuntimeCwd(runtime.runtimePayload) ?? source.worktreePath;
        if (cwd !== null) {
          sourcePaths.push(
            claudeTranscriptCandidate({
              projectsDir: claudeProjectsDir(configuredHome, osHome),
              cwd,
              sessionId,
            }),
          );
        }
      } else if (runtime.providerName === "codex") {
        const codexHomePath = settings.providers.codex.homePath.trim();
        const configuredHome =
          codexHomePath.length > 0 ? path.resolve(expandHomePath(codexHomePath)) : null;
        const sessionsDir = codexSessionsDir(configuredHome, osHome);
        const found = yield* findCodexRolloutFiles({ sessionsDir, sessionId });
        if (found.length === 0) {
          return [
            {
              provider: runtime.providerName,
              sourcePath: `${sessionsDir}/**/*${sessionId}*.jsonl`,
              archivedPath: null,
              status: "missing",
            },
          ] as ReadonlyArray<SessionArchiveRawTranscript>;
        }
        sourcePaths.push(...found);
      } else {
        return [] as ReadonlyArray<SessionArchiveRawTranscript>;
      }

      const results: Array<SessionArchiveRawTranscript> = [];
      for (const sourcePath of sourcePaths) {
        const exists = yield* fs.exists(sourcePath).pipe(Effect.orElseSucceed(() => false));
        if (!exists) {
          results.push({
            provider: runtime.providerName,
            sourcePath,
            archivedPath: null,
            status: "missing",
          });
          continue;
        }
        const targetPath = `${rawDir}/${path.basename(sourcePath)}.gz`;
        const copied = yield* copyFileGzipped({ sourcePath, targetPath }).pipe(
          Effect.as(true),
          Effect.catchCause((cause) =>
            Effect.logWarning("session archive could not copy a provider transcript", {
              threadId: source.id,
              sourcePath,
              cause: describeCause(cause),
            }).pipe(Effect.as(false)),
          ),
        );
        results.push(
          copied
            ? {
                provider: runtime.providerName,
                sourcePath,
                archivedPath: targetPath,
                status: "copied",
              }
            : { provider: runtime.providerName, sourcePath, archivedPath: null, status: "missing" },
        );
      }
      return results as ReadonlyArray<SessionArchiveRawTranscript>;
    });

  /** Byte sizes for the manifest's file inventory; null when unreadable. */
  const statBytes = (filePath: string) =>
    fs.stat(filePath).pipe(
      Effect.map((info) => Number(info.size)),
      Effect.orElseSucceed((): number | null => null),
    );

  /** Write one session's digest, sidecars, manifest, and raw transcripts. */
  const exportThread = (
    source: ArchiveExportSource,
    reclaimNote: string | null,
    context: ArchiveExportContext,
  ) =>
    Effect.gen(function* () {
      const historyDir = yield* resolveHistoryDir;
      const settings = yield* settingsService.getSettings;
      const archiveSettings = settings.experimental.sessionArchive;
      const includeSidecar = archiveSettings.includeTranscriptSidecar;
      const includeActivities = archiveSettings.includeActivities;
      const includeRawTranscripts = archiveSettings.includeRawProviderTranscripts;

      const projectName = context.projectNames.get(source.projectId) ?? "unknown-project";
      const paths = digestPathFor(historyDir, source, projectName);

      const [threadMessages, git, threadActivities] = yield* Effect.all([
        messages.listByThreadId({ threadId: source.id }),
        readGitFacts(source.worktreePath),
        includeActivities ? activities.listByThreadId({ threadId: source.id }) : Effect.succeed([]),
      ]);

      // T3-CUSTOM(expbkt3): catch-up summaries were retired; digests carry none.
      const rollingSummary = null;

      const gitState =
        git === null
          ? null
          : {
              branch: git.branch ?? source.branch,
              baseRef: git.baseRef,
              headSha: git.headSha,
              hasUncommittedChanges: git.hasUncommittedChanges,
              hasUntrackedFiles: git.hasUntrackedFiles,
              hasUnpushedCommits: git.hasUnpushedCommits,
              changedFiles: git.changedFiles,
            };

      const digest = renderSessionHistoryDigest({
        threadId: source.id,
        title: source.title,
        projectName,
        workspaceRoot: context.projectRoots.get(source.projectId) ?? "",
        worktreePath: source.worktreePath,
        providerInstanceId: source.modelSelection.instanceId,
        model: source.modelSelection.model,
        createdAt: source.createdAt,
        archivedAt: source.archivedAt,
        rollingSummary,
        turnSummaries: [],
        userPrompts: threadMessages
          .filter((message) => message.role === "user")
          .map((message) => ({ text: message.text, createdAt: message.createdAt })),
        git: gitState,
        messageCount: threadMessages.length,
        transcriptFileName: includeSidecar ? path.basename(paths.transcriptPath) : null,
        reclaimNote,
      });

      yield* writeFileStringAtomically({ filePath: paths.digestPath, contents: digest });

      if (includeSidecar) {
        const transcript = threadMessages
          .map((message) =>
            JSON.stringify({
              messageId: message.id,
              turnId: message.turnId,
              role: message.role,
              text: message.text,
              sentByUserId: message.sentByUserId,
              createdAt: message.createdAt,
            }),
          )
          .join("\n");
        yield* writeFileStringAtomically({
          filePath: paths.transcriptPath,
          contents: transcript.length > 0 ? `${transcript}\n` : "",
        });
      }

      let activitiesPath: string | null = null;
      if (includeActivities && threadActivities.length > 0) {
        const activityLines = threadActivities
          .map((activity) =>
            JSON.stringify({
              activityId: activity.id,
              turnId: activity.turnId,
              kind: activity.kind,
              tone: activity.tone,
              summary: activity.summary,
              payload: activity.payload,
              createdAt: activity.createdAt,
            }),
          )
          .join("\n");
        yield* writeFileStringAtomically({
          filePath: paths.activitiesPath,
          contents: `${activityLines}\n`,
        });
        activitiesPath = paths.activitiesPath;
      }

      const rawTranscripts = includeRawTranscripts
        ? yield* copyProviderTranscripts(source, paths.rawDir)
        : [];

      // The manifest is written last so its file inventory reflects what
      // actually landed on disk, sizes included.
      const inventoryPaths = [
        paths.digestPath,
        ...(includeSidecar ? [paths.transcriptPath] : []),
        ...(activitiesPath !== null ? [activitiesPath] : []),
        ...rawTranscripts.flatMap((raw) => (raw.archivedPath !== null ? [raw.archivedPath] : [])),
      ];
      const files: Array<ManifestFileEntry> = [];
      for (const filePath of inventoryPaths) {
        files.push({ name: path.basename(filePath), bytes: yield* statBytes(filePath) });
      }

      const exportedAt = DateTime.formatIso(yield* DateTime.now);
      yield* writeFileStringAtomically({
        filePath: paths.manifestPath,
        contents: renderSessionManifest({
          threadId: source.id,
          title: source.title,
          projectId: source.projectId,
          projectName,
          workspaceRoot: context.projectRoots.get(source.projectId) ?? "",
          worktreePath: source.worktreePath,
          branch: git?.branch ?? source.branch,
          providerInstanceId: source.modelSelection.instanceId,
          model: source.modelSelection.model,
          ownerUserId: source.ownerUserId,
          createdAt: source.createdAt,
          archivedAt: source.archivedAt,
          deletedAt: source.deletedAt,
          exportedAt,
          linearIssueUrl: source.linearIssueUrl,
          parentThreadId: source.parentThreadId,
          messageCount: threadMessages.length,
          activityCount: threadActivities.length,
          messageSenders: summarizeMessageSenders(threadMessages),
          git: gitState,
          reclaimNote,
          files,
          rawTranscripts,
        }),
      });

      yield* refreshProjectIndex({
        projectDir: paths.projectDir,
        indexPath: paths.indexPath,
        projectName,
        entry: {
          fileName: path.basename(paths.digestPath),
          title: source.title,
          archivedAt: source.archivedAt ?? source.deletedAt,
          branch: git?.branch ?? source.branch,
          oneLineSummary: toOneLineSummary(rollingSummary),
        },
      });

      yield* writeReadmeOnce(historyDir);

      return {
        threadId: source.id,
        digestPath: paths.digestPath,
        transcriptPath: includeSidecar ? paths.transcriptPath : null,
        messageCount: threadMessages.length,
        activitiesPath,
        manifestPath: paths.manifestPath,
        rawTranscripts,
      } satisfies SessionArchiveExportedFile;
    });

  /**
   * Render the handoff digest for one thread, live or archived.
   *
   * Deliberately writes nothing: the caller pastes the digest into a clipboard
   * or a new thread's composer, and a read should never mutate the history
   * directory as a side effect.
   */
  const exportContext = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const liveOption = yield* snapshots.getThreadShellById(threadId);
      let thread: OrchestrationThreadShell;
      if (Option.isSome(liveOption)) {
        thread = liveOption.value;
      } else {
        const archived = yield* snapshots.getArchivedShellSnapshot();
        const match = archived.threads.find((candidate) => candidate.id === threadId);
        if (match === undefined) {
          return yield* new SessionArchiveError({
            operation: "context-export",
            message: "No session with this id.",
          });
        }
        thread = match;
      }

      const context = yield* readContext;
      const projectName = context.projectNames.get(thread.projectId) ?? "unknown-project";

      const [threadMessages, git] = yield* Effect.all([
        messages.listByThreadId({ threadId: thread.id }),
        readGitFacts(thread.worktreePath),
      ]);

      const digest = renderThreadContextDigest({
        threadId: thread.id,
        title: thread.title,
        projectName,
        workspaceRoot: context.projectRoots.get(thread.projectId) ?? "",
        worktreePath: thread.worktreePath,
        branch: git?.branch ?? thread.branch,
        providerInstanceId: thread.modelSelection.instanceId,
        model: thread.modelSelection.model,
        createdAt: thread.createdAt,
        git:
          git === null
            ? null
            : {
                branch: git.branch ?? thread.branch,
                baseRef: git.baseRef,
                headSha: git.headSha,
                hasUncommittedChanges: git.hasUncommittedChanges,
                hasUntrackedFiles: git.hasUntrackedFiles,
                hasUnpushedCommits: git.hasUnpushedCommits,
                changedFiles: git.changedFiles,
              },
        messages: threadMessages.map((message) => ({
          role: message.role,
          text: message.text,
          createdAt: message.createdAt,
        })),
      });

      return {
        threadId: thread.id,
        projectId: thread.projectId,
        title: thread.title,
        markdown: digest.markdown,
        messageCount: threadMessages.length,
        truncated: digest.truncated,
      } satisfies ThreadContextExportResult;
    }).pipe(
      Effect.mapError((cause) =>
        cause._tag === "SessionArchiveError" ? cause : fail("context-export", cause),
      ),
    );

  const scan = () =>
    Effect.gen(function* () {
      const historyDir = yield* resolveHistoryDir;
      const context = yield* readContext;
      const now = yield* DateTime.now;
      const nowMs = DateTime.toEpochMillis(now);

      // Largest-first would need sizes we do not have yet, so order by recency
      // of archiving: the sessions an operator is most likely to act on.
      const ordered = [...context.archivedThreads].sort((left, right) =>
        (right.archivedAt ?? "").localeCompare(left.archivedAt ?? ""),
      );

      let sizedCount = 0;
      let sizingIncomplete = false;

      const entries = yield* Effect.forEach(
        ordered,
        (thread) =>
          Effect.gen(function* () {
            const projectName = context.projectNames.get(thread.projectId) ?? "unknown-project";
            const git = yield* readGitFacts(thread.worktreePath);

            // Evaluated per mode: `remove` gates harder than `slim`, and the
            // panel needs to say which of its two buttons will actually run.
            const gateInput = {
              thread: {
                threadId: thread.id,
                worktreePath: thread.worktreePath,
                archivedAt: thread.archivedAt,
              },
              git,
              liveWorktreePaths: context.liveWorktreePaths,
              activeThreadWorktreePaths: context.activeThreadWorktreePaths,
              minArchivedDays: 0,
              nowMs,
              force: false,
              worktreesDir: config.worktreesDir,
            } as const;
            const eligibility = evaluateReclaimEligibility({ ...gateInput, mode: "slim" });
            const removeEligibility = evaluateReclaimEligibility({
              ...gateInput,
              mode: "remove",
            });

            const shouldSize =
              git !== null && eligibility.eligible && sizedCount < SIZED_ENTRY_LIMIT;
            if (git !== null && eligibility.eligible && !shouldSize) {
              sizingIncomplete = true;
            }
            if (shouldSize) {
              sizedCount += 1;
            }

            const slimScan = shouldSize
              ? yield* scanSlimWorktree(thread.worktreePath ?? "").pipe(
                  Effect.orElseSucceed(() => ({ state: "unknown" as const })),
                )
              : null;
            const sized = slimScan?.state === "complete" ? slimScan.sized : null;
            if (slimScan?.state === "unknown") {
              sizingIncomplete = true;
            }

            if (sized?.budgetExhausted === true) {
              sizingIncomplete = true;
            }

            const paths = digestPathFor(historyDir, shellToExportSource(thread), projectName);
            const digestExists = yield* fs
              .exists(paths.digestPath)
              .pipe(Effect.orElseSucceed(() => false));

            const reclaimState: SessionArchiveEntry["reclaimState"] =
              thread.worktreePath === null
                ? "removed"
                : git === null
                  ? "missing"
                  : sized !== null && sized.slimCandidates.length === 0
                    ? "slimmed"
                    : "present";

            return {
              threadId: thread.id,
              projectId: thread.projectId,
              projectName,
              title: thread.title,
              branch: thread.branch,
              worktreePath: thread.worktreePath,
              archivedAt: thread.archivedAt,
              worktreeBytes: sized?.totalBytes ?? null,
              reclaimableBytes: sized?.reclaimableBytes ?? null,
              reclaimState,
              blockedReason: eligibility.blockedReason,
              removeBlockedReason: removeEligibility.blockedReason,
              historyPath: digestExists ? paths.digestPath : null,
            } satisfies SessionArchiveEntry;
          }),
        { concurrency: SIZING_CONCURRENCY },
      );

      const orphanedWorktrees = yield* findOrphanedWorktrees(context.archivedThreads);

      return {
        scannedAt: DateTime.formatIso(now),
        entries,
        orphanedWorktrees,
        totalReclaimableBytes: entries.reduce(
          (total, entry) =>
            total + (entry.blockedReason === null ? (entry.reclaimableBytes ?? 0) : 0),
          0,
        ),
        historyDir,
        sizingIncomplete,
      } satisfies SessionArchiveScanResult;
    }).pipe(Effect.mapError((cause) => fail("scan", cause)));

  // Runs on every archive, so it reads only the named sessions and their
  // projects, never the full active and archived shell snapshots.
  const exportHistory = (threadIds: ReadonlyArray<ThreadId>) =>
    Effect.gen(function* () {
      const results = yield* Effect.forEach(
        threadIds,
        (threadId) =>
          Effect.gen(function* () {
            const thread = Option.getOrUndefined(yield* snapshots.getThreadShellById(threadId));
            if (thread === undefined || thread.archivedAt === null) {
              return {
                _tag: "failure" as const,
                threadId,
                message: "No archived session with this id.",
              };
            }
            const projects = yield* projectStore.listShells({ projectIds: [thread.projectId] });
            const context: ArchiveExportContext = {
              projectNames: new Map(projects.map((project) => [project.id, project.title])),
              projectRoots: new Map(projects.map((project) => [project.id, project.workspaceRoot])),
            };
            const exported = yield* exportThread(shellToExportSource(thread), null, context);
            return { _tag: "success" as const, exported };
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.succeed({
                _tag: "failure" as const,
                threadId,
                message: describeCause(cause),
              }),
            ),
          ),
        { concurrency: 2 },
      );

      return {
        exported: results.flatMap((result) => (result._tag === "success" ? [result.exported] : [])),
        failures: results.flatMap((result) =>
          result._tag === "failure" ? [{ threadId: result.threadId, message: result.message }] : [],
        ),
      } satisfies SessionArchiveExportResult;
    }).pipe(Effect.mapError((cause) => fail("export", cause)));

  /**
   * Reclaim one session.
   *
   * The export is not best-effort: if it throws, or lands an empty digest, this
   * returns without touching the worktree. Losing a session's record to free
   * disk is the one outcome the whole feature exists to prevent.
   */
  const reclaimThread = (input: {
    readonly thread: OrchestrationThreadShell;
    readonly mode: SessionArchiveReclaimMode;
    readonly force: boolean;
    readonly minArchivedDays: number;
    readonly nowMs: number;
    readonly liveWorktreePaths: ReadonlySet<string>;
    readonly activeThreadWorktreePaths: ReadonlySet<string>;
    /** The project's main checkout; `git worktree remove` must run from it. */
    readonly workspaceRoot: string | null;
    readonly worktreesDir: string;
    readonly exportContext: ArchiveExportContext;
  }) =>
    Effect.gen(function* () {
      const { thread, mode } = input;
      const skipped = (reason: string): SessionArchiveReclaimOutcome => ({
        threadId: thread.id,
        reclaimed: false,
        mode,
        freedBytes: 0,
        skippedReason: reason,
        digestPath: null,
      });

      const git = yield* readGitFacts(thread.worktreePath);
      const eligibility = evaluateReclaimEligibility({
        thread: {
          threadId: thread.id,
          worktreePath: thread.worktreePath,
          archivedAt: thread.archivedAt,
        },
        mode,
        git,
        liveWorktreePaths: input.liveWorktreePaths,
        activeThreadWorktreePaths: input.activeThreadWorktreePaths,
        minArchivedDays: input.minArchivedDays,
        nowMs: input.nowMs,
        force: input.force,
        worktreesDir: input.worktreesDir,
      });

      if (!eligibility.eligible) {
        return skipped(describeBlockedReason(eligibility.blockedReason ?? "no-worktree"));
      }

      const worktreePath = thread.worktreePath;
      if (worktreePath === null || git === null) {
        return skipped("This session has no worktree on disk.");
      }
      if (mode === "slim" && git.inspection === "unknown") {
        return skipped("Git inspection is incomplete, so this worktree was left alone.");
      }

      const note =
        mode === "slim"
          ? "Regenerable directories were deleted from this session's worktree to reclaim disk. The checkout and its branch are intact."
          : "This session's worktree was removed to reclaim disk. The branch named below is where the code lives.";

      const exported = yield* exportThread(
        shellToExportSource(thread),
        note,
        input.exportContext,
      ).pipe(
        Effect.map((value) => ({ _tag: "ok" as const, value })),
        Effect.catchCause((cause) =>
          Effect.succeed({ _tag: "failed" as const, message: describeCause(cause) }),
        ),
      );
      if (exported._tag === "failed") {
        return skipped(`History export failed, so nothing was deleted: ${exported.message}`);
      }

      // Trust the file, not the effect's success: a truncated or empty digest
      // is the same loss as no digest at all.
      const digestInfo = yield* fs.stat(exported.value.digestPath).pipe(Effect.option);
      if (digestInfo._tag === "None" || Number(digestInfo.value.size) === 0) {
        return skipped("History export produced no file, so nothing was deleted.");
      }

      // Last check before anything is destroyed. The sets this batch started
      // with may be minutes old by now; a session unarchived or started on this
      // worktree in the meantime must still be respected. Re-read rather than
      // trust the snapshot taken when the batch began.
      const freshUsage = yield* readWorktreeUsage.pipe(
        Effect.map((usage) => ({ _tag: "ok" as const, usage })),
        Effect.catchCause((cause) =>
          Effect.succeed({ _tag: "failed" as const, message: describeCause(cause) }),
        ),
      );
      if (freshUsage._tag === "failed") {
        // Cannot prove it is safe, so treat it as unsafe.
        return skipped(
          `Could not re-check whether this worktree is in use, so it was left alone: ${freshUsage.message}`,
        );
      }
      if (isWorktreeProtected(worktreePath, freshUsage.usage.liveWorktreePaths)) {
        return skipped(describeBlockedReason("worktree-live"));
      }
      if (isWorktreeProtected(worktreePath, freshUsage.usage.activeThreadWorktreePaths)) {
        return skipped(describeBlockedReason("worktree-shared"));
      }

      if (mode === "slim") {
        const slimScan = yield* scanSlimWorktree(worktreePath).pipe(
          Effect.orElseSucceed(() => ({ state: "unknown" as const })),
        );
        if (slimScan.state === "unknown") {
          return skipped(
            "Git tracked-file inspection is incomplete, so this worktree was left alone.",
          );
        }
        const sized = slimScan.sized;
        const freedBytes = yield* slimWorktree({
          worktreePath,
          candidates: sized.slimCandidates,
          trackedPaths: new Set(),
          canDeleteCandidate: (candidate) =>
            readSlimTrackedPathInventory({
              worktreePath,
              candidatePaths: [candidate.relativePath],
            }).pipe(
              Effect.map(
                (inventory) => inventory.state === "complete" && inventory.trackedPaths.size === 0,
              ),
              Effect.orElseSucceed(() => false),
            ),
        });
        return {
          threadId: thread.id,
          reclaimed: true,
          mode,
          freedBytes,
          skippedReason: null,
          digestPath: exported.value.digestPath,
        } satisfies SessionArchiveReclaimOutcome;
      }

      const sized = yield* scanWorktree({ worktreePath, trackedPaths: git.trackedPaths }).pipe(
        Effect.orElseSucceed(() => ({
          totalBytes: null,
          reclaimableBytes: 0,
          slimCandidates: [],
          budgetExhausted: true,
        })),
      );

      // `git worktree remove` cannot run from inside the worktree it removes,
      // so it is issued from the project's main checkout.
      if (input.workspaceRoot === null || input.workspaceRoot.trim().length === 0) {
        return skipped("The project's main checkout is unknown, so the worktree was left alone.");
      }

      const removal = yield* gitWorkflow
        .removeWorktree({ cwd: input.workspaceRoot, path: worktreePath, force: input.force })
        .pipe(
          Effect.as({ _tag: "ok" as const }),
          Effect.catchCause((cause) =>
            Effect.succeed({ _tag: "failed" as const, message: describeCause(cause) }),
          ),
        );
      if (removal._tag === "failed") {
        return skipped(`git worktree remove failed: ${removal.message}`);
      }

      // Clear the thread's pointer at the deleted directory. Left dangling, an
      // archived-then-resumed thread would try to start sessions in a path that
      // no longer exists. The worktree is already gone either way, so a failed
      // clear must not un-reclaim the outcome.
      yield* orchestrationEngine
        .dispatch({
          type: "thread.meta.update",
          commandId: CommandId.make(`session-archive:worktree-clear:${thread.id}:${input.nowMs}`),
          threadId: thread.id,
          worktreePath: null,
        })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("session archive could not clear the reclaimed worktree path", {
              threadId: thread.id,
              worktreePath,
              cause: describeCause(cause),
            }),
          ),
        );

      return {
        threadId: thread.id,
        reclaimed: true,
        mode,
        freedBytes: sized.totalBytes ?? 0,
        skippedReason: null,
        digestPath: exported.value.digestPath,
      } satisfies SessionArchiveReclaimOutcome;
    });

  const runReclaim = (input: {
    readonly threadIds: ReadonlyArray<ThreadId> | null;
    readonly mode: SessionArchiveReclaimMode;
    readonly force: boolean;
    readonly minArchivedDays: number;
  }) =>
    Effect.gen(function* () {
      const context = yield* readContext;
      const now = yield* DateTime.now;
      const nowMs = DateTime.toEpochMillis(now);

      const selected =
        input.threadIds === null
          ? context.archivedThreads
          : context.archivedThreads.filter((thread) => input.threadIds?.includes(thread.id));

      // Sequential on purpose: each reclaim is heavy IO, and a shared box would
      // rather take longer than have several recursive deletes at once.
      const outcomes = yield* Effect.forEach(
        selected,
        (thread) =>
          reclaimThread({
            thread,
            mode: input.mode,
            force: input.force,
            minArchivedDays: input.minArchivedDays,
            nowMs,
            liveWorktreePaths: context.liveWorktreePaths,
            activeThreadWorktreePaths: context.activeThreadWorktreePaths,
            workspaceRoot: context.projectRoots.get(thread.projectId) ?? null,
            worktreesDir: config.worktreesDir,
            exportContext: context,
          }),
        { concurrency: 1 },
      );

      return {
        outcomes,
        totalFreedBytes: outcomes.reduce((total, outcome) => total + outcome.freedBytes, 0),
      } satisfies SessionArchiveReclaimResult;
    }).pipe(Effect.mapError((cause) => fail("reclaim", cause)));

  /**
   * Export every archived or soft-deleted session that has no digest yet.
   *
   * Reads projection rows directly rather than snapshots because soft-deleted
   * threads never appear in any snapshot, and the user has asked for their
   * history too. One thread's failure is a counted outcome, never the batch's.
   */
  const backfill = (input: SessionArchiveBackfillInput) =>
    Effect.gen(function* () {
      const historyDir = yield* resolveHistoryDir;
      const context = yield* readContext;
      const rows = yield* threadRows.listArchivedOrDeleted();

      const outcomes = yield* Effect.forEach(
        rows,
        (row) =>
          Effect.gen(function* () {
            const source = rowToExportSource(row);
            const projectName = context.projectNames.get(source.projectId) ?? "unknown-project";
            const paths = digestPathFor(historyDir, source, projectName);
            const digestExists = yield* fs
              .exists(paths.digestPath)
              .pipe(Effect.orElseSucceed(() => false));
            if (digestExists && !input.force) {
              return { _tag: "skipped" as const };
            }
            return yield* exportThread(source, null, context).pipe(
              Effect.map((exported) => ({ _tag: "exported" as const, exported })),
              Effect.catchCause((cause) =>
                Effect.succeed({
                  _tag: "failure" as const,
                  threadId: source.id,
                  message: describeCause(cause),
                }),
              ),
            );
          }),
        { concurrency: 2 },
      );

      return {
        exported: outcomes.filter((outcome) => outcome._tag === "exported").length,
        skipped: outcomes.filter((outcome) => outcome._tag === "skipped").length,
        rawTranscriptsMissing: outcomes.filter(
          (outcome) =>
            outcome._tag === "exported" &&
            outcome.exported.rawTranscripts.some((raw) => raw.status === "missing"),
        ).length,
        failures: outcomes.flatMap((outcome) =>
          outcome._tag === "failure"
            ? [{ threadId: outcome.threadId, message: outcome.message }]
            : [],
        ),
      } satisfies SessionArchiveBackfillResult;
    }).pipe(Effect.mapError((cause) => fail("backfill", cause)));

  return {
    scan: () => withPlatform(scan()),
    exportHistory: (threadIds) => withPlatform(exportHistory(threadIds)),
    exportContext: (threadId) => withPlatform(exportContext(threadId)),
    reclaim: (input) =>
      withPlatform(
        runReclaim({
          threadIds: input.threadIds,
          mode: input.mode,
          force: input.force,
          // The operator is looking straight at the session; retention is a
          // guard for the unattended sweeper, not for a deliberate click.
          minArchivedDays: 0,
        }),
      ),
    sweep: (input) =>
      withPlatform(
        runReclaim({
          threadIds: null,
          mode: input.mode,
          force: false,
          minArchivedDays: input.minArchivedDays,
        }),
      ),
    backfill: (input) => withPlatform(backfill(input)),
  } satisfies SessionArchiveServiceShape;
});

export const layer = Layer.effect(SessionArchiveService)(make);

/** `Info.mtime` is an `Option<Date>`; platforms that cannot report it yield None. */
function formatOptionalDate(value: Option.Option<Date>): string | null {
  return Option.match(value, {
    onNone: () => null,
    onSome: (date) => date.toISOString(),
  });
}

function describeCause(cause: unknown): string {
  if (cause instanceof Error) {
    return cause.message;
  }
  return String(cause);
}

/**
 * Recover index rows from a rendered index.
 *
 * Only the fields a re-render needs; anything unparseable is dropped rather
 * than throwing, because a hand-edited index should degrade to "missing a row"
 * and not to "export fails".
 */
export function parseIndexRows(markdown: string): ReadonlyArray<SessionHistoryIndexEntry> {
  const rows: Array<SessionHistoryIndexEntry> = [];
  for (const line of markdown.split("\n")) {
    if (!line.startsWith("| ") || line.startsWith("| ---") || line.startsWith("| Archived")) {
      continue;
    }
    const cells = line
      .slice(1, -1)
      .split(" | ")
      .map((cell) => cell.trim());
    if (cells.length < 4) {
      continue;
    }
    const link = /^\[(.*)\]\((.*)\)$/.exec(cells[1] ?? "");
    if (link === null) {
      continue;
    }
    const branch = (cells[2] ?? "").replace(/^`|`$/g, "");
    rows.push({
      fileName: decodeURI(link[2] ?? ""),
      title: (link[1] ?? "").replace(/\\\|/g, "|"),
      archivedAt: cells[0] === "—" ? null : (cells[0] ?? null),
      branch: branch === "—" || branch === "" ? null : branch,
      oneLineSummary: cells[3] === "—" ? null : (cells[3] ?? "").replace(/\\\|/g, "|"),
    });
  }
  return rows;
}
