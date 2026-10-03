// T3-CUSTOM(expbkt3): project defaults and environment appearance.
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
// T3-CUSTOM(expbkt3): BEGIN — environment-qualified project picker imports.
import type { EnvironmentId, ScopedProjectRef } from "@t3tools/contracts";
import type { DraftId } from "~/composerDraftStore";
// T3-CUSTOM(expbkt3): an empty draft follows the new project's saved defaults.
import { composerDraftHasUserContent, useComposerDraftStore } from "~/composerDraftStore";
import { resolveEnvironmentMachineKind } from "@t3tools/contracts";
import { scopedProjectKey, scopeProjectRef } from "@t3tools/client-runtime/environment";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import { FolderPlusIcon, MessageSquareDashedIcon } from "lucide-react";
import { useAtomValue } from "@effect/atom-react";
import { useCallback, useEffect, useMemo, useRef } from "react";

import { openCommandPalette } from "~/commandPaletteBus";
import { shortcutLabelForCommand } from "~/keybindings";
import { projectIconColorClassName } from "~/projectIconColors";
import { primaryServerKeybindingsAtom } from "~/state/server";
import { useScratchProject } from "~/hooks/useScratchProject";
import { useClientSettings } from "~/hooks/useSettings";
import { hasExplicitComposerModelSelection } from "~/lib/chatThreadActions";
import {
  deriveLogicalProjectKeyFromSettings,
  selectProjectGroupingSettings,
} from "~/logicalProject";
import {
  buildSidebarProjectPickerEntries,
  buildSidebarProjectSnapshots,
  projectGroupsSpanEnvironments,
  type SidebarProjectGroupMember,
  type SidebarProjectSnapshot,
} from "~/sidebarProjectGrouping";
import { useProjects, useThreadShells } from "~/state/entities";
// T3-CUSTOM(expbkt3): BEGIN — environment identity in the new-thread picker.
import {
  // T3-CUSTOM(expbkt3): environment identity in the new-thread picker.
  useEnvironmentAppearances,
  useEnvironments,
  usePrimaryEnvironmentId,
} from "~/state/environments";
// T3-CUSTOM(expbkt3): environment glyph.
import { EnvironmentBadgeView } from "../environment/EnvironmentBadge";
// T3-CUSTOM(expbkt3): END
import { ProjectEnvironmentBadge } from "../ProjectEnvironmentBadge";
import { ProjectFavicon } from "../ProjectFavicon";
import { sortLogicalProjectsForSidebar } from "../Sidebar.logic";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { InlineButton } from "../ui/button";
// T3-CUSTOM(expbkt3): the saved new-thread defaults (project, then host), one resolver.
import { resolveNewThreadDefaults } from "@t3tools/shared/newThreadDefaults.expbkt3";

// Menu value for "No project"; real entries are keyed by logical project key.
const NO_PROJECT_VALUE = "no-project";

interface DraftHeroHeadlineProps {
  readonly draftId: DraftId | null;
  readonly activeProjectRef: ScopedProjectRef | null;
  readonly activeProjectTitle: string | null;
}

// T3-CUSTOM(expbkt3): BEGIN — one row in the project picker. `project` is set only when the
// row names a specific environment, which happens when the logical project exists
// on more than one.
interface ProjectPickerItem {
  readonly value: string;
  readonly displayName: string;
  readonly environmentId: EnvironmentId | null;
  readonly project: SidebarProjectGroupMember | null;
  /** The logical group this row belongs to; carries the favicon and members. */
  readonly group: SidebarProjectSnapshot;
}

