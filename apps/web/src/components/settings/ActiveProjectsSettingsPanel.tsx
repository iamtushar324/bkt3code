/**
 * T3-CUSTOM(expbkt3): Experimental project administration surface.
 *
 * This is intentionally a dedicated component, with only a small guarded route
 * and navigation seam in upstream settings code. That boundary keeps future
 * upstream merges mechanical.
 */
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useRouter } from "@tanstack/react-router";
import {
  ActivityIcon,
  CircleAlertIcon,
  CopyIcon,
  ExternalLinkIcon,
  FolderCogIcon,
  FolderPlusIcon,
  RotateCcwIcon,
  SaveIcon,
  SearchIcon,
  ServerIcon,
  Trash2Icon,
} from "lucide-react";
import { useCallback, useMemo, useState, type KeyboardEvent } from "react";

import { openCommandPalette } from "../../commandPaletteBus";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import {
  useEnvironmentAppearances,
  useEnvironments,
  // T3-CUSTOM(expbkt3): per-environment identity.
  useHasMultipleEnvironments,
} from "../../state/environments";
// T3-CUSTOM(expbkt3): BEGIN — environment identity badge.
import type { ResolvedEnvironmentAppearance } from "../../state/environmentAppearance";
import { EnvironmentBadgeView } from "../environment/EnvironmentBadge";
// T3-CUSTOM(expbkt3): END
import { useProjects, useThreadShells } from "../../state/entities";
import { projectEnvironment } from "../../state/projects";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  activeProjectKey,
  buildActiveProjectSettingsRows,
  normalizeProjectNickname,
  suggestedProjectNickname,
  type ActiveProjectSettingsRow,
} from "./ActiveProjectsSettingsPanel.logic";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";

type ProjectRow = ActiveProjectSettingsRow<EnvironmentProject, EnvironmentThreadShell>;

interface RemoveTarget {
  readonly project: EnvironmentProject;
  readonly sessionCount: number;
}

function commandFailureDescription(result: Parameters<typeof squashAtomCommandFailure>[0]): string {
  const error = squashAtomCommandFailure(result);
  return error instanceof Error ? error.message : "An unexpected error occurred.";
}

function ProjectHealthBadges({
  row,
  // T3-CUSTOM(expbkt3): resolved once by the panel, so a long list does not
  // subscribe per row.
  environmentAppearance,
}: {
  row: ProjectRow;
  environmentAppearance?: ResolvedEnvironmentAppearance | undefined;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Badge variant="outline">
        {row.sessionCount} session{row.sessionCount === 1 ? "" : "s"}
      </Badge>
      {row.runningCount > 0 ? (
        <Badge variant="success">
          <ActivityIcon />
          {row.runningCount} running
        </Badge>
      ) : null}
      {row.attentionCount > 0 ? (
        <Badge variant="error">
          <CircleAlertIcon />
          {row.attentionCount} need attention
        </Badge>
      ) : null}
      {/* T3-CUSTOM(expbkt3): BEGIN — carry the environment's own icon and colour so
          the same machine reads identically here and in the sidebar. Falls back to
          the plain badge when this client only knows one environment. */}
      {environmentAppearance ? (
        <EnvironmentBadgeView appearance={environmentAppearance} />
      ) : (
        <Badge variant="secondary">
          <ServerIcon />
          {row.environmentLabel}
        </Badge>
      )}
      {/* T3-CUSTOM(expbkt3): END */}
    </div>
  );
}

