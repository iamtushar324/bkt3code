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
import { FolderPlusIcon } from "lucide-react";
import { useAtomValue } from "@effect/atom-react";
import { useEffect, useRef, useState } from "react";

import { openCommandPalette } from "~/commandPaletteBus";
import { shortcutLabelForCommand } from "~/keybindings";
import { primaryServerKeybindingsAtom } from "~/state/server";
import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
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
  Combobox,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxSearchInput,
  ComboboxTrigger,
  useComboboxFilter,
} from "../ui/combobox";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { InlineButton } from "../ui/button";
import { DraftProjectName } from "./DraftProjectName";
// T3-CUSTOM(expbkt3): the saved new-thread defaults (project, then host), one resolver.
import { resolveNewThreadDefaults } from "@t3tools/shared/newThreadDefaults.expbkt3";

const ADD_PROJECT_VALUE = "add-project";

interface PickerItem {
  readonly value: string;
  readonly label: string;
}

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
  const openAddProject = () => openCommandPalette({ open: "add-project" });
  const { scratchEnvironmentId, scratchWorkspaceRootFor, openScratchProject } = useScratchProject();
  const openProjectDraft = useNewThreadHandler();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerQuery, setPickerQuery] = useState("");
  const pickerFilter = useComboboxFilter();

  const environmentLabelById = new Map(
    environments.map((environment) => [environment.environmentId, environment.label] as const),
  );
  const projectGroups = sortLogicalProjectsForSidebar(
    buildSidebarProjectSnapshots({
      projects,
      settings: projectGroupingSettings,
      primaryEnvironmentId,
      resolveEnvironmentLabel: (environmentId) => environmentLabelById.get(environmentId) ?? null,
    }),
    threads,
    projectSortOrder,
  );
  const showProjectEnvironments = projectGroupsSpanEnvironments(projectGroups);
  const environmentMachineById = new Map(
    environments.map(
      (environment) =>
        [
          environment.environmentId,
          resolveEnvironmentMachineKind(environment.serverConfig),
        ] as const,
    ),
  );
  const projectPickerEntries = buildSidebarProjectPickerEntries({
    groups: projectGroups,
    preferredProjectRef: activeProjectRef,
  });
  const projectEntryByKey = new Map(
    projectPickerEntries.map((entry) => [entry.group.projectKey, entry] as const),
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
  // Named apart from upstream's combobox `pickerItems`, which these rows feed.
  const projectPickerItems: ReadonlyArray<ProjectPickerItem> = projectPickerEntries.flatMap(
    ({ group }): ProjectPickerItem[] => {
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
    },
  );
  const projectPickerItemByValue = new Map(
    projectPickerItems.map((item) => [item.value, item] as const),
  );
  const activeGroupSpansEnvironments =
    activeProjectGroup !== null &&
    new Set(activeProjectGroup.memberProjects.map((member) => member.environmentId)).size > 1;
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
  // T3-CUSTOM(expbkt3): one row per machine for a project that spans several.
  const menuEntries = projectPickerItems.filter(
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

  const pickerItems: readonly PickerItem[] = [
    // T3-CUSTOM(expbkt3): one combobox row per picker row, machine rows included.
    ...menuEntries.map((item) => ({ value: item.value, label: item.displayName })),
    { value: ADD_PROJECT_VALUE, label: "Add project" },
  ];
  const pickerSearch = pickerQuery.trim();
  const filteredPickerItems =
    pickerSearch.length === 0
      ? pickerItems
      : pickerItems.filter(
          (item) =>
            item.value !== ADD_PROJECT_VALUE &&
            pickerFilter.contains(item, pickerSearch, (candidate) => candidate.label),
        );
  const selectedPickerItem = pickerItems.find((item) => item.value === activeProjectKey) ?? null;

  // The picker can change the draft's target while the no-project home is
  // still being opened; a stale continuation must not retarget it again.
  const latestTargetRef = useRef({ draftId, activeProjectKey, scratchTargetEnvironmentId });
  useEffect(() => {
    latestTargetRef.current = { draftId, activeProjectKey, scratchTargetEnvironmentId };
  }, [activeProjectKey, scratchTargetEnvironmentId, draftId]);
  // An empty draft instead opens the chosen project's own draft, like starting a new thread there:
  // moving it would replace that draft and strand whatever it holds, such as the browser tabs of
  // the no-project draft.
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
    if (!composerDraftHasUserContent(currentDraft)) {
      void openProjectDraft(scopeProjectRef(project.environmentId, project.id));
      return;
    }
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
    <Combobox
      items={pickerItems}
      filteredItems={filteredPickerItems}
      autoHighlight
      itemToStringLabel={(item) => item.label}
      isItemEqualToValue={(a, b) => a.value === b.value}
      open={pickerOpen}
      onOpenChange={(open) => {
        setPickerOpen(open);
        setPickerQuery("");
      }}
      value={selectedPickerItem}
      onValueChange={(item) => {
        if (!item) return;
        setPickerOpen(false);
        if (item.value === ADD_PROJECT_VALUE) {
          openAddProject();
          return;
        }
        // T3-CUSTOM(expbkt3): explicit machine rows retain their selected project.
        const projectItem = projectPickerItemByValue.get(item.value);
        const entry = projectItem ? projectEntryByKey.get(projectItem.group.projectKey) : undefined;
        if (!entry || !projectItem || item.value === activeProjectKey) {
          return;
        }
        selectProject(projectItem.project ?? entry.targetProject, entry.group.projectKey);
      }}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <ComboboxTrigger
              render={<InlineButton tone="picker" />}
              data-draft-project-trigger=""
              // Leaves room for the trailing "?" so a truncated name keeps it on its line.
              className="pointer-events-auto max-w-[calc(100%-1em)] align-baseline"
            />
          }
        >
          <DraftProjectName
            value={isScratchDraft ? "No project" : (activeProjectDisplayName ?? "Choose a project")}
          />
        </TooltipTrigger>
        {activeProjectDisplayName && !isScratchDraft ? (
          <TooltipPopup side="top">{activeProjectDisplayName}</TooltipPopup>
        ) : null}
      </Tooltip>
      <ComboboxPopup align="center" className="w-72 overflow-hidden">
        <ComboboxSearchInput
          aria-label="Search projects"
          placeholder="Search projects..."
          value={pickerQuery}
          onChange={(event) => setPickerQuery(event.target.value)}
        />
        <ComboboxEmpty>No matching projects.</ComboboxEmpty>
        <ComboboxList>
          {(item: PickerItem) => {
            // T3-CUSTOM(expbkt3): BEGIN — a machine row names its environment.
            const projectItem = projectPickerItemByValue.get(item.value);
            const entry = projectItem
              ? projectEntryByKey.get(projectItem.group.projectKey)
              : undefined;
            const appearance =
              projectItem?.environmentId == null
                ? null
                : appearances.get(projectItem.environmentId);
            // T3-CUSTOM(expbkt3): END
            return (
              <ComboboxItem key={item.value} hideIndicator value={item}>
                {item.value === ADD_PROJECT_VALUE ? (
                  <FolderPlusIcon className="size-4 shrink-0" />
                ) : entry ? (
                  <ProjectFavicon project={entry.group} className="size-4 shrink-0" />
                ) : null}
                <Tooltip>
                  <TooltipTrigger render={<span className="min-w-0 flex-1 text-sm" />}>
                    <DraftProjectName value={item.label} />
                  </TooltipTrigger>
                  <TooltipPopup side="top">{item.label}</TooltipPopup>
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
                ) : entry && showProjectEnvironments ? (
                  <ProjectEnvironmentBadge
                    group={entry.group}
                    primaryEnvironmentId={primaryEnvironmentId}
                    machineByEnvironmentId={environmentMachineById}
                  />
                ) : null}
              </ComboboxItem>
            );
          }}
        </ComboboxList>
      </ComboboxPopup>
    </Combobox>
  ) : (
    <button
      type="button"
      onClick={openAddProject}
      className="pointer-events-auto inline cursor-pointer border-muted-foreground/35 border-b border-dotted text-muted-foreground/60 transition-colors hover:border-muted-foreground/60 hover:text-muted-foreground/80 focus-visible:rounded-sm focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
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
      {/* An explicit heading label hides the inline project picker in NVDA browse mode. */}
      <h1 className="w-full text-center font-normal text-2xl text-foreground tracking-tight sm:text-3xl">
        {isScratchDraft ? (
          <>What should we work on?</>
        ) : hasResolvedProject ? (
          <>
            What should we build in <span className="whitespace-nowrap">{projectSelector}?</span>
          </>
        ) : canChooseProject ? (
          <>{projectSelector} to start</>
        ) : (
          <>Add a project to start</>
        )}
      </h1>
      {}
      {scratchWorkspaceRoot === null ? null : (
        <p className="mt-2 flex h-6 w-full items-center justify-center text-sm">
          {isScratchDraft ? projectSelector : orStartWithoutProject}
        </p>
      )}
    </div>
  );
  // T3-CUSTOM(expbkt3): END
}