// T3-CUSTOM(expbkt3): END
export function DraftHeroHeadline({
  draftId,
  activeProjectRef,
  activeProjectTitle,
}: DraftHeroHeadlineProps) {
  const projects = useProjects();
  const threads = useThreadShells();
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const projectSortOrder = useClientSettings((settings) => settings.sidebarProjectSortOrder);
  const setLogicalProjectDraftThreadId = useComposerDraftStore(
    (store) => store.setLogicalProjectDraftThreadId,
  );
  const getComposerDraft = useComposerDraftStore((store) => store.getComposerDraft);
  const setModelSelection = useComposerDraftStore((store) => store.setModelSelection);
  const applyStickyState = useComposerDraftStore((store) => store.applyStickyState);
  // T3-CUSTOM(expbkt3): BEGIN — retargeting an empty draft resets its modes to
  // the new project's saved defaults; Plan only while its toggle exists.
  const setRuntimeMode = useComposerDraftStore((store) => store.setRuntimeMode);
  const setInteractionMode = useComposerDraftStore((store) => store.setInteractionMode);
  const planModeAvailable = useClientSettings((settings) => settings.planModeAvailable);
  // T3-CUSTOM(expbkt3): END
  const openAddProject = useCallback(() => openCommandPalette({ open: "add-project" }), []);
  const { scratchEnvironmentId, scratchWorkspaceRootFor, openScratchProject } = useScratchProject();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);

  const environmentLabelById = useMemo(
    () =>
      new Map(
        environments.map((environment) => [environment.environmentId, environment.label] as const),
      ),
    [environments],
  );
  const projectGroups = useMemo(
    () =>
      sortLogicalProjectsForSidebar(
        buildSidebarProjectSnapshots({
          projects,
          settings: projectGroupingSettings,
          primaryEnvironmentId,
          resolveEnvironmentLabel: (environmentId) =>
            environmentLabelById.get(environmentId) ?? null,
        }),
        threads,
        projectSortOrder,
      ),
    [
      environmentLabelById,
      primaryEnvironmentId,
      projectGroupingSettings,
      projectSortOrder,
      projects,
      threads,
    ],
  );
  // Same-named projects on two machines are only told apart by where they
  // live, so rows on another machine carry its icon once the catalog spans
  // more than one environment; a single-machine catalog stays as it was.
  const showProjectEnvironments = useMemo(
    () => projectGroupsSpanEnvironments(projectGroups),
    [projectGroups],
  );
  const environmentMachineById = useMemo(
    () =>
      new Map(
        environments.map(
          (environment) =>
            [
              environment.environmentId,
              resolveEnvironmentMachineKind(environment.serverConfig),
            ] as const,
        ),
      ),
    [environments],
  );
  const projectPickerEntries = useMemo(
    () =>
      buildSidebarProjectPickerEntries({
        groups: projectGroups,
        preferredProjectRef: activeProjectRef,
      }),
    [activeProjectRef, projectGroups],
  );
  const projectEntryByKey = useMemo(
    () => new Map(projectPickerEntries.map((entry) => [entry.group.projectKey, entry] as const)),
    [projectPickerEntries],
  );
  const activeProjectGroup =
    activeProjectRef === null
      ? null
      : (projectGroups.find((group) =>
          group.memberProjectRefs.some(
            (projectRef) => scopedProjectKey(projectRef) === scopedProjectKey(activeProjectRef),
          ),
        ) ?? null);
  // T3-CUSTOM(expbkt3): BEGIN — a logical project can exist on more than one
  // machine, and the picker previously collapsed those into one row that silently
  // chose an environment for you. Offer each environment explicitly, so starting a
  // session says where it will run. Groups that live on a single environment are
  // untouched, which is every group on a single-environment client.
  const appearances = useEnvironmentAppearances();
  const pickerItems = useMemo<ReadonlyArray<ProjectPickerItem>>(
    () =>
      projectPickerEntries.flatMap(({ group }): ProjectPickerItem[] => {
        const byEnvironment = new Map<string, SidebarProjectGroupMember>();
        for (const member of group.memberProjects) {
          if (!byEnvironment.has(member.environmentId)) {
            byEnvironment.set(member.environmentId, member);
          }
        }
        if (byEnvironment.size < 2) {
          return [
            {
              value: group.projectKey,
              displayName: group.displayName,
              environmentId: null,
              project: null,
              group,
            },
          ];
        }
        return [...byEnvironment.values()].map((member) => ({
          value: `${group.projectKey}::${member.environmentId}`,
          displayName: group.displayName,
          environmentId: member.environmentId,
          project: member,
          group,
        }));
      }),
    [projectPickerEntries],
  );
  const activeGroupSpansEnvironments = useMemo(() => {
    if (!activeProjectGroup) return false;
    return (
      new Set(activeProjectGroup.memberProjects.map((member) => member.environmentId)).size > 1
    );
  }, [activeProjectGroup]);
  const activeProjectKey =
    activeProjectGroup === null
      ? ""
      : activeGroupSpansEnvironments && activeProjectRef !== null
        ? `${activeProjectGroup.projectKey}::${activeProjectRef.environmentId}`
        : activeProjectGroup.projectKey;
  // T3-CUSTOM(expbkt3): END
  const activeProjectDisplayName = activeProjectGroup?.displayName ?? activeProjectTitle;
  const hasResolvedProject = activeProjectTitle !== null;
  const canChooseProject = projectPickerEntries.length > 0;
  const shouldShowProjectMenu = canChooseProject;
  // The project that hosts threads without a project appears once, as the
  // "No project" item, not as a project row.
  const menuEntries = pickerItems.filter(
    (item) =>
      item.project === null ||
      !isScratchProject(item.project, scratchWorkspaceRootFor(item.project.environmentId)),
  );
  const activeProject =
    activeProjectRef === null
      ? null
      : (projects.find(
          (project) =>
            project.environmentId === activeProjectRef.environmentId &&
            project.id === activeProjectRef.projectId,
        ) ?? null);
  const scratchTargetEnvironmentId = scratchEnvironmentId(
    activeProjectRef?.environmentId ?? primaryEnvironmentId,
  );
  const scratchWorkspaceRoot = scratchWorkspaceRootFor(scratchTargetEnvironmentId);
  const isScratchDraft =
    activeProject !== null && isScratchProject(activeProject, scratchWorkspaceRoot);

  // The picker can change the draft's target while the no-project home is
  // still being opened; a stale continuation must not retarget it again.
  const latestTargetRef = useRef({ draftId, activeProjectKey, scratchTargetEnvironmentId });
  useEffect(() => {
    latestTargetRef.current = { draftId, activeProjectKey, scratchTargetEnvironmentId };
  }, [activeProjectKey, scratchTargetEnvironmentId, draftId]);
  // Project selection changes the target of the open draft in place. The
  // prompt stays in the same composer session, so the sidebar only gets a
  // draft row if the user later navigates away.
  const selectProject = (project: (typeof projects)[number], logicalProjectKey: string) => {
    if (!draftId) {
      return;
    }
    latestTargetRef.current = {
      draftId,
      activeProjectKey: logicalProjectKey,
      scratchTargetEnvironmentId: project.environmentId,
    };
    const currentDraft = getComposerDraft(draftId);
    setLogicalProjectDraftThreadId(
      logicalProjectKey,
      scopeProjectRef(project.environmentId, project.id),
      draftId,
    );
    if (!hasExplicitComposerModelSelection(currentDraft)) {
      applyStickyState(draftId);
      const environmentSettings = environments.find(
        (environment) => environment.environmentId === project.environmentId,
      )?.serverConfig?.settings;
      const defaultModelSelection = environmentSettings
        ? resolveProjectSettings(environmentSettings, project.id, project).settings
            .defaultModelSelection
        : project.defaultModelSelection;
      if (defaultModelSelection) {
        setModelSelection(draftId, defaultModelSelection, {
          replaceOptions: true,
        });
      }
    }
  };
  const startScratch = async (): Promise<boolean> => {
    if (scratchTargetEnvironmentId === null || isScratchDraft) {
      return false;
    }
    const requested = { draftId, activeProjectKey, scratchTargetEnvironmentId };
    const project = await openScratchProject(scratchTargetEnvironmentId);
    const latest = latestTargetRef.current;
    if (
      !project ||
      latest.draftId !== requested.draftId ||
      latest.activeProjectKey !== requested.activeProjectKey ||
      latest.scratchTargetEnvironmentId !== requested.scratchTargetEnvironmentId
    ) {
      return false;
    }
    selectProject(project, deriveLogicalProjectKeyFromSettings(project, projectGroupingSettings));
    return true;
  };

  const projectSelector = shouldShowProjectMenu ? (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            // The trigger's accessible name comes from its visible text (the
            // project title) so the hero sentence reads naturally: an
            // aria-label here would replace the title with an action phrase
            // mid-sentence and baffle screen-reader users.
            <MenuTrigger
              render={<InlineButton tone="picker" />}
              data-draft-project-trigger=""
              className="pointer-events-auto max-w-64 align-baseline"
            />
          }
        >
          <span className="min-w-0 truncate">
            {isScratchDraft ? "No project" : (activeProjectDisplayName ?? "Choose a project")}
          </span>
        </TooltipTrigger>
        {activeProjectDisplayName && !isScratchDraft ? (
          <TooltipPopup side="top">{activeProjectDisplayName}</TooltipPopup>
        ) : null}
      </Tooltip>
      <MenuPopup align="center" className="max-h-80 overflow-y-auto">
        <MenuRadioGroup
          value={isScratchDraft ? NO_PROJECT_VALUE : activeProjectKey}
          onValueChange={(value) => {
            if (value === NO_PROJECT_VALUE) {
              void startScratch();
              return;
            }
            // T3-CUSTOM(expbkt3): explicit machine rows retain their selected project.
            const item = pickerItems.find((candidate) => candidate.value === value);
            const entry = item ? projectEntryByKey.get(item.group.projectKey) : undefined;
            if (!entry || !item || value === activeProjectKey) {
              return;
            }
            selectProject(item.project ?? entry.targetProject, entry.group.projectKey);
          }}
        >
          {scratchWorkspaceRoot === null ? null : (
            <MenuRadioItem value={NO_PROJECT_VALUE} closeOnClick>
              <span className="flex min-w-0 items-center gap-2">
                {/* Boxed like ProjectFavicon so the label lines up with project rows. */}
                <span
                  aria-hidden="true"
                  className={`inline-flex size-4 shrink-0 ${projectIconColorClassName("gray")}`}
                >
                  <MessageSquareDashedIcon className="size-full" />
                </span>
                No project
              </span>
            </MenuRadioItem>
          )}
          {menuEntries.map((item) => {
            const appearance =
              item.environmentId === null ? null : appearances.get(item.environmentId);
            return (
              <MenuRadioItem key={item.value} value={item.value} closeOnClick>
                <span className="flex min-w-0 items-center gap-2">
                  <ProjectFavicon project={item.group} className="size-4 shrink-0" />
                  <Tooltip>
                    <TooltipTrigger render={<span className="block min-w-0 truncate" />}>
                      {item.displayName}
                    </TooltipTrigger>
                    <TooltipPopup side="top">{item.displayName}</TooltipPopup>
                  </Tooltip>
                  {appearance ? (
                    // T3-CUSTOM(expbkt3): this row already names its environment, so
                    // upstream's machine badge would repeat it.
                    <>
                      <EnvironmentBadgeView appearance={appearance} variant="glyph" />
                      <span
                        className="min-w-0 shrink-0 truncate text-xs"
                        style={{ color: appearance.color }}
                      >
                        {appearance.name}
                      </span>
                    </>
                  ) : showProjectEnvironments ? (
                    <ProjectEnvironmentBadge
                      group={item.group}
                      primaryEnvironmentId={primaryEnvironmentId}
                      machineByEnvironmentId={environmentMachineById}
                    />
                  ) : null}
                </span>
              </MenuRadioItem>
            );
          })}
          {/* T3-CUSTOM(expbkt3): END */}
        </MenuRadioGroup>
        {projectPickerEntries.length > 0 ? <MenuSeparator /> : null}
        <MenuItem onClick={openAddProject}>
          <FolderPlusIcon />
          Add project
        </MenuItem>
      </MenuPopup>
    </Menu>
  ) : (
    <button
      type="button"
      onClick={openAddProject}
      className="pointer-events-auto inline cursor-pointer border-muted-foreground/35 border-b border-dotted text-muted-foreground/60 transition-colors hover:border-muted-foreground/60 hover:text-muted-foreground/80 focus-visible:rounded-sm focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
    >
      {activeProjectTitle ?? "Add a project"}
    </button>
  );

  // T3-CUSTOM(expbkt3): BEGIN — name the machine the session will start on, but only when
  // this project exists on more than one — otherwise it is noise on every draft.
  const activeEnvironmentAppearance =
    activeGroupSpansEnvironments && activeProjectRef !== null
      ? (appearances.get(activeProjectRef.environmentId) ?? null)
      : null;

  // T3-CUSTOM(expbkt3): END
  // The composer hero is a sentence, so the heading's accessible name must be
  // a complete sentence too. The project picker is a control rendered inline
  // in the h1; without an explicit label its widget state bleeds into the
  // announced phrase.
  const headingLabel = isScratchDraft
    ? "What should we work on?"
    : hasResolvedProject
      ? `What should we build in ${activeProjectDisplayName}?`
      : canChooseProject
        ? `${activeProjectDisplayName ?? "Choose a project"} to start`
        : "Add a project to start";

  // One click out of the project, phrased as the alternative to the question
  // above it. Focus moves to the project picker once this line has gone.
  const noProjectShortcut = shortcutLabelForCommand(keybindings, "chat.newWithoutProject");
  const orStartWithoutProject =
    scratchWorkspaceRoot !== null && !isScratchDraft && (hasResolvedProject || canChooseProject) ? (
      <Tooltip>
        <TooltipTrigger
          render={
            <InlineButton
              tone="muted"
              className="pointer-events-auto"
              onClick={() =>
                void startScratch().then((started) => {
                  if (started) {
                    document.querySelector<HTMLElement>("[data-draft-project-trigger]")?.focus();
                  }
                })
              }
            />
          }
        >
          or start without a project
        </TooltipTrigger>
        {noProjectShortcut ? <TooltipPopup side="bottom">{noProjectShortcut}</TooltipPopup> : null}
      </Tooltip>
    ) : null;

  // T3-CUSTOM(expbkt3): BEGIN — show the selected machine beneath the draft prompt.
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col items-center">
      <h1
        aria-label={headingLabel}
        className="w-full text-center font-normal text-2xl text-foreground tracking-tight sm:text-3xl"
      >
        {isScratchDraft ? (
          <>What should we work on?</>
        ) : hasResolvedProject ? (
          <>What should we build in {projectSelector}?</>
        ) : canChooseProject ? (
          <>{projectSelector} to start</>
        ) : (
          <>Add a project to start</>
        )}
      </h1>
      {/* Reserved whenever threads can skip a project, so the heading does not
          move. Without a project, the picker moves here to choose one. */}
      {scratchWorkspaceRoot === null ? null : (
        <p className="mt-2 flex h-6 items-center text-sm">
          {isScratchDraft ? projectSelector : orStartWithoutProject}
        </p>
      )}
    </div>
  );
  // T3-CUSTOM(expbkt3): END
}