export function ActiveProjectsSettingsPanel() {
  const projects = useProjects();
  const threads = useThreadShells();
  const { environments } = useEnvironments();
  const router = useRouter();
  const handleNewThread = useNewThreadHandler();
  const updateProject = useAtomCommand(projectEnvironment.update, { reportFailure: false });
  const deleteProject = useAtomCommand(projectEnvironment.delete, { reportFailure: false });
  const [query, setQuery] = useState("");
  const [nicknameDrafts, setNicknameDrafts] = useState<Record<string, string>>({});
  const [busyProjectKey, setBusyProjectKey] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<RemoveTarget | null>(null);
  // T3-CUSTOM(expbkt3): `environment.label` is the nickname when one is set, so
  // typing the name you gave a machine also finds its projects.
  const appearances = useEnvironmentAppearances();
  const showEnvironment = useHasMultipleEnvironments();
  const environmentLabelById = useMemo(
    () =>
      new Map(
        environments.map((environment) => [environment.environmentId, environment.label] as const),
      ),
    [environments],
  );
  const allRows = useMemo(
    () =>
      buildActiveProjectSettingsRows({
        projects,
        threads,
        environmentLabelById,
        query: "",
      }),
    [environmentLabelById, projects, threads],
  );
  const rows = useMemo(
    () =>
      buildActiveProjectSettingsRows({
        projects,
        threads,
        environmentLabelById,
        query,
      }),
    [environmentLabelById, projects, query, threads],
  );
  const totals = useMemo(
    () =>
      allRows.reduce(
        (summary, row) => ({
          sessions: summary.sessions + row.sessionCount,
          running: summary.running + row.runningCount,
          attention: summary.attention + row.attentionCount,
        }),
        { sessions: 0, running: 0, attention: 0 },
      ),
    [allRows],
  );
  const { copyToClipboard } = useCopyToClipboard<{ readonly path: string }>({
    target: "project path",
    onCopy: ({ path }) =>
      toastManager.add({ type: "success", title: "Project path copied", description: path }),
    onError: (error) =>
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not copy project path",
          description: error.message,
        }),
      ),
  });

  const saveNickname = useCallback(
    async (project: EnvironmentProject, value: string) => {
      const nickname = normalizeProjectNickname(value);
      if (nickname === null) {
        toastManager.add({ type: "warning", title: "Project nickname cannot be empty" });
        return;
      }
      if (nickname === project.title) return;

      const key = activeProjectKey(project);
      setBusyProjectKey(key);
      const result = await updateProject({
        environmentId: project.environmentId,
        input: { projectId: project.id, title: nickname },
      });
      setBusyProjectKey(null);
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not update project nickname",
              description: commandFailureDescription(result),
            }),
          );
        }
        return;
      }

      setNicknameDrafts((current) => ({ ...current, [key]: nickname }));
      toastManager.add({ type: "success", title: "Project nickname updated" });
    },
    [updateProject],
  );

  const handleNicknameKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>, row: ProjectRow, value: string) => {
      if (event.key === "Enter") {
        event.preventDefault();
        void saveNickname(row.project, value);
      } else if (event.key === "Escape") {
        event.preventDefault();
        setNicknameDrafts((current) => ({
          ...current,
          [activeProjectKey(row.project)]: row.project.title,
        }));
      }
    },
    [saveNickname],
  );

  const confirmRemoveProject = useCallback(async () => {
    if (removeTarget === null) return;
    const { project, sessionCount } = removeTarget;
    const key = activeProjectKey(project);
    setBusyProjectKey(key);
    const result = await deleteProject({
      environmentId: project.environmentId,
      input: {
        projectId: project.id,
        ...(sessionCount > 0 ? { force: true } : {}),
      },
    });
    setBusyProjectKey(null);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: `Could not remove "${project.title}"`,
            description: commandFailureDescription(result),
          }),
        );
      }
      return;
    }

    setRemoveTarget(null);
    toastManager.add({
      type: "success",
      title: `Removed "${project.title}"`,
      description: "Files on disk were not changed.",
    });
  }, [deleteProject, removeTarget]);

  return (
    <SettingsPageContainer>
      <SettingsSection
        title="Active projects"
        icon={<FolderCogIcon className="size-5 text-muted-foreground" />}
        headerAction={
          <Button
            size="sm"
            variant="outline"
            onClick={() => openCommandPalette({ open: "add-project" })}
          >
            <FolderPlusIcon />
            Add project
          </Button>
        }
      >
        <div className="mx-3 grid gap-2 sm:mx-4 sm:grid-cols-3">
          <div className="rounded-xl border bg-muted/24 px-3 py-2.5">
            <p className="text-2xl font-semibold tracking-tight">{allRows.length}</p>
            <p className="text-xs text-muted-foreground">Active projects</p>
          </div>
          <div className="rounded-xl border bg-muted/24 px-3 py-2.5">
            <p className="text-2xl font-semibold tracking-tight text-success-foreground">
              {totals.running}
            </p>
            <p className="text-xs text-muted-foreground">
              Running across {totals.sessions} sessions
            </p>
          </div>
          <div
            className={
              totals.attention > 0
                ? "rounded-xl border border-destructive/32 bg-destructive/8 px-3 py-2.5"
                : "rounded-xl border bg-muted/24 px-3 py-2.5"
            }
          >
            <p
              className={
                totals.attention > 0
                  ? "text-2xl font-semibold tracking-tight text-destructive-foreground"
                  : "text-2xl font-semibold tracking-tight"
              }
            >
              {totals.attention}
            </p>
            <p className="text-xs text-muted-foreground">Need human attention</p>
          </div>
        </div>

        <div className="mx-3 pt-2 sm:mx-4">
          <label className="relative block">
            <span className="sr-only">Search active projects</span>
            <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 z-10 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
              placeholder="Search nickname, folder, or environment"
              className="[&_input]:pl-8"
            />
          </label>
        </div>

        <p className="mx-4 text-xs leading-relaxed text-muted-foreground">
          Nicknames change how projects appear throughout T3 Code. Removing a project clears its T3
          sessions and conversation history, but never deletes the workspace folder.
        </p>

        {allRows.length === 0 ? (
          <div className="mx-3 rounded-xl border border-dashed px-4 py-8 text-center sm:mx-4">
            <FolderCogIcon className="mx-auto mb-2 size-5 text-muted-foreground" />
            <p className="text-sm font-medium">No active projects</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Add a folder to start a project in T3 Code.
            </p>
          </div>
        ) : rows.length === 0 ? (
          <p className="mx-4 py-6 text-center text-sm text-muted-foreground">
            No projects match “{query.trim()}”.
          </p>
        ) : (
          <div className="mx-3 space-y-3 sm:mx-4">
            {rows.map((row) => {
              const key = activeProjectKey(row.project);
              const nickname = nicknameDrafts[key] ?? row.project.title;
              const normalizedNickname = normalizeProjectNickname(nickname);
              const nicknameChanged =
                normalizedNickname !== null && normalizedNickname !== row.project.title;
              const isBusy = busyProjectKey === key;
              const suggestedNickname = suggestedProjectNickname(row.project.workspaceRoot);

              return (
                <article key={key} className="rounded-xl border bg-card p-3.5 shadow-xs/5">
                  <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                    <div className="min-w-0 flex-1 space-y-3">
                      <div>
                        <label
                          htmlFor={`project-nickname-${key}`}
                          className="mb-1.5 block text-xs font-medium text-muted-foreground"
                        >
                          Nickname
                        </label>
                        <div className="flex max-w-xl gap-1.5">
                          <Input
                            id={`project-nickname-${key}`}
                            value={nickname}
                            disabled={isBusy}
                            aria-invalid={normalizedNickname === null}
                            onChange={(event) => {
                              const nextNickname = event.currentTarget.value;
                              setNicknameDrafts((current) => ({
                                ...current,
                                [key]: nextNickname,
                              }));
                            }}
                            onKeyDown={(event) => handleNicknameKeyDown(event, row, nickname)}
                          />
                          <Button
                            size="icon-sm"
                            variant="outline"
                            aria-label={`Reset ${row.project.title} nickname to folder name`}
                            disabled={
                              isBusy ||
                              suggestedNickname.length === 0 ||
                              nickname === suggestedNickname
                            }
                            onClick={() =>
                              setNicknameDrafts((current) => ({
                                ...current,
                                [key]: suggestedNickname,
                              }))
                            }
                          >
                            <RotateCcwIcon />
                          </Button>
                          <Button
                            size="icon-sm"
                            aria-label={`Save ${row.project.title} nickname`}
                            disabled={!nicknameChanged || isBusy}
                            onClick={() => void saveNickname(row.project, nickname)}
                          >
                            <SaveIcon />
                          </Button>
                        </div>
                      </div>

                      <div className="flex min-w-0 items-center gap-1.5">
                        <code className="min-w-0 truncate text-xs text-muted-foreground">
                          {row.project.workspaceRoot}
                        </code>
                        <Button
                          size="icon-xs"
                          variant="ghost"
                          aria-label={`Copy path for ${row.project.title}`}
                          onClick={() =>
                            copyToClipboard(row.project.workspaceRoot, {
                              path: row.project.workspaceRoot,
                            })
                          }
                        >
                          <CopyIcon />
                        </Button>
                      </div>

                      <ProjectHealthBadges
                        row={row}
                        // T3-CUSTOM(expbkt3): only badge the machine when there is
                        // more than one to distinguish.
                        {...(showEnvironment
                          ? { environmentAppearance: appearances.get(row.project.environmentId) }
                          : {})}
                      />

                      <p className="text-xs text-muted-foreground">
                        Last activity {formatRelativeTimeLabel(row.lastActivityAt)}
                        {row.project.defaultModelSelection
                          ? ` · Default model ${row.project.defaultModelSelection.model}`
                          : ""}
                        {row.project.scripts.length > 0
                          ? ` · ${row.project.scripts.length} action${
                              row.project.scripts.length === 1 ? "" : "s"
                            }`
                          : ""}
                      </p>
                    </div>

                    <div className="flex flex-wrap gap-1.5 lg:max-w-64 lg:justify-end">
                      {row.latestThread ? (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            void router.navigate({
                              to: "/$environmentId/$threadId",
                              params: {
                                environmentId: row.latestThread!.environmentId,
                                threadId: row.latestThread!.id,
                              },
                            })
                          }
                        >
                          <ExternalLinkIcon />
                          Open latest
                        </Button>
                      ) : null}
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          void handleNewThread(
                            scopeProjectRef(row.project.environmentId, row.project.id),
                          )
                        }
                      >
                        New thread
                      </Button>
                      <Button
                        size="icon-sm"
                        variant="destructive-outline"
                        aria-label={`Remove ${row.project.title}`}
                        disabled={isBusy}
                        onClick={() =>
                          setRemoveTarget({
                            project: row.project,
                            sessionCount: row.sessionCount,
                          })
                        }
                      >
                        <Trash2Icon />
                      </Button>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </SettingsSection>

      <AlertDialog
        open={removeTarget !== null}
        onOpenChange={(open) => {
          if (!open && busyProjectKey === null) setRemoveTarget(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove “{removeTarget?.project.title}”?</AlertDialogTitle>
            <AlertDialogDescription>
              {removeTarget && removeTarget.sessionCount > 0
                ? `This permanently removes ${removeTarget.sessionCount} T3 session${
                    removeTarget.sessionCount === 1 ? "" : "s"
                  } and their conversation history.`
                : "This removes the project from T3 Code."}{" "}
              The workspace folder and its files stay on disk.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              disabled={busyProjectKey !== null}
              onClick={() => void confirmRemoveProject()}
            >
              Remove project
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </SettingsPageContainer>
  );
}
