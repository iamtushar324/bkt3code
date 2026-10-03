import { resolveSettledTimestamp } from "@t3tools/client-runtime/state/phase-sidebar";
import { PullRequestGlyph } from "./pullRequest/pullRequestIcons";
import { useAtomValue } from "@effect/atom-react";
import {
  scopedProjectKey,
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { canSnooze, threadWokeAt } from "@t3tools/client-runtime/state/thread-settled";
import {
  ProviderDriverKind,
  type EnvironmentId,
  type ProjectId,
  type LinearIssueStatusSummary,
  type ScopedThreadRef,
  // T3-CUSTOM(expbkt3): session lineage.
  type ThreadId,
  type VcsStatusResult,
} from "@t3tools/contracts";
import { useParams, useRouter } from "@tanstack/react-router";
import {
  // T3-CUSTOM(expbkt3): subtree running counter.
  ActivityIcon,
  AlarmClockIcon,
  ArchiveIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ClockIcon,
  CornerDownRightIcon,
  FilterIcon,
  FolderGit2Icon,
  // T3-CUSTOM(expbkt3): PR badge in the row metadata lane.
  LayersIcon,
  LaptopIcon,
  PencilIcon,
  PlusIcon,
  RotateCcwIcon,
  // T3-CUSTOM(expbkt3): BEGIN — bulk session manager entry point.
  // T3-CUSTOM(expbkt3): END
  SearchIcon,
  // T3-CUSTOM(expbkt3): unsent composer text mirrors the stock sidebar pen.
  SquarePenIcon,
  // T3-CUSTOM(expbkt3): BEGIN — signals the stock sidebar shows and this one did not.
  PinIcon,
  TerminalIcon,
  Trash2Icon,
  TriangleAlertIcon,
  // T3-CUSTOM(expbkt3): END
  XIcon,
} from "lucide-react";
import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { useShallow } from "zustand/react/shallow";

import { isElectron } from "../env";
import { openCommandPalette } from "../commandPaletteBus";
import { useComposerDraftStore, useThreadHasUnsentDraft } from "../composerDraftStore";
import { useClientSettings } from "../hooks/useSettings";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import { useNowMinute } from "../hooks/useNowMinute";
import { useThreadActions } from "../hooks/useThreadActions";
import {
  resolveShortcutCommand,
  shortcutLabelForCommand,
  shouldShowThreadJumpHintsForModifiers,
  threadJumpCommandForIndex,
  threadJumpIndexFromCommand,
  threadTraversalDirectionFromCommand,
} from "../keybindings";
import { isTerminalFocused } from "../lib/terminalFocus";
// T3-CUSTOM(expbkt3): side-by-side sessions need their own thread id up front.
import { cn, isMacPlatform, newThreadId, randomHex } from "../lib/utils";
// T3-CUSTOM(expbkt3): temporary branch for a new-worktree tab started from a row.
import { buildTemporaryWorktreeBranchName } from "@t3tools/shared/git";
import { resolveNewThreadDefaults } from "@t3tools/shared/newThreadDefaults.expbkt3";
// T3-CUSTOM(expbkt3): every link opens in the integrated browser.
import {
  opensInIntegratedBrowser,
  useOpenInIntegratedBrowser,
} from "../fork/integratedBrowserLinks";
import { readLocalApi } from "../localApi";
import { isModelPickerOpen } from "../modelPickerVisibility";
import { releaseComposerDraftUploads } from "../lib/composerDraftUploads";
import { usePhaseSidebarFilterStore } from "../phaseSidebarFilterStore";
import { useShortcutModifierState } from "../shortcutModifierState";
import {
  useEnvironmentAppearances,
  useEnvironments,
  usePrimaryEnvironmentId,
} from "../state/environments";
// T3-CUSTOM(expbkt3): BEGIN — per-environment identity in a multi-environment sidebar.
import type { ResolvedEnvironmentAppearance } from "../state/environmentAppearance";
import { EnvironmentBadgeView } from "./environment/EnvironmentBadge";
// T3-CUSTOM(expbkt3): END
import { useProjects, useServerConfigs, useThreadShells } from "../state/entities";
import {
  environmentServerConfigsAtom,
  primaryServerKeybindingsAtom,
  primaryServerSettingsAtom,
} from "../state/server";
import { allEnvironmentShellsLiveAtom } from "../state/shell";
// T3-CUSTOM(expbkt3): running terminal subprocesses, shown on the row as upstream does.
import { useThreadRunningTerminalIds } from "../state/terminalSessions";
// T3-CUSTOM(expbkt3): live Linear state for tagged lifecycle rows.
import { linearIssueStatusesEnvironment } from "../state/linearIssues";
import { threadEnvironment, useEnvironmentThread } from "../state/threads";
// T3-CUSTOM(expbkt3): a thread created from the sidebar is only navigable once
// its shell row exists locally.
import { waitForThreadShell } from "../state/threadShellArrival";
import { useEnvironmentQuery } from "../state/query";
import { vcsEnvironment } from "../state/vcs";
import { useAtomCommand } from "../state/use-atom-command";
import { buildThreadRouteParams, resolveThreadRouteRef } from "../threadRoutes";
import { useThreadSelectionStore } from "../threadSelectionStore";
import { formatRelativeTimeLabel } from "../timestampFormat";
import type { TimestampFormat } from "@t3tools/contracts";
import type { Project } from "../types";
import { useUiStateStore } from "../uiStateStore";
import { ProjectFavicon } from "./ProjectFavicon";
import { LinearIcon } from "./Icons";
import { ProviderInstanceIcon } from "./chat/ProviderInstanceIcon";
// T3-CUSTOM(expbkt3): owner avatar on rows started by someone else.
import { PhaseSidebarOwnerAvatar } from "./sidebar/PhaseSidebarOwnerAvatar";
import {
  hasUnseenCompletion,
  isTrailingDoubleClick,
  shouldClearThreadSelectionOnMouseDown,
  useRetainedValue,
  useSidebarRowSubscriptionLease,
} from "./Sidebar.logic";
import {
  resolveSnoozePresets,
  snoozeWakeDescription,
  snoozeWakeLabel,
  type SnoozePreset,
} from "./Sidebar.snooze";
import {
  PHASE_SIDEBAR_PHASES,
  buildPhaseSidebarFilterChips,
  buildPhaseSidebarRepositoryOptions,
  comparePhaseSidebarRows,
  derivePhaseSidebarRepositoryKey,
  filterVisiblePhaseSidebarRows,
  isThreadAssignedToUser,
  phaseSidebarRowOwnerAvatarUserId,
  partitionPhaseSidebarRows,
  // T3-CUSTOM(expbkt3): Session priority badge tone.
  phaseSidebarPriorityBadgeClassName,
  phaseSidebarCanForceStopAgent,
  // T3-CUSTOM(expbkt3): memorable worktree codenames.
  phaseSidebarCheckoutToneClassName,
  phaseSidebarWorktreeRowProps,
  resolvePhaseSidebarWorktreeView,
  phaseSidebarIsExecutionActive,
  resolvePhaseSidebarAttentionKind,
  resolvePhaseSidebarAttentionPriority,
  resolvePhaseSidebarCheckoutMetadata,
  // T3-CUSTOM(expbkt3): PR number + colour-only state in the row.
  resolvePhaseSidebarChangeRequestBadge,
  resolvePhaseSidebarDisplayPhase,
  resolvePhaseSidebarPhase,
  buildPhaseSidebarRows,
  resolvePhaseSidebarLinearIssue,
  resolvePhaseSidebarMattermostLink,
  resolvePhaseSidebarProviderCode,
  resolvePhaseSidebarTraversalTarget,
  resolvePhaseSidebarWorkBadge,
  phaseSidebarRowActionsClassName,
  phaseSidebarRowClassName,
  formatThreadPriority,
  PHASE_SIDEBAR_PRIORITY_CHOICES,
  // T3-CUSTOM(expbkt3): strict in-group ordering.
  PHASE_SIDEBAR_SORT_DIRECTION_LABELS,
  // T3-CUSTOM(expbkt3): ownership and co-participant facets.
  phaseSidebarThreadParticipantIds,
  compactPhaseSidebarTimeLabel,
  type PhaseSidebarAttentionKind,
  type PhaseSidebarPhaseId,
  type PhaseSidebarRow,
  type PhaseSidebarSection,
  type PhaseSidebarSortDirection,
} from "./sidebar/PhaseGroupedSidebar.logic";
// T3-CUSTOM(expbkt3): BEGIN — adaptive fork-owned phase-row layout.
import {
  PHASE_SIDEBAR_CONTENT_CLASS_NAME,
  PHASE_SIDEBAR_METADATA_CLASS_NAME,
} from "./sidebar/PhaseSidebarRowLayout";
// T3-CUSTOM(expbkt3): END
// T3-CUSTOM(expbkt3): BEGIN — session trees.
import {
  collectPhaseSidebarSubtreeKeys,
  flattenPhaseSidebarTree,
  phaseSidebarTreeIndent,
  type PhaseSidebarTreeNode,
} from "./sidebar/PhaseSidebarTree.logic";
import { usePhaseSidebarTreeStore } from "../phaseSidebarTreeStore";
// T3-CUSTOM(expbkt3): group by lifecycle / project / custom groups.
import {
  buildPhaseSidebarSections,
  listPhaseSidebarCustomGroups,
  PHASE_SIDEBAR_UNGROUPED_ID,
  phaseSidebarCustomGroupIdForRow,
  phaseSidebarLocalCustomGroupForThread,
  phaseSidebarSectionPhase,
  type PhaseSidebarCustomGroupOption,
  type PhaseSidebarSection as PhaseSidebarGroupSection,
} from "@t3tools/client-runtime/state/phase-sidebar-grouping";
import { usePhaseSidebarGroupingStore } from "../phaseSidebarGroupingStore";
import { PhaseSidebarGroupByPopover } from "./sidebar/PhaseSidebarGroupByPopover";
import { PhaseSidebarGroupNameDialog } from "./sidebar/PhaseSidebarGroupNameDialog";
import { phaseSidebarSectionHeaderClassName } from "./sidebar/PhaseGroupedSidebar.logic";
import { MoveUnderSessionDialog } from "./sidebar/MoveUnderSessionDialog";
import { NewThreadProjectPicker } from "./sidebar/NewThreadProjectPicker";
// T3-CUSTOM(expbkt3): "Create new thread" from a row, as a side-by-side session.
import {
  buildNewThreadFromRowCreateInput,
  canCreateWorktreeFromParent,
  resolveSameWorktreeWorkspace,
  type NewThreadWorkspaceChoice,
} from "./sidebar/NewThreadFromRow.logic";
// T3-CUSTOM(expbkt3): END
import { useCurrentUserId } from "../state/identity";
// T3-CUSTOM(expbkt3): directory for the co-participant filter facet.
import { useOrgMembers } from "../state/orgMembers";
import { useLongPressContextMenu } from "../mobile/useLongPressContextMenu";
import {
  SidebarChromeFooter,
  SidebarChromeHeader,
  SidebarEnvironmentNotices,
} from "./sidebar/SidebarChrome";
import { SidebarSearchAction } from "./sidebar/SidebarSearchAction";
import { autoAnimatedListRef } from "./sidebar/autoAnimatedList";
import { RunningSessionGlint } from "./sidebar/RunningSessionGlint";
import { RunningSessionDivider } from "./sidebar/RunningSessionDivider";
import {
  runningSessionDividerPhase,
  shouldShowRunningSessionGlint,
} from "./sidebar/RunningSessionGlint.logic";
// T3-CUSTOM(expbkt3): teammate avatars in the filter popover.
import { Avatar, userDisplayName } from "./ui/avatar";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { Input } from "./ui/input";
import { Kbd } from "./ui/kbd";
import { Popover, PopoverPopup, PopoverTrigger } from "./ui/popover";
import {
  SidebarContent,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "./ui/sidebar";
import { Separator } from "./ui/separator";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { PhaseSidebarUnreadIndicator } from "./sidebar/PhaseSidebarUnreadIndicator";
import { LinearIssueTagDialog } from "./sidebar/LinearIssueTagDialog";
import { MattermostLinkDialog } from "./sidebar/MattermostLinkDialog";
import { MattermostThreadBadge } from "./sidebar/MattermostThreadBadge";

// T3-CUSTOM(expbkt3): Settled-tail paging — recent history is the common
// lookup; the deep tail stays behind an explicit Show more.
const SETTLED_TAIL_INITIAL_COUNT = 10;
const SETTLED_TAIL_PAGE_COUNT = 25;

const linearIssueStatusKey = (environmentId: string, identifier: string) =>
  `${environmentId}\0${identifier}`;

// The failed branch of a settle/snooze command — the four of them share one
// error reporter, so it takes the widened failure shape.
type ParkingCommandFailure = Extract<
  AtomCommandResult<unknown, unknown>,
  { readonly _tag: "Failure" }
>;

// Row hover affordances live in a shared overlay pill, so they need one
// shared button shape.
const ROW_ACTION_CLASS =
  "inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

type RepositoryOption = ReturnType<typeof buildPhaseSidebarRepositoryOptions>[number];

interface ProviderOption {
  readonly kind: string;
  readonly code: string;
  readonly name: string;
}

function SidebarThreadDetailPrewarmer({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  useEnvironmentThread(threadRef.environmentId, threadRef.threadId);
  return null;
}

// T3-CUSTOM(expbkt3): one batched status request per environment keeps a long
// sidebar from issuing one Bifrost request per row.
function LinearIssueStatusProbe({
  environmentId,
  identifiers,
  refreshMinute,
  onStatus,
}: {
  readonly environmentId: EnvironmentId;
  readonly identifiers: ReadonlyArray<string>;
  readonly refreshMinute: string;
  readonly onStatus: (
    environmentId: EnvironmentId,
    identifiers: ReadonlyArray<string>,
    issues: ReadonlyArray<LinearIssueStatusSummary> | null,
    error: string | null,
  ) => void;
}) {
  const { data, error, refresh } = useEnvironmentQuery(
    linearIssueStatusesEnvironment({ environmentId, input: { identifiers } }),
  );
  const previousRefreshMinute = useRef(refreshMinute);

  useEffect(() => {
    onStatus(environmentId, identifiers, data?.issues ?? null, error);
  }, [data, environmentId, error, identifiers, onStatus]);

  useEffect(() => {
    if (previousRefreshMinute.current === refreshMinute) return;
    previousRefreshMinute.current = refreshMinute;
    refresh();
  }, [refresh, refreshMinute]);

  return null;
}

function PhaseFilterPopover({
  repositories,
  providers,
  groups,
}: {
  readonly repositories: ReadonlyArray<RepositoryOption>;
  readonly providers: ReadonlyArray<ProviderOption>;
  // T3-CUSTOM(expbkt3): the custom groups in view, for the Group facet.
  readonly groups: ReadonlyArray<PhaseSidebarCustomGroupOption>;
}) {
  const [search, setSearch] = useState("");
  const currentUserId = useCurrentUserId();
  const assignmentAvailable = currentUserId !== null;
  const {
    repositoryKeys,
    phaseIds,
    providerKinds,
    ownedByMe,
    participantUserIds,
    customGroups,
    sort,
    toggleRepository,
    togglePhase,
    toggleProvider,
    toggleOwnedByMe,
    toggleParticipant,
    toggleCustomGroup,
    setSortDirection,
    togglePriorityFirst,
  } = usePhaseSidebarFilterStore(
    useShallow((state) => ({
      repositoryKeys: state.repositoryKeys,
      phaseIds: state.phaseIds,
      providerKinds: state.providerKinds,
      ownedByMe: state.ownedByMe,
      participantUserIds: state.participantUserIds,
      customGroups: state.customGroups,
      sort: state.sort,
      toggleRepository: state.toggleRepository,
      togglePhase: state.togglePhase,
      toggleProvider: state.toggleProvider,
      toggleOwnedByMe: state.toggleOwnedByMe,
      toggleParticipant: state.toggleParticipant,
      toggleCustomGroup: state.toggleCustomGroup,
      setSortDirection: state.setSortDirection,
      togglePriorityFirst: state.togglePriorityFirst,
    })),
  );
  // T3-CUSTOM(expbkt3): everyone except the operator — "sessions I share with
  // this person" is the question; a self entry would just mean "all of them".
  const { users } = useOrgMembers();
  const teammates = useMemo(
    () => users.filter((user) => user.id !== currentUserId),
    [currentUserId, users],
  );
  const selectionCount =
    repositoryKeys.length +
    phaseIds.length +
    providerKinds.length +
    participantUserIds.length +
    customGroups.length +
    (assignmentAvailable && ownedByMe ? 1 : 0);
  const needle = search.trim().toLowerCase();
  const visibleRepositories = repositories.filter((option) =>
    option.searchText.toLowerCase().includes(needle),
  );
  const visiblePhases = PHASE_SIDEBAR_PHASES.filter((phase) =>
    phase.label.toLowerCase().includes(needle),
  );
  const visibleProviders = providers.filter((option) =>
    `${option.code} ${option.name} ${option.kind}`.toLowerCase().includes(needle),
  );
  // T3-CUSTOM(expbkt3): sort controls answer to the same search box as the facets.
  const sortSearchText = `sort order priority ${Object.values(
    PHASE_SIDEBAR_SORT_DIRECTION_LABELS,
  ).join(" ")}`.toLowerCase();
  const sortVisible = sortSearchText.includes(needle);
  // T3-CUSTOM(expbkt3): the new facets answer to the same search box.
  const ownershipVisible = assignmentAvailable && "ownership started by me".includes(needle);
  const visibleTeammates = teammates.filter((user) =>
    `${user.name ?? ""} ${user.email ?? ""}`.toLowerCase().includes(needle),
  );
  // T3-CUSTOM(expbkt3): the Group facet lists every group in view plus the
  // "Ungrouped" catch-all; a group already selected stays listed even when
  // its sessions have all moved, so the selection can be undone here.
  const groupOptions = [
    ...groups,
    ...customGroups
      .filter((id) => id !== PHASE_SIDEBAR_UNGROUPED_ID && !groups.some((g) => g.id === id))
      .map((id) => ({ id, label: id, count: 0 })),
  ];
  const visibleGroups =
    groups.length === 0 && customGroups.length === 0
      ? []
      : [
          ...groupOptions.filter((group) => group.label.toLowerCase().includes(needle)),
          ...("ungrouped".includes(needle)
            ? [{ id: PHASE_SIDEBAR_UNGROUPED_ID, label: "Ungrouped", count: 0 }]
            : []),
        ];

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            variant="outline"
            size="sm"
            className="h-7 gap-1.5 px-2 text-xs"
            aria-label="Filter phase sidebar"
          />
        }
      >
        <FilterIcon className="size-3" />
        Filter
        {selectionCount > 0 ? (
          <Badge size="sm" className="ml-0.5 h-4 min-w-4 rounded-full px-1 text-[9px]">
            {selectionCount}
          </Badge>
        ) : null}
      </PopoverTrigger>
      <PopoverPopup align="start" className="w-72" padding="none">
        <div className="sticky top-0 z-10 border-b bg-popover p-2">
          <div className="relative">
            <SearchIcon className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search facets"
              aria-label="Search filter options"
              className="h-7 pl-7 text-xs"
            />
          </div>
        </div>
        <div className="max-h-[min(28rem,var(--available-height))] space-y-3 overflow-y-auto p-2">
          {/* T3-CUSTOM(expbkt3): ordering inside each lifecycle group. */}
          {sortVisible ? (
            <FacetSection label="Sort within each group">
              <div role="radiogroup" aria-label="Sort within each group" className="space-y-0.5">
                {(
                  Object.entries(PHASE_SIDEBAR_SORT_DIRECTION_LABELS) as ReadonlyArray<
                    [PhaseSidebarSortDirection, string]
                  >
                ).map(([direction, label]) => (
                  <SortDirectionOption
                    key={direction}
                    checked={sort.direction === direction}
                    label={label}
                    onSelect={() => setSortDirection(direction)}
                  />
                ))}
              </div>
              <FacetOption
                checked={sort.priorityFirst}
                label="Priority first (P0 above lower priorities)"
                onCheckedChange={() => togglePriorityFirst()}
              />
            </FacetSection>
          ) : null}
          <FacetSection label="Repository">
            {visibleRepositories.map((option) => (
              <FacetOption
                key={option.key}
                checked={repositoryKeys.includes(option.key)}
                label={option.label}
                onCheckedChange={() => toggleRepository(option.key)}
                leading={
                  <ProjectFavicon
                    // T3-CUSTOM(expbkt3): upstream takes the project record whole so the
                    // saved title, favicon and icon override always travel together.
                    project={option.project}
                    className="size-3"
                  />
                }
              />
            ))}
          </FacetSection>
          <FacetSection label="Lifecycle phase">
            {visiblePhases.map((phase) => (
              <FacetOption
                key={phase.id}
                checked={phaseIds.includes(phase.id)}
                label={phase.label}
                onCheckedChange={() => togglePhase(phase.id)}
              />
            ))}
          </FacetSection>
          <FacetSection label="Provider">
            {visibleProviders.map((provider) => (
              <FacetOption
                key={provider.kind}
                checked={providerKinds.includes(provider.kind)}
                label={provider.name}
                onCheckedChange={() => toggleProvider(provider.kind)}
                leading={
                  <ProviderInstanceIcon
                    driverKind={ProviderDriverKind.make(provider.kind)}
                    displayName={provider.name}
                    className="size-3"
                    iconClassName="size-3"
                  />
                }
              />
            ))}
          </FacetSection>
          {/* T3-CUSTOM(expbkt3): BEGIN — ownership and co-participant facets. */}
          {ownershipVisible ? (
            <FacetSection label="Ownership">
              <FacetOption
                checked={ownedByMe}
                label="Started by me"
                onCheckedChange={() => toggleOwnedByMe()}
              />
            </FacetSection>
          ) : null}
          {assignmentAvailable && visibleTeammates.length > 0 ? (
            <FacetSection label="People on the session">
              {visibleTeammates.map((user) => (
                <FacetOption
                  key={user.id}
                  checked={participantUserIds.includes(user.id)}
                  label={userDisplayName(user)}
                  onCheckedChange={() => toggleParticipant(user.id)}
                  leading={<Avatar size="xs" user={user} />}
                />
              ))}
            </FacetSection>
          ) : null}
          {visibleGroups.length > 0 ? (
            <FacetSection label="Group">
              {visibleGroups.map((group) => (
                <FacetOption
                  key={group.id}
                  checked={customGroups.includes(group.id)}
                  label={group.label}
                  onCheckedChange={() => toggleCustomGroup(group.id)}
                />
              ))}
            </FacetSection>
          ) : null}
          {/* T3-CUSTOM(expbkt3): END */}
          {visibleRepositories.length + visiblePhases.length + visibleProviders.length === 0 &&
          !sortVisible &&
          !ownershipVisible &&
          visibleTeammates.length === 0 &&
          visibleGroups.length === 0 ? (
            <p className="px-2 py-6 text-center text-xs text-muted-foreground">
              No filter options match.
            </p>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}

function FacetSection({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}) {
  return (
    <section>
      <h3 className="px-2 pb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
        {label}
      </h3>
      <div className="space-y-0.5">{children}</div>
    </section>
  );
}

/**
 * T3-CUSTOM(expbkt3): single-select row for the sort direction. Checkboxes would
 * imply the two directions can both be on.
 */
function SortDirectionOption({
  checked,
  label,
  onSelect,
}: {
  readonly checked: boolean;
  readonly label: string;
  readonly onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      onClick={onSelect}
      className={cn(
        "flex min-h-7 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left text-xs hover:bg-accent",
        checked ? "text-foreground" : "text-muted-foreground",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "flex size-3.5 shrink-0 items-center justify-center rounded-full border",
          checked ? "border-primary" : "border-muted-foreground/40",
        )}
      >
        {checked ? <span className="size-1.5 rounded-full bg-primary" /> : null}
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </button>
  );
}

function FacetOption({
  checked,
  label,
  leading,
  onCheckedChange,
}: {
  readonly checked: boolean;
  readonly label: string;
  readonly leading?: React.ReactNode;
  readonly onCheckedChange: () => void;
}) {
  return (
    <label className="flex min-h-7 cursor-pointer items-center gap-2 rounded-md px-2 text-xs hover:bg-accent">
      <Checkbox checked={checked} onCheckedChange={onCheckedChange} />
      {leading}
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </label>
  );
}

function ActiveFilterChips({
  repositoryLabels,
  providerLabels,
  customGroupLabels,
}: {
  readonly repositoryLabels: ReadonlyMap<string, string>;
  readonly providerLabels: ReadonlyMap<string, string>;
  // T3-CUSTOM(expbkt3): display labels for custom group ids.
  readonly customGroupLabels: ReadonlyMap<string, string>;
}) {
  const {
    repositoryKeys,
    phaseIds,
    providerKinds,
    ownedByMe,
    participantUserIds,
    customGroups,
    toggleRepository,
    togglePhase,
    toggleProvider,
    toggleOwnedByMe,
    toggleParticipant,
    toggleCustomGroup,
    clearAll,
  } = usePhaseSidebarFilterStore(
    useShallow((state) => ({
      repositoryKeys: state.repositoryKeys,
      phaseIds: state.phaseIds,
      providerKinds: state.providerKinds,
      ownedByMe: state.ownedByMe,
      participantUserIds: state.participantUserIds,
      customGroups: state.customGroups,
      toggleRepository: state.toggleRepository,
      togglePhase: state.togglePhase,
      toggleProvider: state.toggleProvider,
      toggleOwnedByMe: state.toggleOwnedByMe,
      toggleParticipant: state.toggleParticipant,
      toggleCustomGroup: state.toggleCustomGroup,
      clearAll: state.clearAll,
    })),
  );
  // T3-CUSTOM(expbkt3): a person chip reads as their name, not an opaque id.
  const { users } = useOrgMembers();
  const peopleLabels = useMemo(
    () => new Map(users.map((user) => [String(user.id), userDisplayName(user)] as const)),
    [users],
  );
  const chips = buildPhaseSidebarFilterChips(
    { repositoryKeys, phaseIds, providerKinds, ownedByMe, participantUserIds, customGroups },
    {
      repositories: repositoryLabels,
      providers: providerLabels,
      people: peopleLabels,
      customGroups: customGroupLabels,
    },
  );
  if (chips.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-1 pt-1.5" data-testid="phase-filter-chips">
      {chips.map((chip) => (
        <FilterChip
          key={`${chip.facet}:${chip.value}`}
          label={chip.label}
          onRemove={() => {
            if (chip.facet === "repository") toggleRepository(chip.value);
            if (chip.facet === "phase") togglePhase(chip.value as PhaseSidebarPhaseId);
            if (chip.facet === "provider") toggleProvider(chip.value);
            if (chip.facet === "assignment") toggleOwnedByMe();
            if (chip.facet === "person") toggleParticipant(chip.value);
            if (chip.facet === "group") toggleCustomGroup(chip.value);
          }}
        />
      ))}
      <button
        type="button"
        className="px-1 text-[10px] text-muted-foreground hover:text-foreground"
        onClick={clearAll}
      >
        Clear all
      </button>
    </div>
  );
}

function FilterChip({
  label,
  onRemove,
}: {
  readonly label: string;
  readonly onRemove: () => void;
}) {
  return (
    <Badge variant="secondary" size="sm" className="max-w-full gap-0.5 pr-0.5">
      <span className="max-w-32 truncate">{label}</span>
      <button
        type="button"
        aria-label={`Remove ${label} filter`}
        className="rounded-sm p-0.5 hover:bg-foreground/10"
        onClick={onRemove}
      >
        <XIcon className="size-2.5" />
      </button>
    </Badge>
  );
}

/**
 * T3-CUSTOM(expbkt3): Hover entry point for snooze — a clock button opening
 * the preset menu. The row owns the open state so it can pin its hover
 * actions visible while the menu is up (opening the popup moves the pointer
 * off the row).
 *
 * The trigger renders as a role="button" span, not a <button>: the whole
 * sidebar row is itself a <button> and nesting one inside it is invalid.
 */
function PhaseSnoozePopoverButton({
  open,
  label,
  testId,
  onOpenChange,
  onSnooze,
  timestampFormat,
}: {
  readonly open: boolean;
  readonly label: string;
  readonly testId?: string;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSnooze: (preset: SnoozePreset) => void;
  readonly timestampFormat: TimestampFormat;
}) {
  // Presets resolve at open time so "In 1 hour" is relative to the click,
  // not to when the row mounted.
  const presets = useMemo(
    () => (open ? resolveSnoozePresets(new Date(), timestampFormat) : []),
    [open, timestampFormat],
  );
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      {/* Plain title instead of a Tooltip wrapper: composing a tooltip
          trigger around a popover trigger would give this one span two
          owners of the same `render` slot. */}
      <PopoverTrigger
        render={
          <span
            role="button"
            tabIndex={0}
            aria-label={label}
            data-testid={testId}
            className={ROW_ACTION_CLASS}
            onClick={(event) => event.stopPropagation()}
            onDoubleClick={(event) => event.stopPropagation()}
          />
        }
      >
        <ClockIcon className="size-3.5" />
      </PopoverTrigger>
      <PopoverPopup side="bottom" align="end" className="w-56" padding="compact">
        {presets.map((preset) => (
          <button
            key={preset.id}
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onOpenChange(false);
              onSnooze(preset);
            }}
            className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-foreground/90 hover:bg-accent hover:text-foreground"
          >
            <span className="flex-1">{preset.label}</span>
            <span className="font-mono text-[10px] tabular-nums text-muted-foreground/60">
              {preset.whenLabel}
            </span>
          </button>
        ))}
      </PopoverPopup>
    </Popover>
  );
}

/**
 * T3-CUSTOM(expbkt3): One hover action in the row overlay. Same
 * nested-button constraint as the snooze trigger above.
 */
function PhaseRowAction({
  label,
  tooltip,
  testId,
  onClick,
  children,
}: {
  readonly label: string;
  readonly tooltip: string;
  readonly testId?: string;
  readonly onClick: () => void;
  readonly children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="button"
            tabIndex={0}
            aria-label={label}
            data-testid={testId}
            className={ROW_ACTION_CLASS}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onClick();
            }}
            onDoubleClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              event.stopPropagation();
              onClick();
            }}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipPopup side="top">{tooltip}</TooltipPopup>
    </Tooltip>
  );
}

interface PhaseThreadRowProps {
  readonly row: PhaseSidebarRow;
  readonly section: PhaseSidebarSection;
  readonly project: Project | null;
  // T3-CUSTOM(expbkt3): set only when the rendered rows span more than one
  // environment; a single-environment sidebar stays exactly as it was.
  readonly environmentAppearance?: ResolvedEnvironmentAppearance | undefined;
  readonly vcsStatus: VcsStatusResult | null;
  // T3-CUSTOM(expbkt3): VCS queries lease the actual visible row instead of
  // keeping subscriptions alive for collapsed and offscreen sessions.
  readonly onWorkflowStatus: (threadKey: string, status: VcsStatusResult | null) => void;
  // T3-CUSTOM(expbkt3): mirror the stock sidebar's reversible pin action.
  readonly pinningSupported: boolean;
  readonly onPin: (row: PhaseSidebarRow) => void;
  readonly onUnpin: (row: PhaseSidebarRow) => void;
  // T3-CUSTOM(expbkt3): BEGIN — worktree codename, flattened to primitives so
  // this memo'd row still compares by value.
  readonly worktreeCodename: string | null;
  readonly worktreeSharedCount: number;
  readonly worktreeSharedSummary: string | null;
  // T3-CUSTOM(expbkt3): END
  readonly active: boolean;
  readonly orderedThreadKeys: ReadonlyArray<string>;
  readonly jumpLabel: string | null;
  readonly renaming: boolean;
  readonly renameTitle: string;
  readonly onRenameTitleChange: (title: string) => void;
  readonly onStartRename: (row: PhaseSidebarRow) => void;
  readonly onCommitRename: (row: PhaseSidebarRow) => void;
  readonly onCancelRename: () => void;
  readonly onNavigate: (threadRef: ScopedThreadRef) => void;
  readonly onForceStop: (row: PhaseSidebarRow) => void;
  readonly onArchive: (row: PhaseSidebarRow) => void;
  readonly onDelete: (row: PhaseSidebarRow) => void;
  readonly onSettle: (row: PhaseSidebarRow) => void;
  readonly onUnsettle: (row: PhaseSidebarRow) => void;
  readonly onSnooze: (row: PhaseSidebarRow, preset: SnoozePreset) => void;
  readonly onUnsnooze: (row: PhaseSidebarRow) => void;
  // T3-CUSTOM(expbkt3): null clears the priority.
  readonly onSetPriority: (row: PhaseSidebarRow, priority: 0 | 1 | 2 | 3 | 4 | null) => void;
  // T3-CUSTOM(expbkt3): null clears a manually attached Linear issue.
  readonly onSetLinearIssueUrl: (row: PhaseSidebarRow, url: string | null) => void;
  readonly onSetMattermostThreadUrl: (row: PhaseSidebarRow, url: string | null) => void;
  // T3-CUSTOM(expbkt3): re-derive the title from the conversation.
  readonly onRegenerateTitle: (row: PhaseSidebarRow) => void;
  readonly linearIssueStatus: LinearIssueStatusSummary | null;
  // T3-CUSTOM(expbkt3): start a side-by-side session from this row. Offered on
  // shelf rows too — a parked session is a perfectly good place to branch from.
  readonly onCreateThread: (row: PhaseSidebarRow, choice: NewThreadWorkspaceChoice) => void;
  // T3-CUSTOM(expbkt3): BEGIN — session tree. Deliberately flat primitives plus
  // one stable actions object rather than a per-row object: this row is memo'd
  // and the sidebar re-renders on every shell event, so a fresh object per
  // render would defeat the memo for the entire active list.
  // `treeActions` absent = shelf row, which renders as flat history.
  readonly treeActions?: PhaseThreadRowTreeActions;
  readonly treeDepth?: number;
  readonly treeDescendantCount?: number;
  readonly treeHasBusyDescendant?: boolean;
  // Exact subtree counts, shown open or closed: the number is what tells you
  // whether the fan-out needs attention now or later.
  readonly treeDescendantUnreadCount?: number;
  readonly treeDescendantRunningCount?: number;
  readonly treeDescendantAttention?: PhaseSidebarAttentionKind | null;
  readonly treeExpanded?: boolean;
  readonly treeParentKey?: string | null;
  readonly treeParentTitle?: string | null;
  // T3-CUSTOM(expbkt3): END
  // T3-CUSTOM(expbkt3): BEGIN — custom groups. One stable actions object plus
  // the row's own group id, for the same memo reason as the tree props above.
  // `groupActions` absent = the host cannot store custom groups.
  readonly groupActions?: PhaseThreadRowGroupActions;
  readonly customGroupId?: string | null;
  /** The group's display label, shown as a chip outside Custom mode only. */
  readonly customGroupLabel?: string | null;
  // T3-CUSTOM(expbkt3): END
}

/** T3-CUSTOM(expbkt3): "Move to group" from a row. */
interface PhaseThreadRowGroupActions {
  readonly groups: ReadonlyArray<{ readonly id: string; readonly label: string }>;
  readonly onAssign: (row: PhaseSidebarRow, groupId: string | null) => void;
  readonly onCreateGroupWith: (row: PhaseSidebarRow) => void;
}

/**
 * T3-CUSTOM(expbkt3): Tree actions, keyed by scoped thread key so one object
 * instance serves every row.
 */
type PhaseThreadRowTreeProps = Pick<
  PhaseThreadRowProps,
  | "treeActions"
  | "treeDepth"
  | "treeDescendantCount"
  | "treeHasBusyDescendant"
  | "treeDescendantUnreadCount"
  | "treeDescendantRunningCount"
  | "treeDescendantAttention"
  | "treeExpanded"
  | "treeParentKey"
  | "treeParentTitle"
>;

interface PhaseThreadRowTreeActions {
  readonly onToggle: (threadKey: string) => void;
  readonly onSetSubtreeExpanded: (threadKey: string, expanded: boolean) => void;
  readonly onMoveUnder: (row: PhaseSidebarRow) => void;
  readonly onDetach: (row: PhaseSidebarRow) => void;
  readonly onJumpToParent: (parentKey: string) => void;
}

const PhaseThreadRow = memo(function PhaseThreadRow(props: PhaseThreadRowProps) {
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const {
    row,
    section,
    project,
    // T3-CUSTOM(expbkt3): present only in a multi-environment sidebar.
    environmentAppearance,
    vcsStatus,
    onWorkflowStatus,
    pinningSupported,
    onPin,
    onUnpin,
    // T3-CUSTOM(expbkt3): worktree codename.
    worktreeCodename,
    worktreeSharedCount,
    worktreeSharedSummary,
    active,
    orderedThreadKeys,
    jumpLabel,
    renaming,
    renameTitle,
    onRenameTitleChange,
    onStartRename,
    onCommitRename,
    onCancelRename,
    onNavigate,
    onForceStop,
    onArchive,
    onDelete,
    onSettle,
    onSnooze,
    onUnsettle,
    onUnsnooze,
    onSetPriority,
    onSetLinearIssueUrl,
    onSetMattermostThreadUrl,
    onRegenerateTitle,
    linearIssueStatus,
    onCreateThread,
    treeActions,
    treeDepth,
    treeDescendantCount,
    treeHasBusyDescendant,
    treeDescendantUnreadCount,
    treeDescendantRunningCount,
    treeDescendantAttention,
    treeExpanded,
    treeParentKey,
    treeParentTitle,
    groupActions,
    customGroupId,
    customGroupLabel,
  } = props;
  const threadRef = scopeThreadRef(row.thread.environmentId, row.thread.id);
  const threadKey = scopedThreadKey(threadRef);
  // T3-CUSTOM(expbkt3): BEGIN — running comes from the provider session.
  const currentUserId = useCurrentUserId();
  const sessionActive = phaseSidebarIsExecutionActive(row.thread);
  const workBadge = resolvePhaseSidebarWorkBadge({
    phaseId: row.phaseId,
    backgroundLiveness: row.thread.backgroundLiveness ?? null,
    executionPresentation: { active: sessionActive, label: null },
  });
  // T3-CUSTOM(expbkt3): END
  // T3-CUSTOM(expbkt3): whose session this is, when it is not mine.
  const ownerAvatarUserId = phaseSidebarRowOwnerAvatarUserId({
    ownerUserId: row.thread.ownerUserId,
    currentUserId,
  });
  const selected = useThreadSelectionStore((state) => state.selectedThreadKeys.has(threadKey));
  const toggleThread = useThreadSelectionStore((state) => state.toggleThread);
  const rangeSelectTo = useThreadSelectionStore((state) => state.rangeSelectTo);
  const clearSelection = useThreadSelectionStore((state) => state.clearSelection);
  const setAnchor = useThreadSelectionStore((state) => state.setAnchor);
  const lastVisitedAt = useUiStateStore((state) => state.threadLastVisitedAtById[threadKey]);
  const markThreadUnread = useUiStateStore((state) => state.markThreadUnread);
  // T3-CUSTOM(expbkt3): the native visit watermark converges across devices.
  const markUnreadOnServer = useAtomCommand(threadEnvironment.markUnread);
  // T3-CUSTOM(expbkt3): preserve the stock sidebar's unsent-draft signal and
  // discard action when the lifecycle sidebar is selected.
  const hasUnsentDraft = useThreadHasUnsentDraft(threadRef) && !active;
  const clearComposerContent = useComposerDraftStore((state) => state.clearComposerContent);
  const linearIssue = resolvePhaseSidebarLinearIssue(row.thread.branch, row.thread.linearIssueUrl);
  // T3-CUSTOM(expbkt3): every link opens in the integrated browser. A row's own link (Linear,
  // pull request, Mattermost) takes you to that row's thread and opens beside it, so the page
  // never lands in the panel of a thread you are not looking at. Cmd/Ctrl-click stays put and
  // goes to the system browser.
  const openInIntegratedBrowser = useOpenInIntegratedBrowser();
  const openRowLink = (
    url: string,
    event: { readonly metaKey: boolean; readonly ctrlKey: boolean } | undefined,
    failureTitle?: string,
  ) => {
    const inApp = opensInIntegratedBrowser(event);
    if (inApp) onNavigate(threadRef);
    openInIntegratedBrowser(url, {
      ...(event ? { event } : {}),
      ...(inApp ? { threadRef } : {}),
      fallbackThreadRef: threadRef,
      ...(failureTitle ? { failureTitle } : {}),
    });
  };
  // T3-CUSTOM(expbkt3): the Mattermost conversation following this session.
  const mattermostLink = resolvePhaseSidebarMattermostLink(row.thread.mattermostThreadUrl);
  // T3-CUSTOM(expbkt3): the row's PR reads beside its Linear tag — colour-only
  // state, number as the label.
  // T3-CUSTOM(expbkt3): tagged links first, branch detection only as a fallback —
  // a review an agent registered with `link_pull_request` is not necessarily the
  // checked-out branch's.
  const changeRequestBadge = resolvePhaseSidebarChangeRequestBadge(
    vcsStatus,
    row.thread.pullRequests,
    // T3-CUSTOM(expbkt3): the PR the server detected for this thread's branch.
    // It lives only on the thread, never in `pullRequests`, so a row that read
    // the links and the probe alone showed nothing while the chat header showed
    // the PR — the bug this closes.
    row.thread.branchPullRequest ?? row.thread.linkedPullRequest ?? null,
  );
  // T3-CUSTOM(expbkt3): worktree codename replaces the generic "Worktree" label.
  const checkoutMetadata = resolvePhaseSidebarCheckoutMetadata(row.thread, vcsStatus, {
    codename: worktreeCodename,
    sharing:
      worktreeSharedCount > 1
        ? { count: worktreeSharedCount, summary: worktreeSharedSummary ?? "" }
        : null,
  });
  const workspacePath = row.thread.worktreePath ?? project?.workspaceRoot ?? null;
  const { leaseLiveStatus, rowRef } = useSidebarRowSubscriptionLease(active);
  const workflowStatus = useEnvironmentQuery(
    leaseLiveStatus &&
      (row.thread.branch !== null || row.thread.worktreePath !== null) &&
      workspacePath !== null
      ? vcsEnvironment.status({
          environmentId: row.thread.environmentId,
          // T3-CUSTOM(expbkt3): threadId resolves this project's source-control
          // overrides server-side. Omitting it probed under the wrong profile
          // wherever a project configures one.
          input: { cwd: workspacePath, threadId: row.thread.id },
        })
      : null,
  );
  const visibleWorkflowStatus = useRetainedValue(
    `${row.thread.environmentId}\u0000${workspacePath ?? ""}`,
    workflowStatus.data,
  );
  useEffect(
    () => onWorkflowStatus(threadKey, visibleWorkflowStatus),
    [onWorkflowStatus, threadKey, visibleWorkflowStatus],
  );
  const needsUserInput = row.phaseId === "needs_input";
  const attentionKind = resolvePhaseSidebarAttentionKind(row.thread);
  // A message-mode question. It never parks the agent, so without this the row
  // is indistinguishable from a busy one while someone waits on an answer.
  // T3-CUSTOM(expbkt3): read before `planReady` because a thread can hold both,
  // and the question is the part that goes stale.
  const hasAsyncQuestion = row.thread.hasPendingAsyncUserInput === true;
  // T3-CUSTOM(expbkt3): the pulse is for a decision that is actually waiting.
  // A running row can hold a plan too, but it gets the badge only — the row is
  // still moving, so flashing it would cry wolf. This reads execution directly
  // rather than the phase id, because a thread holding a plan *and* a question
  // is filed under Ask and its plan is still perfectly decidable.
  const planReady = attentionKind === "plan" && !phaseSidebarIsExecutionActive(row.thread);
  // T3-CUSTOM(expbkt3): BEGIN — signals the stock sidebar carries and this one
  // dropped. Each reads a field already on the row.
  const isPinned = row.thread.pinnedAt != null;
  const runningTerminalIds = useThreadRunningTerminalIds({
    environmentId: row.thread.environmentId,
    threadId: row.thread.id,
  });
  // T3-CUSTOM(expbkt3): END
  // T3-CUSTOM(expbkt3): BEGIN — session tree derivations. Subtree state only
  // surfaces on the parent while the subtree is closed; once open, the child
  // rows speak for themselves.
  const hasChildren = (treeDescendantCount ?? 0) > 0;
  const hasCollapsedBusyDescendant =
    hasChildren && treeHasBusyDescendant === true && treeExpanded !== true;
  // Attention outranks work: a parent hoisted into Needs Input has to say which
  // of its descendants is stuck, or the group placement reads as a glitch.
  const collapsedDescendantAttention =
    hasChildren && treeExpanded !== true ? (treeDescendantAttention ?? null) : null;
  // Unlike the signals above, the two counters stay visible while the subtree is
  // open: a fan-out is often taller than the viewport, so "3 unread below me"
  // still says something the visible children cannot.
  const descendantUnreadCount = hasChildren ? (treeDescendantUnreadCount ?? 0) : 0;
  const descendantRunningCount = hasChildren ? (treeDescendantRunningCount ?? 0) : 0;
  // T3-CUSTOM(expbkt3): END
  // T3-CUSTOM(expbkt3): BEGIN — settle/snooze affordances.
  // While the preset popover is open the pointer sits over the popup, not
  // the row, so the hover cluster has to stay pinned.
  const [snoozeMenuOpenRaw, setSnoozeMenuOpen] = useState(false);
  const [linearTagDialogOpen, setLinearTagDialogOpen] = useState(false);
  const [mattermostDialogOpen, setMattermostDialogOpen] = useState(false);
  // Snooze is offered only where it can succeed: capability-gated, and never
  // on a thread that is blocked on the user (hiding a pending request would
  // defeat it).
  const canSnoozeRow =
    row.snoozeSupported && canSnooze(row.thread, { now: new Date().toISOString() });
  const snoozeMenuOpen = snoozeMenuOpenRaw && canSnoozeRow;
  useEffect(() => {
    if (!canSnoozeRow) setSnoozeMenuOpen(false);
  }, [canSnoozeRow]);
  const wokeAt = threadWokeAt(row.thread, { now: new Date().toISOString() });
  // A wake the user has not looked at yet: same "visiting clears it" rule
  // the unread indicator uses.
  const showWokePill =
    section === "active" &&
    wokeAt !== null &&
    (lastVisitedAt === undefined || Date.parse(wokeAt) > Date.parse(lastVisitedAt));
  const shouldEmphasizeTitle =
    row.isUnreadCompletion ||
    active ||
    selected ||
    attentionKind !== null ||
    showWokePill ||
    (row.thread.priority != null && row.thread.priority <= 2);
  // Snoozed rows read "when does this come BACK"; settled rows read "when
  // did this wrap up" — the same timestamp they sort by.
  const timeLabel =
    section === "snoozed" && row.thread.snoozedUntil != null
      ? snoozeWakeLabel(row.thread.snoozedUntil, { now: new Date().toISOString() })
      : compactPhaseSidebarTimeLabel(
          formatRelativeTimeLabel(
            (section === "settled" ? resolveSettledTimestamp(row.thread) : null) ??
              row.thread.updatedAt,
          ),
        );
  // T3-CUSTOM(expbkt3): END

  // T3-CUSTOM(expbkt3): links open in the integrated browser beside the open thread (this
  // row's when none is open); Cmd/Ctrl-click still goes to the system browser.
  const openLinearIssue = (event: {
    preventDefault(): void;
    stopPropagation(): void;
    metaKey: boolean;
    ctrlKey: boolean;
  }) => {
    event.preventDefault();
    event.stopPropagation();
    if (!linearIssue) return;
    openRowLink(linearIssue.url, event, `Failed to open ${linearIssue.identifier}`);
  };

  // T3-CUSTOM(expbkt3): same affordance as the Linear tag — the badge opens the
  // change request rather than routing to the thread.
  const openChangeRequestUrl = (
    url: string,
    label: string,
    event?: { readonly metaKey: boolean; readonly ctrlKey: boolean },
  ) => {
    openRowLink(url, event, `Failed to open ${label}`);
  };

  // T3-CUSTOM(expbkt3): one review opens it; several list themselves first, so
  // a thread carrying a stack is never a link to whichever layer sorted top.
  const openChangeRequest = (event: {
    preventDefault(): void;
    stopPropagation(): void;
    metaKey: boolean;
    ctrlKey: boolean;
  }) => {
    event.preventDefault();
    event.stopPropagation();
    if (!changeRequestBadge) return;
    openChangeRequestUrl(changeRequestBadge.url, changeRequestBadge.label, event);
  };

  const handleClick = (event: ReactMouseEvent<HTMLButtonElement>) => {
    const modifierClick = isMacPlatform(navigator.platform) ? event.metaKey : event.ctrlKey;
    if (modifierClick) {
      event.preventDefault();
      toggleThread(threadKey);
      return;
    }
    if (event.shiftKey) {
      event.preventDefault();
      rangeSelectTo(threadKey, orderedThreadKeys);
      return;
    }
    if (isTrailingDoubleClick(event.detail)) return;
    if (useThreadSelectionStore.getState().hasSelection()) clearSelection();
    setAnchor(threadKey);
    onNavigate(threadRef);
  };

  // Position, not the event: a right-click and a touch long-press open the same
  // menu, and only one of them has a mouse event to hand.
  const openRowContextMenu = async (position: { x: number; y: number }) => {
    const api = readLocalApi();
    if (!api) return;
    // T3-CUSTOM(expbkt3): BEGIN — lifecycle parking items, capability-gated
    // so an old server shows none of them rather than failing on click.
    const snoozePresets = resolveSnoozePresets(new Date(), timestampFormat);
    const settlementItems = row.settlementSupported
      ? [
          section === "settled"
            ? { id: "unsettle", label: "Un-settle thread" }
            : { id: "settle", label: "Settle thread" },
        ]
      : [];
    const snoozeItems = row.snoozeSupported
      ? [
          section === "snoozed"
            ? { id: "unsnooze", label: "Wake thread" }
            : {
                id: "snooze",
                label: "Snooze",
                disabled: !canSnoozeRow,
                children: snoozePresets.map((preset) => ({
                  id: `snooze:${preset.id}`,
                  label: `${preset.label} — ${preset.whenLabel}`,
                })),
              },
        ]
      : [];
    const priorityItems = row.prioritySupported
      ? [
          {
            id: "priority",
            label: "Priority",
            children: [
              ...PHASE_SIDEBAR_PRIORITY_CHOICES.map((choice) => ({
                id: `priority:${choice.value}`,
                label: row.thread.priority === choice.value ? `${choice.label} ✓` : choice.label,
              })),
              {
                id: "priority:clear",
                label: "Clear priority",
                disabled: row.thread.priority == null,
              },
            ],
          },
        ]
      : [];
    // T3-CUSTOM(expbkt3): pins are durable metadata, so the phase view must
    // provide the same reversible action as the stock sidebar.
    const pinItems = pinningSupported
      ? [
          {
            id: row.thread.pinnedAt == null ? "pin" : "unpin",
            label: row.thread.pinnedAt == null ? "Pin thread" : "Unpin thread",
          },
        ]
      : [];
    const draftItems = hasUnsentDraft ? [{ id: "discard-draft", label: "Discard draft" }] : [];
    const linearItems = row.linearIssueSupported
      ? [
          {
            id: "tag-linear",
            label: row.thread.linearIssueUrl ? "Change Linear tag…" : "Tag Linear…",
          },
          ...(row.thread.linearIssueUrl
            ? [{ id: "remove-linear", label: "Remove manual Linear tag" }]
            : []),
        ]
      : [];
    // T3-CUSTOM(expbkt3): the Mattermost conversation following this session.
    // "Open" comes first because the badge itself is not clickable - it lives
    // inside the row's button, where an anchor would be invalid and would
    // swallow row selection.
    const mattermostItems = row.mattermostLinkSupported
      ? [
          ...(mattermostLink ? [{ id: "open-mattermost", label: "Open in Mattermost" }] : []),
          {
            id: "link-mattermost",
            label: mattermostLink ? "Change Mattermost link\u2026" : "Link Mattermost\u2026",
          },
          ...(mattermostLink ? [{ id: "remove-mattermost", label: "Remove Mattermost link" }] : []),
        ]
      : [];
    // Session lineage. "Detach" is always offered when a parent exists —
    // nesting must never be a one-way door.
    const lineageItems = treeActions
      ? [
          { id: "move-under", label: "Move under session…" },
          ...(row.thread.parentThreadId != null
            ? [{ id: "detach-parent", label: "Detach from parent" }]
            : []),
          ...(hasChildren
            ? [
                {
                  id: treeExpanded ? "collapse-subtree" : "expand-subtree",
                  label: treeExpanded ? "Collapse all children" : "Expand all children",
                },
              ]
            : []),
        ]
      : [];
    // T3-CUSTOM(expbkt3): custom groups. Always offered, whichever mode is
    // showing — placing a session is cheap, and the group is waiting when the
    // user switches to Custom.
    // A nested row is placed with its parent, so offering to move it alone
    // would show a tick for a group it never appears in.
    const groupItems =
      groupActions && treeParentKey == null
        ? [
            {
              id: "move-to-group",
              label: "Move to group",
              children: [
                ...groupActions.groups.map((group) => ({
                  id: `group:${group.id}`,
                  label: customGroupId === group.id ? `${group.label} ✓` : group.label,
                })),
                ...(customGroupId != null
                  ? [{ id: "group:none", label: "Remove from group" }]
                  : []),
                { id: "group:new", label: "New group…" },
              ],
            },
          ]
        : [];
    // Side-by-side sessions. First in the menu because it is the one item that
    // starts work rather than tidying up after it, and because the whole point
    // is opening a second session without leaving the one you are reading.
    const newThreadItems = [
      {
        id: "new-thread",
        label: "Create new thread",
        children: [
          { id: "new-thread:same-worktree", label: "Using same worktree" },
          ...(canCreateWorktreeFromParent(row.thread)
            ? [{ id: "new-thread:new-worktree", label: "Using new worktree" }]
            : []),
        ],
      },
    ];
    // T3-CUSTOM(expbkt3): BEGIN — ask the server to re-derive this title.
    const isRegeneratingTitle = row.thread.titleRegeneration != null;
    const titleRegenerationItems = row.titleRegenerationSupported
      ? [
          {
            id: "regenerate-title",
            label: isRegeneratingTitle ? "Regenerating…" : "Regenerate title",
            disabled: isRegeneratingTitle,
          },
        ]
      : [];
    // T3-CUSTOM(expbkt3): END
    const action = await api.contextMenu.show(
      [
        // T3-CUSTOM(expbkt3): side-by-side sessions.
        ...newThreadItems,
        { id: "rename", label: "Rename" },
        // T3-CUSTOM(expbkt3): a manual rename is durable, so re-deriving the
        // title from the conversation has to be something you can ask for.
        ...titleRegenerationItems,
        { id: "mark-unread", label: "Mark unread" },
        ...draftItems,
        ...pinItems,
        ...priorityItems,
        ...linearItems,
        // T3-CUSTOM(expbkt3): Mattermost conversation link.
        ...mattermostItems,
        // T3-CUSTOM(expbkt3): session lineage.
        ...lineageItems,
        // T3-CUSTOM(expbkt3): custom groups.
        ...groupItems,
        ...settlementItems,
        ...snoozeItems,
        {
          id: "force-stop-agent",
          label: "Force stop agent",
          disabled: !phaseSidebarCanForceStopAgent(row.thread.runtime),
          destructive: true,
        },
        { id: "copy-path", label: "Copy Path", disabled: workspacePath === null },
        {
          id: "copy-session-id",
          label: "Copy session ID",
          disabled: !row.thread.activeProviderThreadId,
        },
        { id: "copy-id", label: "Copy thread ID" },
        { id: "archive", label: "Archive" },
        { id: "delete", label: "Delete", destructive: true },
      ],
      position,
    );
    if (action === "rename") onStartRename(row);
    if (action === "mark-unread") {
      markThreadUnread(threadKey, row.thread.latestRun?.completedAt);
      void markUnreadOnServer({
        environmentId: row.thread.environmentId,
        input: { threadId: row.thread.id },
      });
    }
    if (action === "discard-draft") {
      releaseComposerDraftUploads(threadRef);
      clearComposerContent(threadRef);
    }
    if (action === "pin") onPin(row);
    if (action === "unpin") onUnpin(row);
    // T3-CUSTOM(expbkt3): BEGIN
    if (action === "new-thread:same-worktree") onCreateThread(row, "same-worktree");
    if (action === "new-thread:new-worktree") onCreateThread(row, "new-worktree");
    if (action === "settle") onSettle(row);
    if (action === "unsettle") onUnsettle(row);
    if (action === "unsnooze") onUnsnooze(row);
    if (action?.startsWith("snooze:")) {
      const preset = snoozePresets.find((candidate) => `snooze:${candidate.id}` === action);
      if (preset) onSnooze(row, preset);
    }
    if (action === "priority:clear") onSetPriority(row, null);
    else if (action?.startsWith("priority:")) {
      const choice = PHASE_SIDEBAR_PRIORITY_CHOICES.find(
        (candidate) => `priority:${candidate.value}` === action,
      );
      if (choice) onSetPriority(row, choice.value);
    }
    if (action === "tag-linear") setLinearTagDialogOpen(true);
    if (action === "remove-linear") onSetLinearIssueUrl(row, null);
    // T3-CUSTOM(expbkt3): Mattermost conversation link.
    if (action === "open-mattermost" && mattermostLink) {
      openRowLink(mattermostLink.url, undefined);
    }
    if (action === "link-mattermost") setMattermostDialogOpen(true);
    if (action === "remove-mattermost") onSetMattermostThreadUrl(row, null);
    if (action === "regenerate-title") onRegenerateTitle(row);
    // T3-CUSTOM(expbkt3): END
    if (action === "force-stop-agent") onForceStop(row);
    if (action === "copy-path" && workspacePath) {
      await navigator.clipboard.writeText(workspacePath);
    }
    if (action === "copy-session-id" && row.thread.activeProviderThreadId) {
      await navigator.clipboard.writeText(row.thread.activeProviderThreadId);
    }
    if (action === "copy-id") await navigator.clipboard.writeText(row.thread.id);
    if (action === "archive") onArchive(row);
    if (action === "delete") onDelete(row);
    // T3-CUSTOM(expbkt3): session lineage.
    if (action === "move-under") treeActions?.onMoveUnder(row);
    if (action === "detach-parent") treeActions?.onDetach(row);
    if (action === "expand-subtree") treeActions?.onSetSubtreeExpanded(threadKey, true);
    if (action === "collapse-subtree") treeActions?.onSetSubtreeExpanded(threadKey, false);
    // T3-CUSTOM(expbkt3): custom groups.
    if (action === "group:new") groupActions?.onCreateGroupWith(row);
    else if (action === "group:none") groupActions?.onAssign(row, null);
    else if (action?.startsWith("group:")) {
      groupActions?.onAssign(row, action.slice("group:".length));
    }
  };

  // Phones have no right button: holding the row is how the menu is reached.
  const longPressContextMenu = useLongPressContextMenu((position) => {
    void openRowContextMenu(position);
  });

  return (
    <li
      data-thread-item
      // T3-CUSTOM(expbkt3): nested rows indent, capped so a deep chain does not
      // eat the title. Depth 0 emits no style, keeping root rows unchanged.
      {...(treeDepth !== undefined && treeDepth > 0
        ? {
            "data-thread-depth": treeDepth,
            style: { paddingLeft: phaseSidebarTreeIndent(treeDepth) },
          }
        : {})}
    >
      <button
        ref={rowRef}
        type="button"
        className={phaseSidebarRowClassName(
          active,
          selected,
          needsUserInput,
          planReady,
          hasAsyncQuestion,
        )}
        aria-current={active ? "page" : undefined}
        aria-expanded={hasChildren ? treeExpanded : undefined}
        data-attention={
          needsUserInput
            ? "user-input"
            : hasAsyncQuestion
              ? "ask"
              : planReady
                ? "plan-ready"
                : undefined
        }
        data-testid={`phase-thread-row-${row.thread.id}`}
        onClick={handleClick}
        onDoubleClick={() => onStartRename(row)}
        onContextMenu={(event) => {
          event.preventDefault();
          void openRowContextMenu({ x: event.clientX, y: event.clientY });
        }}
        {...longPressContextMenu}
      >
        {workBadge?.monitoring !== true &&
        (sessionActive ||
          shouldShowRunningSessionGlint(row.phaseId, section) ||
          // T3-CUSTOM(expbkt3): a collapsed parent carries its subtree's
          // running signal. Only while collapsed — once open the child that is
          // actually working carries it, and two sweeps for one unit of work
          // would both mislead and repaint twice.
          (hasCollapsedBusyDescendant && workBadge === null)) ? (
          <RunningSessionGlint />
        ) : null}
        {active ? (
          <span
            aria-hidden
            data-testid={`phase-thread-active-indicator-${row.thread.id}`}
            className="pointer-events-none absolute inset-y-1 right-0 w-0.5 rounded-full bg-primary shadow-[0_0_6px_var(--color-primary)]"
          />
        ) : null}
        {/* T3-CUSTOM(expbkt3): BEGIN — session-tree disclosure.
            This sits in the SAME lane the unread dot reserves rather than
            adding another one: the row is a flex box with gap-2, so an extra
            child would cost its own width plus a gap and shove the title ~48px
            right of every neighbouring row. The count is bare tabular text for
            the same reason — pill chrome costs another ~10px of horizontal
            padding for one glyph. */}
        {hasChildren ? (
          <span
            role="button"
            tabIndex={-1}
            aria-label={treeExpanded ? "Collapse child sessions" : "Expand child sessions"}
            data-testid={`phase-thread-disclosure-${row.thread.id}`}
            className="-my-1 -ml-0.5 flex shrink-0 cursor-pointer items-center gap-px self-center rounded py-1 text-muted-foreground/70 transition-colors hover:text-foreground"
            onClick={(event) => {
              // The row itself navigates; opening a subtree must not.
              event.stopPropagation();
              event.preventDefault();
              treeActions?.onToggle(threadKey);
            }}
          >
            <ChevronRightIcon
              aria-hidden
              className={cn(
                "size-3.5 shrink-0 transition-transform duration-150",
                treeExpanded && "rotate-90",
              )}
            />
            <span
              aria-label={`${treeDescendantCount} child sessions`}
              className={cn(
                "text-[10px] font-semibold tabular-nums leading-none",
                collapsedDescendantAttention !== null
                  ? "text-red-600 dark:text-red-300"
                  : hasCollapsedBusyDescendant
                    ? "text-sky-600 dark:text-sky-300"
                    : "text-current",
              )}
            >
              {treeDescendantCount}
            </span>
          </span>
        ) : null}
        {/* T3-CUSTOM(expbkt3): END */}
        {/* T3-CUSTOM(expbkt3): the empty spacer only earns its width when there
            is no disclosure in the lane. An unread dot still renders on a
            parent — that is real state, not reserved space. */}
        {hasChildren && !row.isUnreadCompletion ? null : (
          <PhaseSidebarUnreadIndicator isUnread={row.isUnreadCompletion} threadId={row.thread.id} />
        )}
        {/* T3-CUSTOM(expbkt3): Vertically centered adaptive content lane. */}
        <span className={PHASE_SIDEBAR_CONTENT_CLASS_NAME}>
          {renaming ? (
            <input
              autoFocus
              value={renameTitle}
              className="h-5 w-full rounded border border-ring bg-transparent px-1 text-xs text-foreground outline-none"
              onChange={(event) => onRenameTitleChange(event.target.value)}
              onClick={(event) => event.stopPropagation()}
              onDoubleClick={(event) => event.stopPropagation()}
              onBlur={() => onCommitRename(row)}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === "Enter") onCommitRename(row);
                if (event.key === "Escape") onCancelRename();
              }}
            />
          ) : (
            <span
              className={cn(
                "block truncate text-xs transition-colors",
                row.isUnreadCompletion
                  ? "font-semibold text-foreground"
                  : shouldEmphasizeTitle
                    ? "font-medium text-foreground"
                    : "font-normal text-muted-foreground/75 group-hover/phase-row:text-foreground",
              )}
            >
              {hasUnsentDraft ? (
                <SquarePenIcon
                  aria-label="Unsent draft"
                  className="mr-1 inline size-3 shrink-0 text-amber-600 dark:text-amber-300"
                />
              ) : null}
              {row.thread.title}
            </span>
          )}
          {/* T3-CUSTOM(expbkt3): Checkout and Linear details remain in the content lane. */}
          <span className={PHASE_SIDEBAR_METADATA_CLASS_NAME}>
            {/* T3-CUSTOM(expbkt3): This row has a parent that is not rendering
                here (settled, snoozed, filtered out). Naming it keeps the
                lineage visible instead of silently flattening the row. */}
            {treeParentKey && treeParentTitle ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <span
                      role="link"
                      tabIndex={0}
                      data-testid={`phase-thread-parent-crumb-${row.thread.id}`}
                      aria-label={`Go to parent session ${treeParentTitle}`}
                      className="inline-flex max-w-full shrink-0 cursor-pointer items-center gap-0.5 whitespace-nowrap text-muted-foreground/70 hover:text-foreground hover:underline"
                      onClick={(event) => {
                        event.stopPropagation();
                        treeActions?.onJumpToParent(treeParentKey);
                      }}
                      onDoubleClick={(event) => event.stopPropagation()}
                    />
                  }
                >
                  <CornerDownRightIcon aria-hidden className="size-2.5 shrink-0" />
                  <span className="min-w-0 truncate">{treeParentTitle}</span>
                </TooltipTrigger>
                <TooltipPopup side="top">Started by {treeParentTitle}</TooltipPopup>
              </Tooltip>
            ) : null}
            {/* T3-CUSTOM(expbkt3): BEGIN — which machine this session runs on. Sits
                with the repository label because that is the pair that becomes
                ambiguous once two environments contribute the same repo. */}
            {environmentAppearance ? (
              <Tooltip>
                <TooltipTrigger render={<span className="inline-flex shrink-0 items-center" />}>
                  <EnvironmentBadgeView appearance={environmentAppearance} variant="glyph" />
                </TooltipTrigger>
                <TooltipPopup side="top">{environmentAppearance.name}</TooltipPopup>
              </Tooltip>
            ) : null}
            {/* T3-CUSTOM(expbkt3): END */}
            <Tooltip>
              {/* T3-CUSTOM(expbkt3): BEGIN — wrap complete labels as units. */}
              <TooltipTrigger
                render={<span className="inline-flex max-w-full shrink-0 items-center gap-1" />}
              >
                {project ? (
                  <ProjectFavicon
                    // T3-CUSTOM(expbkt3): upstream takes the project record whole so the
                    // saved title, favicon and icon override always travel together.
                    project={project}
                    className="size-2.5"
                  />
                ) : null}
                <span className="min-w-0 truncate">{row.repositoryLabel}</span>
              </TooltipTrigger>
              {/* T3-CUSTOM(expbkt3): END */}
              <TooltipPopup side="top">
                {environmentAppearance
                  ? `${row.repositoryLabel} · ${environmentAppearance.name}`
                  : row.repositoryLabel}
              </TooltipPopup>
            </Tooltip>
            <Tooltip>
              {/* T3-CUSTOM(expbkt3): BEGIN — wrap complete labels as units. */}
              <TooltipTrigger
                render={<span className="inline-flex max-w-full shrink-0 items-center gap-1" />}
              >
                {checkoutMetadata.kind === "worktree" ? (
                  <FolderGit2Icon
                    aria-hidden
                    className={cn(
                      "size-2.5 shrink-0",
                      phaseSidebarCheckoutToneClassName(checkoutMetadata.toneIndex),
                    )}
                  />
                ) : (
                  <LaptopIcon aria-hidden className="size-2.5 shrink-0" />
                )}
                <span
                  className={cn(
                    "min-w-0 truncate",
                    phaseSidebarCheckoutToneClassName(checkoutMetadata.toneIndex),
                  )}
                >
                  {checkoutMetadata.label}
                </span>
              </TooltipTrigger>
              {/* T3-CUSTOM(expbkt3): END */}
              <TooltipPopup side="top">{checkoutMetadata.tooltip}</TooltipPopup>
            </Tooltip>
            {/* T3-CUSTOM(expbkt3): BEGIN — the checkout moved off this thread's
                branch. The label beside it shows the branch that IS checked out,
                so without this the row reads as healthy while pointing at
                someone else's work. */}
            {checkoutMetadata.branchMismatch !== null ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <span
                      data-testid={`branch-mismatch-${row.thread.id}`}
                      aria-label={`This thread is on ${checkoutMetadata.branchMismatch}, which is not checked out`}
                      className="inline-flex shrink-0 items-center text-amber-600 dark:text-amber-300"
                    >
                      <TriangleAlertIcon aria-hidden className="size-2.5" />
                    </span>
                  }
                />
                <TooltipPopup side="top">
                  {`This thread is on ${checkoutMetadata.branchMismatch}. You are currently checked out on another branch.`}
                </TooltipPopup>
              </Tooltip>
            ) : null}
            {/* T3-CUSTOM(expbkt3): END */}
            {linearIssue ? (
              <Tooltip>
                {/* T3-CUSTOM(expbkt3): BEGIN — wrap complete labels as units. */}
                <TooltipTrigger
                  render={
                    <span
                      role="link"
                      tabIndex={0}
                      data-testid={`linear-issue-${row.thread.id}`}
                      aria-label={`Open ${linearIssue.identifier} in Linear`}
                      className="inline-flex max-w-full shrink-0 cursor-pointer items-center gap-1 whitespace-nowrap font-medium text-muted-foreground hover:text-foreground hover:underline focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      onClick={openLinearIssue}
                      onDoubleClick={(event) => event.stopPropagation()}
                      onKeyDown={(event) => {
                        if (event.key !== "Enter" && event.key !== " ") return;
                        openLinearIssue(event);
                      }}
                    />
                  }
                >
                  <LinearIcon aria-hidden className="size-2.5 shrink-0" />
                  <span className="max-w-32 truncate">
                    {linearIssue.identifier} (
                    {linearIssueStatus?.status ??
                      (linearIssueStatus?.error ? "unavailable" : "syncing…")}
                    )
                  </span>
                </TooltipTrigger>
                {/* T3-CUSTOM(expbkt3): END */}
                <TooltipPopup side="top">
                  {linearIssue.identifier} (
                  {linearIssueStatus?.status ?? linearIssueStatus?.error ?? "syncing…"})
                </TooltipPopup>
              </Tooltip>
            ) : null}
            {/* T3-CUSTOM(expbkt3): PR badge — number only, state by colour. A
                stack wears the layers glyph so it is distinguishable from a
                single review at a glance; more than one review opens a list
                rather than guessing which one you meant. */}
            {changeRequestBadge ? (
              changeRequestBadge.kind === "single" ? (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <span
                        role="link"
                        tabIndex={0}
                        data-testid={`phase-thread-change-request-${row.thread.id}`}
                        data-change-request-state={changeRequestBadge.state}
                        aria-label={`Open ${changeRequestBadge.label} (${changeRequestBadge.statusText})`}
                        className={cn(
                          "inline-flex max-w-full shrink-0 cursor-pointer items-center gap-1 whitespace-nowrap font-medium hover:underline focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                          changeRequestBadge.colorClassName,
                        )}
                        onClick={openChangeRequest}
                        onDoubleClick={(event) => event.stopPropagation()}
                        onKeyDown={(event) => {
                          if (event.key !== "Enter" && event.key !== " ") return;
                          openChangeRequest(event);
                        }}
                      />
                    }
                  >
                    <PullRequestGlyph.pullRequest aria-hidden className="size-2.5 shrink-0" />
                    <span className="tabular-nums">{changeRequestBadge.label}</span>
                  </TooltipTrigger>
                  <TooltipPopup side="top">{changeRequestBadge.tooltip}</TooltipPopup>
                </Tooltip>
              ) : (
                <Popover>
                  <PopoverTrigger
                    render={
                      <span
                        role="button"
                        tabIndex={0}
                        data-testid={`phase-thread-change-request-${row.thread.id}`}
                        data-change-request-state={changeRequestBadge.state}
                        data-change-request-kind={changeRequestBadge.kind}
                        aria-label={`${changeRequestBadge.entries.length} ${
                          changeRequestBadge.kind === "stack"
                            ? "stacked pull requests"
                            : "linked pull requests"
                        }`}
                        className={cn(
                          "inline-flex max-w-full shrink-0 cursor-pointer items-center gap-1 whitespace-nowrap font-medium hover:underline focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                          changeRequestBadge.colorClassName,
                        )}
                        onClick={(event: ReactMouseEvent<HTMLSpanElement>) => {
                          event.stopPropagation();
                        }}
                        onDoubleClick={(event: ReactMouseEvent<HTMLSpanElement>) => {
                          event.stopPropagation();
                        }}
                      />
                    }
                  >
                    {changeRequestBadge.kind === "stack" ? (
                      <LayersIcon aria-hidden className="size-2.5 shrink-0" />
                    ) : (
                      <PullRequestGlyph.pullRequest aria-hidden className="size-2.5 shrink-0" />
                    )}
                    <span className="tabular-nums">{changeRequestBadge.label}</span>
                  </PopoverTrigger>
                  <PopoverPopup align="start" side="bottom" className="w-72 p-1">
                    <p className="px-2 py-1 text-xs text-muted-foreground">
                      {changeRequestBadge.kind === "stack"
                        ? `Stack of ${changeRequestBadge.entries.length}, bottom first`
                        : `${changeRequestBadge.entries.length} linked reviews`}
                    </p>
                    {changeRequestBadge.entries.map((entry) => (
                      <button
                        key={entry.url}
                        type="button"
                        data-change-request-state={entry.state}
                        className="flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-sm px-2 py-1 text-left text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                        onClick={(event) => {
                          event.stopPropagation();
                          openChangeRequestUrl(entry.url, entry.label, event);
                        }}
                      >
                        <PullRequestGlyph.pullRequest
                          aria-hidden
                          className={cn("size-3 shrink-0", entry.colorClassName)}
                        />
                        <span className={cn("tabular-nums", entry.colorClassName)}>
                          {entry.label}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-muted-foreground">
                          {entry.title ?? entry.statusText}
                        </span>
                      </button>
                    ))}
                  </PopoverPopup>
                </Popover>
              )
            ) : null}
          </span>
        </span>
        {/* T3-CUSTOM(expbkt3): status/time own a fixed top-right lane. */}
        <span className="absolute top-2 right-2 flex max-w-[55%] shrink-0 items-center gap-1">
          {/* T3-CUSTOM(expbkt3): BEGIN — exact subtree counters. Bare icon plus a
              tabular number, no pill chrome: they share the lane with the
              attention badges and the timestamp, and this row is already the
              densest surface in the app. The glyphs are deliberately the ones
              the child rows use for the same state — the emerald dot is the
              unread indicator, sky is the working colour — so the counter reads
              as "N of those, below me" without a legend. */}
          {descendantRunningCount > 0 ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <span
                    role="status"
                    aria-label={`${descendantRunningCount} child sessions working`}
                    data-testid={`phase-thread-subtree-running-count-${row.thread.id}`}
                    className="inline-flex shrink-0 items-center gap-0.5 text-[9px] font-semibold leading-none tabular-nums text-sky-600 dark:text-sky-300"
                  />
                }
              >
                <ActivityIcon aria-hidden className="size-2.5 shrink-0" />
                {descendantRunningCount}
              </TooltipTrigger>
              <TooltipPopup side="top">
                {descendantRunningCount} child session
                {descendantRunningCount === 1 ? "" : "s"} working
              </TooltipPopup>
            </Tooltip>
          ) : null}
          {descendantUnreadCount > 0 ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <span
                    role="status"
                    aria-label={`${descendantUnreadCount} unread child sessions`}
                    data-testid={`phase-thread-subtree-unread-count-${row.thread.id}`}
                    className="inline-flex shrink-0 items-center gap-0.5 text-[9px] font-semibold leading-none tabular-nums text-emerald-600 dark:text-emerald-300/90"
                  />
                }
              >
                <span
                  aria-hidden
                  className="size-[7px] shrink-0 rounded-full bg-emerald-500 dark:bg-emerald-300/90"
                />
                {descendantUnreadCount}
              </TooltipTrigger>
              <TooltipPopup side="top">
                {descendantUnreadCount} unread child session
                {descendantUnreadCount === 1 ? "" : "s"}
              </TooltipPopup>
            </Tooltip>
          ) : null}
          {/* T3-CUSTOM(expbkt3): END */}
          {/* T3-CUSTOM(expbkt3): BEGIN — a pinned row says so. Pin and unpin were
              already in the context menu but changed nothing observable. */}
          {isPinned ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <span
                    role="status"
                    aria-label="Pinned"
                    data-testid={`phase-thread-pinned-${row.thread.id}`}
                    className="inline-flex shrink-0 items-center text-muted-foreground"
                  />
                }
              >
                <PinIcon aria-hidden className="size-2.5" />
              </TooltipTrigger>
              <TooltipPopup side="top">Pinned to the top of its group</TooltipPopup>
            </Tooltip>
          ) : null}
          {/* A terminal subprocess is still running in this thread. */}
          {runningTerminalIds.length > 0 ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <span
                    role="status"
                    aria-label={`${runningTerminalIds.length} terminal process${
                      runningTerminalIds.length === 1 ? "" : "es"
                    } running`}
                    data-testid={`phase-thread-terminals-${row.thread.id}`}
                    className="inline-flex shrink-0 items-center text-sky-600 dark:text-sky-300/90"
                  />
                }
              >
                <TerminalIcon aria-hidden className="size-2.5" />
              </TooltipTrigger>
              <TooltipPopup side="top">
                {runningTerminalIds.length} terminal process
                {runningTerminalIds.length === 1 ? "" : "es"} running
              </TooltipPopup>
            </Tooltip>
          ) : null}
          {/* T3-CUSTOM(expbkt3): END */}
          {/* T3-CUSTOM(expbkt3): a plan does not silence the work badge — a
              running row with a plan attached has to keep saying it is running. */}
          {workBadge &&
          (attentionKind === null || attentionKind === "plan" || attentionKind === "ask") ? (
            <span
              role="status"
              className={cn(
                "rounded-sm px-1 py-0.5 text-[8px] font-black tracking-wide text-sky-700 dark:text-sky-300",
                workBadge.monitoring ? "bg-sky-500/10" : "bg-sky-500/15",
              )}
            >
              {workBadge.label.toUpperCase()}
            </span>
          ) : null}
          {/* T3-CUSTOM(expbkt3): A descendant is waiting on a human. Outlined
              with a ↳ glyph, same grammar as the derived work badge: solid is
              this row, outlined is somewhere beneath it. */}
          {collapsedDescendantAttention !== null &&
          (attentionKind === null || attentionKind === "plan" || attentionKind === "ask") ? (
            <span
              role="status"
              aria-label={`A child session needs ${collapsedDescendantAttention}`}
              data-testid={`phase-thread-subtree-attention-${row.thread.id}`}
              className={cn(
                "rounded-sm border px-1 py-0.5 text-[8px] font-black tracking-wide",
                collapsedDescendantAttention === "input"
                  ? "border-red-500/50 text-red-600 dark:border-red-400/50 dark:text-red-300"
                  : collapsedDescendantAttention === "approval" ||
                      collapsedDescendantAttention === "ask"
                    ? "border-amber-500/50 text-amber-700 dark:border-amber-400/50 dark:text-amber-300"
                    : // T3-CUSTOM(expbkt3): a plan below reads violet, like its own row would.
                      collapsedDescendantAttention === "plan"
                      ? "border-violet-500/50 text-violet-700 dark:border-violet-400/50 dark:text-violet-300"
                      : "border-red-500/40 text-red-700 dark:border-red-400/40 dark:text-red-300",
              )}
            >
              ↳ {collapsedDescendantAttention.toUpperCase()}
            </span>
          ) : null}
          {/* T3-CUSTOM(expbkt3): the "↳ WORKING" badge that used to live here is
              gone — the running counter above says the same thing with the exact
              number, in both open and closed states, for less width. The
              collapsed sweep still runs, since that is about work the closed
              subtree hides rather than about how much of it there is. */}
          {/* T3-CUSTOM(expbkt3): a message-mode question, rendered ahead of — and
              independently of — the attention chain below. It used to be the
              chain's last branch, which meant a thread holding a plan *and* a
              question showed PLAN only, and the question that someone was
              actively waiting on was the one signal the row dropped. */}
          {hasAsyncQuestion ? (
            <span
              aria-label="Question waiting"
              data-testid={`phase-thread-async-question-${row.thread.id}`}
              className="rounded-sm bg-amber-500/15 px-1 py-0.5 text-[8px] font-black tracking-wide text-amber-700 shadow-sm dark:text-amber-300"
            >
              ASK
            </span>
          ) : null}
          {attentionKind === "input" ? (
            <span
              aria-label="Awaiting input"
              className="rounded-sm bg-red-500 px-1 py-0.5 text-[8px] font-black tracking-wide text-white shadow-sm"
            >
              INPUT
            </span>
          ) : attentionKind === "approval" ? (
            <span
              aria-label="Pending approval"
              className="rounded-sm bg-amber-500/15 px-1 py-0.5 text-[8px] font-black tracking-wide text-amber-700 shadow-sm dark:text-amber-300"
            >
              APPROVAL
            </span>
          ) : attentionKind === "error" ? (
            <span
              aria-label="Session error"
              className="rounded-sm bg-red-500/15 px-1 py-0.5 text-[8px] font-black tracking-wide text-red-700 shadow-sm dark:text-red-300"
            >
              ERROR
            </span>
          ) : /* T3-CUSTOM(expbkt3): BEGIN — a plan waiting for a decision. Solid
                 once the turn has settled, outlined while the agent is still
                 working, so "decide now" and "there will be one" stay apart. */
          attentionKind === "plan" ? (
            <span
              aria-label={
                planReady ? "Plan ready for review" : "Plan attached, agent still working"
              }
              className={
                planReady
                  ? "rounded-sm bg-violet-500 px-1 py-0.5 text-[8px] font-black tracking-wide text-white shadow-sm"
                  : "rounded-sm border border-violet-500/50 px-1 py-0.5 text-[8px] font-black tracking-wide text-violet-700 dark:border-violet-400/50 dark:text-violet-300"
              }
            >
              PLAN
            </span>
          ) : /* T3-CUSTOM(expbkt3): END */ null}
          {/* T3-CUSTOM(expbkt3): A woken thread returns to its original sort
              position, so the wake signal has to carry the weight itself. */}
          {showWokePill ? (
            <span
              aria-label="Woke from snooze"
              data-testid={`phase-thread-woke-${row.thread.id}`}
              className="inline-flex items-center gap-0.5 rounded-sm bg-blue-500/15 px-1 py-0.5 text-[8px] font-semibold tracking-wide text-blue-600 dark:text-blue-400"
            >
              <AlarmClockIcon aria-hidden className="size-2.5" />
              WOKE
            </span>
          ) : null}
          {jumpLabel ? (
            <Kbd className="h-4 min-w-0 rounded-sm px-1 text-[9px]">{jumpLabel}</Kbd>
          ) : null}
          <span className="text-[9px] tabular-nums text-muted-foreground/50">{timeLabel}</span>
        </span>
        {/* T3-CUSTOM(expbkt3): priority and provider stay anchored together at bottom-right. */}
        <span className="absolute right-2 bottom-2 flex h-3.5 items-center gap-1">
          {customGroupLabel ? (
            <span
              aria-label={`Group ${customGroupLabel}`}
              data-testid={`phase-thread-group-${row.thread.id}`}
              className="max-w-24 truncate rounded-sm border border-border/60 px-1 py-0.5 text-4xs font-medium text-muted-foreground"
            >
              {customGroupLabel}
            </span>
          ) : null}
          {row.thread.priority != null ? (
            <span
              aria-label={`Priority ${formatThreadPriority(row.thread.priority)}`}
              data-testid={`phase-thread-priority-${row.thread.id}`}
              className={cn(
                "rounded-sm px-1 py-0.5 text-[8px] font-black tracking-wide",
                phaseSidebarPriorityBadgeClassName(row.thread.priority),
              )}
            >
              {formatThreadPriority(row.thread.priority)}
            </span>
          ) : null}
          {/* T3-CUSTOM(expbkt3): only on threads someone else started - my own
              face on every row of my own sidebar would say nothing. */}
          {ownerAvatarUserId !== null ? (
            <PhaseSidebarOwnerAvatar ownerUserId={ownerAvatarUserId} threadId={row.thread.id} />
          ) : null}
          {/* T3-CUSTOM(expbkt3): a human is following this session from chat. */}
          {mattermostLink ? (
            <MattermostThreadBadge label={mattermostLink.label} threadId={row.thread.id} />
          ) : null}
          <Tooltip>
            <TooltipTrigger
              render={
                <span
                  className="inline-flex size-3.5 items-center justify-center"
                  aria-label={row.providerName}
                />
              }
            >
              <ProviderInstanceIcon
                driverKind={ProviderDriverKind.make(row.providerKind)}
                displayName={row.providerName}
                className="size-3.5"
                iconClassName="size-3.5 text-[8px]"
              />
            </TooltipTrigger>
            <TooltipPopup side="top">{row.providerName}</TooltipPopup>
          </Tooltip>
        </span>
        {/* T3-CUSTOM(expbkt3): BEGIN — hover actions overlay the row instead of reflowing metadata. */}
        <span
          className={phaseSidebarRowActionsClassName(
            snoozeMenuOpen || linearTagDialogOpen || mattermostDialogOpen,
          )}
        >
          {section === "snoozed" ? (
            row.snoozeSupported ? (
              <PhaseRowAction
                label={`Wake ${row.thread.title}`}
                tooltip="Wake now"
                testId={`phase-thread-unsnooze-${row.thread.id}`}
                onClick={() => onUnsnooze(row)}
              >
                <AlarmClockIcon className="size-3.5" />
              </PhaseRowAction>
            ) : null
          ) : section === "settled" ? (
            row.settlementSupported ? (
              <PhaseRowAction
                label={`Un-settle ${row.thread.title}`}
                tooltip="Un-settle"
                testId={`phase-thread-unsettle-${row.thread.id}`}
                onClick={() => onUnsettle(row)}
              >
                <RotateCcwIcon className="size-3.5" />
              </PhaseRowAction>
            ) : null
          ) : (
            <>
              {canSnoozeRow ? (
                <PhaseSnoozePopoverButton
                  open={snoozeMenuOpen}
                  label={`Snooze ${row.thread.title}`}
                  testId={`phase-thread-snooze-${row.thread.id}`}
                  onOpenChange={setSnoozeMenuOpen}
                  onSnooze={(preset) => onSnooze(row, preset)}
                  timestampFormat={timestampFormat}
                />
              ) : null}
              {row.settlementSupported ? (
                <PhaseRowAction
                  label={`Settle ${row.thread.title}`}
                  tooltip="Settle"
                  testId={`phase-thread-settle-${row.thread.id}`}
                  onClick={() => onSettle(row)}
                >
                  <CheckIcon className="size-3.5" />
                </PhaseRowAction>
              ) : null}
            </>
          )}
          <PhaseRowAction
            label={`Archive ${row.thread.title}`}
            tooltip="Archive"
            onClick={() => onArchive(row)}
          >
            <ArchiveIcon className="size-3.5" />
          </PhaseRowAction>
        </span>
        {/* T3-CUSTOM(expbkt3): END */}
      </button>
      <LinearIssueTagDialog
        open={linearTagDialogOpen}
        initialUrl={row.thread.linearIssueUrl ?? linearIssue?.url ?? ""}
        threadTitle={row.thread.title}
        onOpenChange={setLinearTagDialogOpen}
        onSave={(url) => onSetLinearIssueUrl(row, url)}
      />
      {/* T3-CUSTOM(expbkt3): Mattermost conversation link editor. */}
      <MattermostLinkDialog
        open={mattermostDialogOpen}
        initialUrl={row.thread.mattermostThreadUrl ?? ""}
        threadTitle={row.thread.title}
        onOpenChange={setMattermostDialogOpen}
        onSave={(url) => onSetMattermostThreadUrl(row, url)}
      />
    </li>
  );
});

export function PhaseGroupedSidebar() {
  const projects = useProjects();
  const threads = useThreadShells();
  const serverConfigs = useServerConfigs();
  const { networkStatus, environments } = useEnvironments();
  const allEnvironmentShellsLive = useAtomValue(allEnvironmentShellsLiveAtom);
  const router = useRouter();
  const routeParams = useParams({ strict: false });
  const { isMobile, setOpenMobile } = useSidebar();
  const handleNewThread = useNewThreadHandler();
  const openAddProject = useCallback(() => openCommandPalette({ open: "add-project" }), []);
  const {
    archiveThread,
    confirmAndDeleteThread,
    settleThread,
    unsettleThread,
    snoozeThread,
    unsnoozeThread,
    pinThread,
    confirmAndUnpinThread,
  } = useThreadActions();
  const updateThreadMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const forceStopThreadSession = useAtomCommand(threadEnvironment.stopSession, "force stop agent");
  // T3-CUSTOM(expbkt3): side-by-side sessions started from a row's context menu.
  const createThread = useAtomCommand(threadEnvironment.create, { reportFailure: false });
  const createWorktree = useAtomCommand(vcsEnvironment.createWorktree, { reportFailure: false });
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const sortOrder = useClientSettings((settings) => settings.sidebarThreadSortOrder);
  const confirmArchive = useClientSettings((settings) => settings.confirmThreadArchive);
  // Auto-settle thresholds are server preferences (the server settles threads
  // with no client attached), so read the primary server's values.
  const serverSettings = useAtomValue(primaryServerSettingsAtom);
  // A row's new thread starts with the saved defaults of the row's own
  // environment and project, not the primary environment's.
  const environmentServerConfigs = useAtomValue(environmentServerConfigsAtom);
  const planModeAvailable = useClientSettings((settings) => settings.planModeAvailable);
  const autoSettleAfterDays = serverSettings.sidebarAutoSettleAfterDays;
  const autoSettleOnMerge = serverSettings.sidebarAutoSettleOnMerge;
  const currentUserId = useCurrentUserId();
  // T3-CUSTOM(expbkt3): BEGIN — settle/snooze clocks. `now` is quantized to
  // the minute so the settled partition does not churn on every render
  // (auto-settle thresholds are day-granular anyway); snooze wake times are
  // second-precise, so a separate tick fires exactly at the next wake
  // boundary and the partition reads a fresh clock when it recomputes.
  const nowMinute = useNowMinute();
  const [snoozeWakeTick, bumpSnoozeWakeTick] = useState(0);
  // T3-CUSTOM(expbkt3): END
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const lastVisitedAtByThreadKey = useUiStateStore((state) => state.threadLastVisitedAtById);
  // T3-CUSTOM(expbkt3): directory ids backing the co-participant facet.
  const { users: orgMembers } = useOrgMembers();
  const orgMemberIds = useMemo(
    () => new Set(orgMembers.map((user) => String(user.id))),
    [orgMembers],
  );
  const filters = usePhaseSidebarFilterStore(
    useShallow((state) => ({
      repositoryKeys: state.repositoryKeys,
      phaseIds: state.phaseIds,
      providerKinds: state.providerKinds,
      ownedByMe: state.ownedByMe,
      participantUserIds: state.participantUserIds,
      customGroups: state.customGroups,
    })),
  );
  const clearFilters = usePhaseSidebarFilterStore((state) => state.clearAll);
  const reconcileFilters = usePhaseSidebarFilterStore((state) => state.reconcile);
  // T3-CUSTOM(expbkt3): in-group ordering, set from the filter popover.
  const rowSort = usePhaseSidebarFilterStore((state) => state.sort);
  const [projectPickerOpen, setProjectPickerOpen] = useState(false);
  const [vcsStatusByThreadKey, setVcsStatusByThreadKey] = useState<
    ReadonlyMap<string, VcsStatusResult | null>
  >(() => new Map());
  const [linearIssueStatusByKey, setLinearIssueStatusByKey] = useState<
    ReadonlyMap<string, LinearIssueStatusSummary>
  >(() => new Map());
  const [renamingThreadKey, setRenamingThreadKey] = useState<string | null>(null);
  const [renameTitle, setRenameTitle] = useState("");
  const renameCommitInFlightRef = useRef(false);
  const lastKnownPhaseByThreadKeyRef = useRef(new Map<string, PhaseSidebarPhaseId>());
  const shortcutModifiers = useShortcutModifierState();
  const routeRef = resolveThreadRouteRef(routeParams);
  const routeThreadKey = routeRef ? scopedThreadKey(routeRef) : null;
  const projectByKey = useMemo(
    () =>
      new Map(
        projects.map((project) => [
          scopedProjectKey(scopeProjectRef(project.environmentId, project.id)),
          project,
        ]),
      ),
    [projects],
  );
  const repositoryOptions = useMemo(() => buildPhaseSidebarRepositoryOptions(projects), [projects]);
  const repositoryLabels = useMemo(
    () => new Map(repositoryOptions.map((option) => [option.key, option.label])),
    [repositoryOptions],
  );
  const providerOptions = useMemo(() => {
    const options = new Map<string, ProviderOption>();
    for (const config of serverConfigs.values()) {
      for (const provider of config.providers) {
        const kind = String(provider.driver);
        const name = provider.displayName ?? kind;
        const existing = options.get(kind);
        if (!existing || name.localeCompare(existing.name) < 0) {
          options.set(kind, {
            kind,
            name,
            code: resolvePhaseSidebarProviderCode(kind),
          });
        }
      }
    }
    for (const thread of threads) {
      const instanceId = thread.runtime?.providerInstanceId ?? thread.modelSelection.instanceId;
      const provider = serverConfigs
        .get(thread.environmentId)
        ?.providers.find((candidate) => candidate.instanceId === instanceId);
      const kind = String(provider?.driver ?? instanceId);
      if (!options.has(kind)) {
        options.set(kind, {
          kind,
          name: provider?.displayName ?? thread.runtime?.providerName ?? String(instanceId),
          code: resolvePhaseSidebarProviderCode(kind),
        });
      }
    }
    return [...options.values()].sort((left, right) => left.name.localeCompare(right.name));
  }, [serverConfigs, threads]);
  const providerLabels = useMemo(
    () => new Map(providerOptions.map((option) => [option.kind, option.name])),
    [providerOptions],
  );
  const recordWorkflowStatus = useCallback((threadKey: string, status: VcsStatusResult | null) => {
    setVcsStatusByThreadKey((current) => {
      if (current.get(threadKey) === status) return current;
      const next = new Map(current);
      next.set(threadKey, status);
      return next;
    });
  }, []);
  // T3-CUSTOM(expbkt3): context-menu pinning in the lifecycle sidebar uses
  // the same confirmations and mutation path as the stock sidebar.
  const attemptPin = useCallback(
    (row: PhaseSidebarRow) => {
      void pinThread(scopeThreadRef(row.thread.environmentId, row.thread.id));
    },
    [pinThread],
  );
  const attemptUnpin = useCallback(
    (row: PhaseSidebarRow) => {
      void confirmAndUnpinThread(scopeThreadRef(row.thread.environmentId, row.thread.id));
    },
    [confirmAndUnpinThread],
  );
  const recordLinearIssueStatuses = useCallback(
    (
      environmentId: EnvironmentId,
      identifiers: ReadonlyArray<string>,
      issues: ReadonlyArray<LinearIssueStatusSummary> | null,
      error: string | null,
    ) => {
      if (issues === null && error === null) return;
      setLinearIssueStatusByKey((current) => {
        const next = new Map(current);
        if (issues) {
          for (const issue of issues) {
            next.set(linearIssueStatusKey(environmentId, issue.identifier), issue);
          }
        } else if (error) {
          for (const identifier of identifiers) {
            next.set(linearIssueStatusKey(environmentId, identifier), {
              identifier,
              url: null,
              status: null,
              statusType: null,
              updatedAt: null,
              error,
            });
          }
        }
        return next;
      });
    },
    [],
  );
  // T3-CUSTOM(expbkt3): row assembly lives in client-runtime so the mobile
  // phase sidebar builds identical rows. Only the last-known-phase ref stays
  // here, because it is this component's own anti-flap state.
  // T3-CUSTOM(expbkt3): custom groups live on the thread; this device's
  // pre-label placements only fill in for threads that have none yet.
  const grouping = usePhaseSidebarGroupingStore((state) => state.grouping);
  const localCustomGroupForKey = useCallback(
    (threadKey: string) => phaseSidebarLocalCustomGroupForThread(grouping, threadKey),
    [grouping],
  );
  const allRows = useMemo<ReadonlyArray<PhaseSidebarRow>>(
    () =>
      buildPhaseSidebarRows({
        threads,
        projects,
        serverConfigs,
        vcsStatusByThreadKey,
        lastVisitedAtByThreadKey,
        currentUserId,
        allEnvironmentShellsLive,
        lastKnownPhaseByThreadKey: lastKnownPhaseByThreadKeyRef.current,
        localCustomGroupForKey,
      }),
    [
      projects,
      serverConfigs,
      threads,
      allEnvironmentShellsLive,
      currentUserId,
      lastVisitedAtByThreadKey,
      localCustomGroupForKey,
      vcsStatusByThreadKey,
    ],
  );
  // T3-CUSTOM(expbkt3): BEGIN — worktree codenames. Resolved across the whole
  // thread set rather than per row, because both answers are properties of the
  // set: codenames disambiguate against each other, and occupancy is a count.
  const worktreeView = useMemo(() => resolvePhaseSidebarWorktreeView(threads), [threads]);
  // T3-CUSTOM(expbkt3): END
  // T3-CUSTOM(expbkt3): BEGIN — split the inbox from the parked shelves.
  // Filtering happens once, before the partition, so a filter chip means the
  // same thing in the lifecycle groups and on both shelves.
  const {
    activeRows: unfilteredActiveRows,
    snoozedRows: unfilteredSnoozedRows,
    settledRows: unfilteredSettledRows,
  } = useMemo(() => {
    // Snooze classification uses a REAL clock, not the quantized minute: a
    // thread whose wake time just passed must leave the shelf immediately.
    // snoozeWakeTick re-runs this at the exact boundary.
    void snoozeWakeTick;
    // T3-CUSTOM(expbkt3): partition the UNFILTERED set. Classification never
    // reads the filters, and the lifecycle groups need every row: a session
    // tree has to be able to keep a parent that does not itself match so a
    // matching child stays reachable. Each section applies the filter below.
    return partitionPhaseSidebarRows(
      allRows.filter((row) => row.thread.archivedAt === null),
      {
        now: nowMinute,
        preciseNow: new Date().toISOString(),
        autoSettleAfterDays,
        autoSettleOnMerge,
      },
    );
  }, [allRows, autoSettleAfterDays, autoSettleOnMerge, nowMinute, snoozeWakeTick]);
  // T3-CUSTOM(expbkt3): the shelves are flat history lists, so they filter
  // row-by-row as before. Only the lifecycle groups nest.
  const activeRows = unfilteredActiveRows;
  const snoozedRows = useMemo(
    () => filterVisiblePhaseSidebarRows(unfilteredSnoozedRows, filters),
    [filters, unfilteredSnoozedRows],
  );
  const settledRows = useMemo(
    () => filterVisiblePhaseSidebarRows(unfilteredSettledRows, filters),
    [filters, unfilteredSettledRows],
  );

  // Wake exactly when the soonest snooze expires (the shelf is sorted, so
  // that is the first row). Clamped at 0, and capped so a far-future wake
  // does not overflow the timer into an immediate fire.
  useEffect(() => {
    const nextWakeMs = Date.parse(snoozedRows[0]?.thread.snoozedUntil ?? "");
    if (!Number.isFinite(nextWakeMs)) return;
    const delayMs = Math.min(Math.max(nextWakeMs - Date.now(), 0), 2_147_483_000);
    const id = window.setTimeout(() => bumpSnoozeWakeTick((tick) => tick + 1), delayMs);
    return () => window.clearTimeout(id);
  }, [snoozedRows]);

  // T3-CUSTOM(expbkt3): BEGIN — session trees. Rows created by another session
  // nest under it; grouping then runs over roots only, with a parent pulled
  // into Implementing whenever anything in its subtree is working.
  const titleForThreadKey = useCallback(
    (key: string) =>
      allRows.find(
        (row) => scopedThreadKey(scopeThreadRef(row.thread.environmentId, row.thread.id)) === key,
      )?.thread.title ?? null,
    [allRows],
  );
  // T3-CUSTOM(expbkt3): BEGIN — group by lifecycle, project, or custom groups.
  const toggleSectionCollapsed = usePhaseSidebarGroupingStore(
    (state) => state.toggleSectionCollapsed,
  );
  const createCustomGroup = usePhaseSidebarGroupingStore((state) => state.createGroup);
  const renameCustomGroupLocally = usePhaseSidebarGroupingStore((state) => state.renameGroup);
  const forgetCustomGroup = usePhaseSidebarGroupingStore((state) => state.forgetGroup);
  const moveCustomGroup = usePhaseSidebarGroupingStore((state) => state.moveGroup);
  const pruneGrouping = usePhaseSidebarGroupingStore((state) => state.prune);
  // "New group…" from a row files that row; "Rename" on a section renames it.
  const [groupNameDialogRow, setGroupNameDialogRow] = useState<PhaseSidebarRow | null>(null);
  const [groupRenameTarget, setGroupRenameTarget] = useState<{
    readonly id: string;
    readonly label: string;
  } | null>(null);
  // Every custom group in view, for the row menu, the popover and the filter.
  const customGroupOptions = useMemo(
    () => listPhaseSidebarCustomGroups(allRows, grouping),
    [allRows, grouping],
  );
  const customGroupLabels = useMemo(
    () => new Map(customGroupOptions.map((group) => [group.id, group.label] as const)),
    [customGroupOptions],
  );
  const projectLabelFor = useCallback(
    (environmentId: string, projectId: string) =>
      projectByKey.get(
        scopedProjectKey(scopeProjectRef(environmentId as EnvironmentId, projectId as ProjectId)),
      )?.title ?? null,
    [projectByKey],
  );
  const environmentLabelFor = useCallback(
    (environmentId: string) =>
      environments.find((environment) => environment.environmentId === environmentId)?.label ??
      null,
    [environments],
  );
  const { sections, forcedExpansionKeys } = useMemo(
    () =>
      buildPhaseSidebarSections({
        rows: activeRows,
        filters,
        compareSiblings: (left, right) => comparePhaseSidebarRows(left, right, sortOrder, rowSort),
        titleForKey: titleForThreadKey,
        grouping,
        projectLabelFor,
        environmentLabelFor,
      }),
    [
      activeRows,
      environmentLabelFor,
      filters,
      grouping,
      projectLabelFor,
      rowSort,
      sortOrder,
      titleForThreadKey,
    ],
  );
  const collapsedSectionKeys = useMemo(
    () => new Set(grouping.collapsedSectionKeys),
    [grouping.collapsedSectionKeys],
  );
  // Ghost membership: drop keys no connected environment knows, but only once
  // every environment has reported, so an offline machine's sessions survive.
  useEffect(() => {
    if (!allEnvironmentShellsLive || grouping.customGroups.length === 0) return;
    pruneGrouping(
      new Set(
        allRows.map((row) =>
          scopedThreadKey(scopeThreadRef(row.thread.environmentId, row.thread.id)),
        ),
      ),
    );
  }, [allEnvironmentShellsLive, allRows, grouping.customGroups.length, pruneGrouping]);
  // Placing a session is a thread.meta.update: the label is shared, so every
  // device and every agent sees the same placement.
  const setThreadCustomGroup = useCallback(
    (row: PhaseSidebarRow, customGroup: string | null) => {
      if ((row.thread.customGroup ?? null) === customGroup) return Promise.resolve();
      return updateThreadMetadata({
        environmentId: row.thread.environmentId,
        input: { threadId: row.thread.id, customGroup },
      }).then((result) => {
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title:
                customGroup === null ? "Failed to remove from group" : "Failed to move to group",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
      });
    },
    [updateThreadMetadata],
  );
  // Every session filed under a section, nested ones included when they carry
  // the label themselves; renaming or deleting a group is this set, in bulk.
  const rowsInCustomGroup = useCallback(
    (groupId: string) => allRows.filter((row) => phaseSidebarCustomGroupIdForRow(row) === groupId),
    [allRows],
  );
  const renameCustomGroup = useCallback(
    (groupId: string, label: string) => {
      renameCustomGroupLocally(groupId, label);
      for (const row of rowsInCustomGroup(groupId)) void setThreadCustomGroup(row, label);
    },
    [renameCustomGroupLocally, rowsInCustomGroup, setThreadCustomGroup],
  );
  const deleteCustomGroup = useCallback(
    (groupId: string) => {
      forgetCustomGroup(groupId);
      for (const row of rowsInCustomGroup(groupId)) void setThreadCustomGroup(row, null);
    },
    [forgetCustomGroup, rowsInCustomGroup, setThreadCustomGroup],
  );
  // Always offered, even before any group exists: "New group…" from a row is
  // how the first group gets made, whichever grouping mode is showing.
  const groupActions = useMemo<PhaseThreadRowGroupActions>(
    () => ({
      groups: customGroupOptions.map((group) => ({ id: group.id, label: group.label })),
      onAssign: (row, groupId) =>
        void setThreadCustomGroup(
          row,
          groupId === null ? null : (customGroupLabels.get(groupId) ?? groupId),
        ),
      onCreateGroupWith: (row) => setGroupNameDialogRow(row),
    }),
    [customGroupLabels, customGroupOptions, setThreadCustomGroup],
  );
  /** The lifecycle groups, kept for the callers that reason about phases. */
  const groups = sections;
  // T3-CUSTOM(expbkt3): END
  const storedExpandedKeys = usePhaseSidebarTreeStore((state) => state.expandedKeys);
  const toggleTreeKey = usePhaseSidebarTreeStore((state) => state.toggle);
  const setTreeKeysExpanded = usePhaseSidebarTreeStore((state) => state.setExpanded);
  // A filter match inside a closed parent forces that parent open for as long
  // as the filter is on, without touching what the user chose.
  const expandedKeys = useMemo(() => {
    const keys = new Set(storedExpandedKeys);
    for (const key of forcedExpansionKeys) keys.add(key);
    return keys;
  }, [forcedExpansionKeys, storedExpandedKeys]);
  const isTreeKeyExpanded = useCallback((key: string) => expandedKeys.has(key), [expandedKeys]);
  // Keys that HAVE children, so the arrow-key handler can ignore leaf rows.
  const expandableThreadKeys = useMemo(() => {
    const keys = new Set<string>();
    const visit = (node: PhaseSidebarTreeNode) => {
      if (node.children.length > 0) keys.add(node.key);
      for (const child of node.children) visit(child);
    };
    for (const group of groups) for (const node of group.nodes) visit(node);
    return keys;
  }, [groups]);
  // T3-CUSTOM(expbkt3): END
  // T3-CUSTOM(expbkt3): Separate idle lifecycle groups from live agent work.
  // Only meaningful when the sections ARE lifecycle phases.
  const runningDividerPhaseId =
    grouping.groupBy === "lifecycle"
      ? runningSessionDividerPhase(
          sections.flatMap((section) => (section.phaseId === null ? [] : [section.phaseId])),
        )
      : null;
  // A collapsed section's rows are not on screen, so keyboard traversal and
  // range selection skip them too.
  const activeVisibleNodes = useMemo(
    () =>
      sections.flatMap((section) =>
        collapsedSectionKeys.has(section.key)
          ? []
          : flattenPhaseSidebarTree(section.nodes, isTreeKeyExpanded),
      ),
    [collapsedSectionKeys, isTreeKeyExpanded, sections],
  );
  const activeVisibleRows = useMemo(
    () => activeVisibleNodes.map((node) => node.row),
    [activeVisibleNodes],
  );

  // The settled tail renders in pages: history must not dominate the list.
  const [settledVisibleCount, setSettledVisibleCount] = useState(SETTLED_TAIL_INITIAL_COUNT);
  const showMoreSettled = useCallback(
    () => setSettledVisibleCount((count) => count + SETTLED_TAIL_PAGE_COUNT),
    [],
  );
  // The snoozed shelf is collapsed by default (out of the way, never gone);
  // the settled tail stays open because it is the ordinary "what did I just
  // finish" lookup.
  const [snoozedShelfExpanded, setSnoozedShelfExpanded] = useState(false);
  const [settledShelfExpanded, setSettledShelfExpanded] = useState(true);
  const toggleSnoozedShelf = useCallback(() => setSnoozedShelfExpanded((value) => !value), []);
  const toggleSettledShelf = useCallback(() => setSettledShelfExpanded((value) => !value), []);
  // A parked row reached by route (deep link, or the row you just settled)
  // always renders, even inside a collapsed or paged-out shelf: otherwise
  // the thread you are looking at has no un-settle or wake affordance.
  const pinRoutedRow = useCallback(
    (rendered: ReadonlyArray<PhaseSidebarRow>, all: ReadonlyArray<PhaseSidebarRow>) => {
      if (routeThreadKey === null) return rendered;
      if (
        rendered.some(
          (row) =>
            scopedThreadKey(scopeThreadRef(row.thread.environmentId, row.thread.id)) ===
            routeThreadKey,
        )
      ) {
        return rendered;
      }
      const routedRow = all.find(
        (row) =>
          scopedThreadKey(scopeThreadRef(row.thread.environmentId, row.thread.id)) ===
          routeThreadKey,
      );
      return routedRow ? [...rendered, routedRow] : rendered;
    },
    [routeThreadKey],
  );
  const renderedSnoozedRows = useMemo(
    () => pinRoutedRow(snoozedShelfExpanded ? snoozedRows : [], snoozedRows),
    [pinRoutedRow, snoozedRows, snoozedShelfExpanded],
  );
  const visibleSettledRows = useMemo(
    () => pinRoutedRow(settledRows.slice(0, settledVisibleCount), settledRows),
    [pinRoutedRow, settledRows, settledVisibleCount],
  );
  const hiddenSettledCount = settledRows.length - visibleSettledRows.length;
  const renderedSettledRows = useMemo(
    () => pinRoutedRow(settledShelfExpanded ? visibleSettledRows : [], visibleSettledRows),
    [pinRoutedRow, settledShelfExpanded, visibleSettledRows],
  );
  // Traversal, jump labels and shift-range selection operate on what is
  // actually on screen, shelves included.
  const visibleRows = useMemo(
    () => [...activeVisibleRows, ...renderedSnoozedRows, ...renderedSettledRows],
    [activeVisibleRows, renderedSnoozedRows, renderedSettledRows],
  );
  // T3-CUSTOM(expbkt3): BEGIN — environment markers are conditional on what is
  // actually rendered, not on how many environments are configured. With one
  // environment (the normal case) the sidebar is byte-for-byte unchanged.
  const environmentAppearances = useEnvironmentAppearances();
  const sidebarSpansEnvironments = useMemo(() => {
    const first = visibleRows[0]?.thread.environmentId;
    if (first === undefined) return false;
    return visibleRows.some((candidate) => candidate.thread.environmentId !== first);
  }, [visibleRows]);
  // T3-CUSTOM(expbkt3): END
  const linearIssueStatusRequests = useMemo(() => {
    const identifiersByEnvironment = new Map<EnvironmentId, Set<string>>();
    for (const row of visibleRows) {
      const issue = resolvePhaseSidebarLinearIssue(row.thread.branch, row.thread.linearIssueUrl);
      if (!issue || !row.linearIssueSupported) continue;
      const identifiers = identifiersByEnvironment.get(row.thread.environmentId) ?? new Set();
      identifiers.add(issue.identifier);
      identifiersByEnvironment.set(row.thread.environmentId, identifiers);
    }
    return [...identifiersByEnvironment].map(([environmentId, identifiers]) => ({
      environmentId,
      identifiers: [...identifiers].sort(),
    }));
  }, [visibleRows]);
  // T3-CUSTOM(expbkt3): END

  useEffect(() => {
    const next = new Map(lastKnownPhaseByThreadKeyRef.current);
    for (const row of allRows) {
      if (allEnvironmentShellsLive) {
        next.set(
          scopedThreadKey(scopeThreadRef(row.thread.environmentId, row.thread.id)),
          row.phaseId,
        );
      }
    }
    if (allEnvironmentShellsLive) {
      const currentKeys = new Set(
        allRows.map((row) =>
          scopedThreadKey(scopeThreadRef(row.thread.environmentId, row.thread.id)),
        ),
      );
      for (const threadKey of next.keys()) {
        if (!currentKeys.has(threadKey)) next.delete(threadKey);
      }
    }
    lastKnownPhaseByThreadKeyRef.current = next;
  }, [allEnvironmentShellsLive, allRows]);
  const visibleThreadKeys = useMemo(
    () =>
      visibleRows.map((row) =>
        scopedThreadKey(scopeThreadRef(row.thread.environmentId, row.thread.id)),
      ),
    [visibleRows],
  );
  const visibleRowByKey = useMemo(
    () => new Map(visibleThreadKeys.map((key, index) => [key, visibleRows[index]!])),
    [visibleRows, visibleThreadKeys],
  );
  const activeFiltersCount =
    filters.repositoryKeys.length +
    filters.phaseIds.length +
    filters.providerKinds.length +
    filters.participantUserIds.length +
    filters.customGroups.length +
    (filters.ownedByMe ? 1 : 0);
  const activeThreadHidden =
    activeFiltersCount > 0 &&
    routeThreadKey !== null &&
    allRows.some(
      (row) =>
        row.thread.archivedAt === null &&
        scopedThreadKey(scopeThreadRef(row.thread.environmentId, row.thread.id)) === routeThreadKey,
    ) &&
    !visibleRowByKey.has(routeThreadKey) &&
    // T3-CUSTOM(expbkt3): a thread folded into a collapsed section is not
    // hidden by the filters; it is one header click away.
    !sections.some(
      (section) =>
        collapsedSectionKeys.has(section.key) &&
        flattenPhaseSidebarTree(section.nodes, () => true).some(
          (node) => node.key === routeThreadKey,
        ),
    );
  const activeThread = routeRef
    ? (threads.find(
        (thread) =>
          thread.environmentId === routeRef.environmentId && thread.id === routeRef.threadId,
      ) ?? null)
    : null;
  const activeProject = activeThread
    ? (projectByKey.get(
        scopedProjectKey(scopeProjectRef(activeThread.environmentId, activeThread.projectId)),
      ) ?? null)
    : null;
  const commandPaletteShortcutLabel = shortcutLabelForCommand(
    keybindings,
    "commandPalette.toggle",
    {
      platform: navigator.platform,
      context: { terminalFocus: false, terminalOpen: false },
    },
  );
  const newThreadShortcutLabel = shortcutLabelForCommand(keybindings, "chat.new", {
    platform: navigator.platform,
    context: { terminalFocus: false, terminalOpen: false },
  });
  const showJumpHints = shouldShowThreadJumpHintsForModifiers(shortcutModifiers, keybindings, {
    platform: navigator.platform,
    context: { terminalFocus: false, terminalOpen: false, modelPickerOpen: false },
  });
  const jumpLabelByKey = useMemo(() => {
    if (!showJumpHints) return new Map<string, string>();
    const labels = new Map<string, string>();
    visibleThreadKeys.forEach((key, index) => {
      const command = threadJumpCommandForIndex(index);
      if (!command) return;
      const label = shortcutLabelForCommand(keybindings, command, {
        platform: navigator.platform,
        context: { terminalFocus: false, terminalOpen: false },
      });
      if (label) labels.set(key, label);
    });
    return labels;
  }, [keybindings, showJumpHints, visibleThreadKeys]);
  useEffect(() => {
    if (
      !allEnvironmentShellsLive ||
      networkStatus !== "online" ||
      environments.length === 0 ||
      serverConfigs.size !== environments.length
    ) {
      return;
    }
    reconcileFilters({
      repositoryKeys: new Set(repositoryOptions.map((option) => option.key)),
      providerKinds: new Set(providerOptions.map((option) => option.kind)),
      assignmentAvailable: currentUserId !== null,
      // T3-CUSTOM(expbkt3): drop people who left the directory, so a departed
      // teammate cannot leave an unremovable filter pinned over the sidebar.
      // Skipped while the directory is still loading — an empty list then would
      // clear a perfectly good filter.
      ...(orgMemberIds.size > 0 ? { participantUserIds: orgMemberIds } : {}),
    });
  }, [
    allEnvironmentShellsLive,
    currentUserId,
    environments.length,
    networkStatus,
    orgMemberIds,
    providerOptions,
    reconcileFilters,
    repositoryOptions,
    serverConfigs.size,
  ]);

  const navigateToRow = useCallback(
    (threadRef: ScopedThreadRef) => {
      if (isMobile) setOpenMobile(false);
      void router.navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(threadRef),
      });
    },
    [isMobile, router, setOpenMobile],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat) return;
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement)
        return;
      // T3-CUSTOM(expbkt3): BEGIN — arrows open and close the routed row's
      // subtree, matching how every other tree in the app behaves. Only
      // meaningful on a row that has children, so anything else falls through
      // to the normal shortcut resolution untouched.
      if (
        (event.key === "ArrowRight" || event.key === "ArrowLeft") &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        routeThreadKey !== null &&
        expandableThreadKeys.has(routeThreadKey)
      ) {
        const shouldExpand = event.key === "ArrowRight";
        if (expandedKeys.has(routeThreadKey) !== shouldExpand) {
          event.preventDefault();
          event.stopPropagation();
          setTreeKeysExpanded(routeThreadKey, shouldExpand);
        }
        return;
      }
      // T3-CUSTOM(expbkt3): END
      const command = resolveShortcutCommand(event, keybindings, {
        platform: navigator.platform,
        context: {
          terminalFocus: isTerminalFocused(),
          terminalOpen: false,
          modelPickerOpen: isModelPickerOpen(),
        },
      });
      const direction = threadTraversalDirectionFromCommand(command);
      const jumpIndex = threadJumpIndexFromCommand(command ?? "");
      const targetKey =
        direction !== null
          ? resolvePhaseSidebarTraversalTarget({
              visibleThreadKeys,
              currentThreadKey: routeThreadKey,
              direction,
            })
          : jumpIndex !== null
            ? (visibleThreadKeys[jumpIndex] ?? null)
            : null;
      const row = targetKey ? visibleRowByKey.get(targetKey) : null;
      if (!row) return;
      event.preventDefault();
      event.stopPropagation();
      navigateToRow(scopeThreadRef(row.thread.environmentId, row.thread.id));
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    expandableThreadKeys,
    expandedKeys,
    keybindings,
    navigateToRow,
    routeThreadKey,
    setTreeKeysExpanded,
    visibleRowByKey,
    visibleThreadKeys,
  ]);

  useEffect(() => {
    const onMouseDown = (event: MouseEvent) => {
      if (!useThreadSelectionStore.getState().hasSelection()) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (!shouldClearThreadSelectionOnMouseDown(target)) return;
      useThreadSelectionStore.getState().clearSelection();
    };
    window.addEventListener("mousedown", onMouseDown);
    return () => window.removeEventListener("mousedown", onMouseDown);
  }, []);

  const startRename = useCallback((row: PhaseSidebarRow) => {
    renameCommitInFlightRef.current = false;
    setRenamingThreadKey(scopedThreadKey(scopeThreadRef(row.thread.environmentId, row.thread.id)));
    setRenameTitle(row.thread.title);
  }, []);
  const cancelRename = useCallback(() => {
    renameCommitInFlightRef.current = false;
    setRenamingThreadKey(null);
    setRenameTitle("");
  }, []);
  const commitRename = useCallback(
    (row: PhaseSidebarRow) => {
      if (renameCommitInFlightRef.current) return;
      renameCommitInFlightRef.current = true;
      const title = renameTitle.trim();
      setRenamingThreadKey(null);
      if (!title || title === row.thread.title) {
        renameCommitInFlightRef.current = false;
        return;
      }
      void updateThreadMetadata({
        environmentId: row.thread.environmentId,
        input: { threadId: row.thread.id, title },
      })
        .then((result) => {
          if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
            const error = squashAtomCommandFailure(result);
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: "Failed to rename thread",
                description: error instanceof Error ? error.message : "An error occurred.",
              }),
            );
          }
        })
        .finally(() => {
          renameCommitInFlightRef.current = false;
        });
    },
    [renameTitle, updateThreadMetadata],
  );
  // T3-CUSTOM(expbkt3): BEGIN — session priority.
  const setThreadPriority = useCallback(
    (row: PhaseSidebarRow, priority: 0 | 1 | 2 | 3 | 4 | null) => {
      if (row.thread.priority === priority) return;
      void updateThreadMetadata({
        environmentId: row.thread.environmentId,
        input: { threadId: row.thread.id, priority },
      }).then((result) => {
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Failed to set priority",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
      });
    },
    [updateThreadMetadata],
  );
  // T3-CUSTOM(expbkt3): the Mattermost conversation a session is bound to. The
  // bridge normally writes this when it attaches a session to a chat thread;
  // the row menu is the manual path and the way to clear a stale link.
  const setThreadMattermostThreadUrl = useCallback(
    (row: PhaseSidebarRow, mattermostThreadUrl: string | null) => {
      if ((row.thread.mattermostThreadUrl ?? null) === mattermostThreadUrl) return;
      void updateThreadMetadata({
        environmentId: row.thread.environmentId,
        input: { threadId: row.thread.id, mattermostThreadUrl },
      }).then((result) => {
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Failed to link Mattermost conversation",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
      });
    },
    [updateThreadMetadata],
  );
  const setThreadLinearIssueUrl = useCallback(
    (row: PhaseSidebarRow, linearIssueUrl: string | null) => {
      if ((row.thread.linearIssueUrl ?? null) === linearIssueUrl) return;
      void updateThreadMetadata({
        environmentId: row.thread.environmentId,
        input: { threadId: row.thread.id, linearIssueUrl },
      }).then((result) => {
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Failed to tag Linear issue",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
      });
    },
    [updateThreadMetadata],
  );
  // T3-CUSTOM(expbkt3): BEGIN — hand the title back to the generator. This is
  // the only way past a manual rename, which is otherwise durable.
  const regenerateThreadTitle = useCallback(
    (row: PhaseSidebarRow) => {
      if (row.thread.titleRegeneration != null) return;
      void updateThreadMetadata({
        environmentId: row.thread.environmentId,
        input: { threadId: row.thread.id, regenerateTitle: true },
      }).then((result) => {
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Failed to regenerate thread title",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
      });
    },
    [updateThreadMetadata],
  );
  // T3-CUSTOM(expbkt3): END
  const forceStopAgent = useCallback(
    (row: PhaseSidebarRow) => {
      void forceStopThreadSession({
        environmentId: row.thread.environmentId,
        input: { threadId: row.thread.id },
      });
    },
    [forceStopThreadSession],
  );
  // Session lineage. Both directions travel on the same thread.meta.update
  // command the Linear tag uses; the server rejects a parent that would close
  // a cycle, so the failure toast is the only handling needed here.
  const [moveUnderRow, setMoveUnderRow] = useState<PhaseSidebarRow | null>(null);
  const setThreadParent = useCallback(
    (
      row: PhaseSidebarRow,
      parentThreadId: ThreadId | null,
      // T3-CUSTOM(expbkt3): the environment the parent lives on. Null both for a
      // detach and for a parent on this row's own environment, which is what
      // every same-server link has always meant.
      parentEnvironmentId: EnvironmentId | null = null,
    ) => {
      const nextParentEnvironmentId =
        parentThreadId === null || parentEnvironmentId === row.thread.environmentId
          ? null
          : parentEnvironmentId;
      if (
        (row.thread.parentThreadId ?? null) === parentThreadId &&
        (row.thread.parentEnvironmentId ?? null) === nextParentEnvironmentId
      ) {
        return;
      }
      void updateThreadMetadata({
        environmentId: row.thread.environmentId,
        input: {
          threadId: row.thread.id,
          parentThreadId,
          parentEnvironmentId: nextParentEnvironmentId,
        },
      }).then((result) => {
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title:
                parentThreadId === null ? "Failed to detach session" : "Failed to move session",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
      });
    },
    [updateThreadMetadata],
  );
  const detachFromParent = useCallback(
    (row: PhaseSidebarRow) => setThreadParent(row, null),
    [setThreadParent],
  );
  // Side-by-side sessions. The thread is created before there is a prompt, so
  // it survives navigating away: the row stays in the tree under the session it
  // was started from, and coming back reopens the same empty composer with
  // whatever was typed into it. Navigation waits for the row to exist locally,
  // because the chat route bounces to "/" for a thread its shell has not seen.
  const createThreadFromRow = useCallback(
    (row: PhaseSidebarRow, choice: NewThreadWorkspaceChoice) => {
      const threadId = newThreadId();
      const parentKey = scopedThreadKey(scopeThreadRef(row.thread.environmentId, row.thread.id));
      void (async () => {
        let workspace = resolveSameWorktreeWorkspace(row.thread);
        if (choice === "new-worktree") {
          const project = projectByKey.get(
            scopedProjectKey(scopeProjectRef(row.thread.environmentId, row.thread.projectId)),
          );
          // A new worktree branches from the parent's branch with a temporary
          // name; the first turn renames it, as for any upstream worktree thread.
          const worktreeResult =
            project && row.thread.branch
              ? await createWorktree({
                  environmentId: row.thread.environmentId,
                  input: {
                    cwd: project.workspaceRoot,
                    refName: row.thread.branch,
                    newRefName: buildTemporaryWorktreeBranchName(randomHex),
                    path: null,
                  },
                })
              : null;
          if (worktreeResult?._tag !== "Success") {
            if (worktreeResult && isAtomCommandInterrupted(worktreeResult)) return;
            const error = worktreeResult ? squashAtomCommandFailure(worktreeResult) : null;
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: "Failed to create worktree",
                description: error instanceof Error ? error.message : "An error occurred.",
              }),
            );
            return;
          }
          workspace = {
            branch: worktreeResult.value.worktree.refName,
            worktreePath: worktreeResult.value.worktree.path,
          };
        }
        // The saved defaults: the row's project override, then its host.
        const newThreadDefaults = resolveNewThreadDefaults(
          environmentServerConfigs.get(row.thread.environmentId)?.settings ?? serverSettings,
          row.thread.projectId,
        );
        const result = await createThread({
          environmentId: row.thread.environmentId,
          input: buildNewThreadFromRowCreateInput({
            parent: row.thread,
            threadId,
            workspace,
            modelSelection: newThreadDefaults.modelSelection,
            runtimeMode: newThreadDefaults.runtimeMode,
            interactionMode: planModeAvailable ? newThreadDefaults.interactionMode : "default",
            createdAt: new Date().toISOString(),
          }),
        });
        if (result._tag === "Failure") {
          if (isAtomCommandInterrupted(result)) return;
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Failed to create thread",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
          return;
        }
        // The new row renders inside the parent's subtree, so a collapsed
        // parent would swallow it.
        setTreeKeysExpanded(parentKey, true);
        const threadRef = scopeThreadRef(row.thread.environmentId, threadId);
        if (!(await waitForThreadShell(threadRef))) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Created the thread, but it has not appeared yet",
              description: "It will show up in the sidebar once this client catches up.",
            }),
          );
          return;
        }
        navigateToRow(threadRef);
      })();
    },
    [
      createThread,
      createWorktree,
      environmentServerConfigs,
      navigateToRow,
      planModeAvailable,
      projectByKey,
      serverSettings,
      setTreeKeysExpanded,
    ],
  );
  const openMoveUnderDialog = useCallback((row: PhaseSidebarRow) => setMoveUnderRow(row), []);
  const subtreeKeysByThreadKey = useMemo(() => {
    const map = new Map<string, ReadonlyArray<string>>();
    const visit = (node: PhaseSidebarTreeNode) => {
      map.set(node.key, collectPhaseSidebarSubtreeKeys(node));
      for (const child of node.children) visit(child);
    };
    for (const group of groups) for (const node of group.nodes) visit(node);
    return map;
  }, [groups]);
  const jumpToThreadKey = useCallback(
    (key: string) => {
      const target = allRows.find(
        (candidate) =>
          scopedThreadKey(scopeThreadRef(candidate.thread.environmentId, candidate.thread.id)) ===
          key,
      );
      if (target) navigateToRow(scopeThreadRef(target.thread.environmentId, target.thread.id));
    },
    [allRows, navigateToRow],
  );
  // One object instance shared by every row, so the memo on PhaseThreadRow
  // survives the sidebar's frequent re-renders.
  const treeActions = useMemo<PhaseThreadRowTreeActions>(
    () => ({
      onToggle: (threadKey) => toggleTreeKey(threadKey),
      onSetSubtreeExpanded: (threadKey, expanded) =>
        setTreeKeysExpanded(
          [threadKey, ...(subtreeKeysByThreadKey.get(threadKey) ?? [])],
          expanded,
        ),
      onMoveUnder: openMoveUnderDialog,
      onDetach: detachFromParent,
      onJumpToParent: jumpToThreadKey,
    }),
    [
      detachFromParent,
      jumpToThreadKey,
      openMoveUnderDialog,
      setTreeKeysExpanded,
      subtreeKeysByThreadKey,
      toggleTreeKey,
    ],
  );
  // T3-CUSTOM(expbkt3): END
  const requestArchive = useCallback(
    async (row: PhaseSidebarRow) => {
      if (confirmArchive) {
        const confirmed = await readLocalApi()?.dialogs.confirm(
          `Archive thread "${row.thread.title}"?`,
        );
        if (!confirmed) return;
      }
      const result = await archiveThread(scopeThreadRef(row.thread.environmentId, row.thread.id));
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to archive thread",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
    },
    [archiveThread, confirmArchive],
  );
  // T3-CUSTOM(expbkt3): BEGIN — settle/snooze commands.
  // Refs keep these callbacks stable: they are handed to a memoized row, so
  // depending on the route or the row list directly would re-render every
  // row on each navigation. They also have to read the CURRENT route when a
  // command resolves, not the one captured when it started.
  const activeVisibleRowsRef = useRef(activeVisibleRows);
  activeVisibleRowsRef.current = activeVisibleRows;
  const routeThreadKeyRef = useRef(routeThreadKey);
  routeThreadKeyRef.current = routeThreadKey;
  // One parking command per thread at a time: a double click must not
  // dispatch a second settle that fails and toasts a false error.
  const parkingThreadKeysRef = useRef(new Set<string>());
  // Parking the thread you are looking at moves you forward to the next
  // lifecycle row — never into a shelf, since that is what you just left.
  const planForwardNavigation = useCallback(
    (threadKey: string) => {
      const rows = activeVisibleRowsRef.current;
      const index = rows.findIndex(
        (row) =>
          scopedThreadKey(scopeThreadRef(row.thread.environmentId, row.thread.id)) === threadKey,
      );
      if (index === -1) return null;
      const target = rows[index + 1] ?? rows[index - 1] ?? null;
      if (!target) return null;
      return () => navigateToRow(scopeThreadRef(target.thread.environmentId, target.thread.id));
    },
    [navigateToRow],
  );
  const reportParkingFailure = useCallback((title: string, result: ParkingCommandFailure) => {
    if (isAtomCommandInterrupted(result)) return;
    const error = squashAtomCommandFailure(result);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title,
        description: error instanceof Error ? error.message : "An error occurred.",
      }),
    );
  }, []);
  const attemptUnsnooze = useCallback(
    (row: PhaseSidebarRow) => {
      void (async () => {
        const result = await unsnoozeThread(
          scopeThreadRef(row.thread.environmentId, row.thread.id),
        );
        if (result._tag === "Failure") reportParkingFailure("Failed to wake thread", result);
      })();
    },
    [reportParkingFailure, unsnoozeThread],
  );
  const attemptUnsettle = useCallback(
    (row: PhaseSidebarRow) => {
      void (async () => {
        const result = await unsettleThread(
          scopeThreadRef(row.thread.environmentId, row.thread.id),
        );
        if (result._tag === "Failure") reportParkingFailure("Failed to un-settle thread", result);
      })();
    },
    [reportParkingFailure, unsettleThread],
  );
  const attemptSettle = useCallback(
    (row: PhaseSidebarRow) => {
      void (async () => {
        const threadRef = scopeThreadRef(row.thread.environmentId, row.thread.id);
        const threadKey = scopedThreadKey(threadRef);
        if (parkingThreadKeysRef.current.has(threadKey)) return;
        parkingThreadKeysRef.current.add(threadKey);
        try {
          const navigateAfterSettle = planForwardNavigation(threadKey);
          const result = await settleThread(threadRef);
          if (result._tag === "Failure") {
            // Never navigate away from a thread that did not settle.
            reportParkingFailure("Failed to settle thread", result);
            return;
          }
          // Settle is a high-frequency action and stays silent on success.
          // Only move forward if the user is still on the settled thread — a
          // navigation made during the await wins over ours.
          if (routeThreadKeyRef.current === threadKey) navigateAfterSettle?.();
        } finally {
          parkingThreadKeysRef.current.delete(threadKey);
        }
      })();
    },
    [planForwardNavigation, reportParkingFailure, settleThread],
  );
  const attemptSnooze = useCallback(
    (row: PhaseSidebarRow, preset: SnoozePreset) => {
      void (async () => {
        const threadRef = scopeThreadRef(row.thread.environmentId, row.thread.id);
        const threadKey = scopedThreadKey(threadRef);
        if (parkingThreadKeysRef.current.has(threadKey)) return;
        parkingThreadKeysRef.current.add(threadKey);
        try {
          const navigateAfterSnooze = planForwardNavigation(threadKey);
          const result = await snoozeThread(threadRef, preset.snoozedUntil);
          if (result._tag === "Failure") {
            reportParkingFailure("Failed to snooze thread", result);
            return;
          }
          // Snooze moves the row to a collapsed shelf, so the toast is the
          // only confirmation — and the Undo is the escape hatch for a
          // mis-click.
          toastManager.add(
            stackedThreadToast({
              type: "success",
              title: `Snoozed until ${snoozeWakeDescription(preset.snoozedUntil, new Date(), timestampFormat)}`,
              timeout: 5_000,
              actionProps: {
                children: "Undo",
                onClick: () => attemptUnsnooze(row),
              },
            }),
          );
          if (routeThreadKeyRef.current === threadKey) navigateAfterSnooze?.();
        } finally {
          parkingThreadKeysRef.current.delete(threadKey);
        }
      })();
    },
    [attemptUnsnooze, planForwardNavigation, reportParkingFailure, snoozeThread],
  );
  // T3-CUSTOM(expbkt3): END
  const requestDelete = useCallback(
    (row: PhaseSidebarRow) => {
      void confirmAndDeleteThread(scopeThreadRef(row.thread.environmentId, row.thread.id)).then(
        (result) => {
          if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
            const error = squashAtomCommandFailure(result);
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: "Failed to delete thread",
                description: error instanceof Error ? error.message : "An error occurred.",
              }),
            );
          }
        },
      );
    },
    [confirmAndDeleteThread],
  );
  // Stable identity for the memoized row (an inline arrow defeated it).
  const handleArchive = useCallback(
    (row: PhaseSidebarRow) => void requestArchive(row),
    [requestArchive],
  );
  const startGlobalNewThread = useCallback(() => {
    if (projects.length === 1 && projects[0]) {
      void handleNewThread(scopeProjectRef(projects[0].environmentId, projects[0].id));
      return;
    }
    setProjectPickerOpen(true);
  }, [handleNewThread, projects]);
  const selectNewThreadProject = useCallback(
    (project: Project) => {
      setProjectPickerOpen(false);
      void handleNewThread(scopeProjectRef(project.environmentId, project.id));
    },
    [handleNewThread],
  );
  // T3-CUSTOM(expbkt3): BEGIN — the project picker names the machine a project
  // lives on, so two same-named projects are told apart by where they run.
  // Stable identities: the picker memoizes its option list on these.
  const environmentLabelById = useMemo(
    () =>
      new Map(
        environments.map((environment) => [environment.environmentId, environment.label] as const),
      ),
    [environments],
  );
  const resolveNewThreadEnvironmentLabel = useCallback(
    (environmentId: EnvironmentId) => environmentLabelById.get(environmentId) ?? null,
    [environmentLabelById],
  );
  const resolveNewThreadEnvironmentAppearance = useCallback(
    (environmentId: EnvironmentId) => environmentAppearances.get(environmentId) ?? null,
    [environmentAppearances],
  );
  // T3-CUSTOM(expbkt3): END

  // T3-CUSTOM(expbkt3): One row shape for the lifecycle groups and both
  // parked shelves — only `section` differs.
  const renderThreadRow = (
    row: PhaseSidebarRow,
    section: PhaseSidebarSection,
    // T3-CUSTOM(expbkt3): omitted on shelf rows, which stay a flat history list.
    // Spread this straight onto the row — never nest it under a `tree` key.
    // JSX spread skips excess-property checking, so a stale wrapper compiles
    // clean while silently leaving every treeXxx prop undefined, which reads as
    // "the feature is off" rather than as a build error.
    tree?: PhaseThreadRowTreeProps,
  ) => {
    const key = scopedThreadKey(scopeThreadRef(row.thread.environmentId, row.thread.id));
    const project =
      projectByKey.get(
        scopedProjectKey(scopeProjectRef(row.thread.environmentId, row.thread.projectId)),
      ) ?? null;
    return (
      <PhaseThreadRow
        key={key}
        row={row}
        section={section}
        project={project}
        // T3-CUSTOM(expbkt3): only when the sessions on screen actually span more
        // than one environment — a second environment with nothing in view is not
        // a reason to mark every row.
        {...(sidebarSpansEnvironments
          ? { environmentAppearance: environmentAppearances.get(row.thread.environmentId) }
          : {})}
        vcsStatus={vcsStatusByThreadKey.get(key) ?? null}
        onWorkflowStatus={recordWorkflowStatus}
        pinningSupported={
          serverConfigs.get(row.thread.environmentId)?.environment.capabilities.threadPinning ===
          true
        }
        onPin={attemptPin}
        onUnpin={attemptUnpin}
        {...phaseSidebarWorktreeRowProps(worktreeView, row.thread.worktreePath)}
        active={routeThreadKey === key}
        orderedThreadKeys={visibleThreadKeys}
        jumpLabel={jumpLabelByKey.get(key) ?? null}
        renaming={renamingThreadKey === key}
        renameTitle={renameTitle}
        onRenameTitleChange={setRenameTitle}
        onStartRename={startRename}
        onCommitRename={commitRename}
        onCancelRename={cancelRename}
        onNavigate={navigateToRow}
        onForceStop={forceStopAgent}
        onArchive={handleArchive}
        onDelete={requestDelete}
        onSettle={attemptSettle}
        onUnsettle={attemptUnsettle}
        onSnooze={attemptSnooze}
        onUnsnooze={attemptUnsnooze}
        onSetPriority={setThreadPriority}
        onSetLinearIssueUrl={setThreadLinearIssueUrl}
        onSetMattermostThreadUrl={setThreadMattermostThreadUrl}
        onRegenerateTitle={regenerateThreadTitle}
        onCreateThread={createThreadFromRow}
        // T3-CUSTOM(expbkt3): custom groups.
        {...(groupActions ? { groupActions } : {})}
        customGroupId={phaseSidebarCustomGroupIdForRow(row)}
        customGroupLabel={grouping.groupBy === "custom" ? null : (row.customGroup ?? null)}
        linearIssueStatus={(() => {
          const issue = resolvePhaseSidebarLinearIssue(
            row.thread.branch,
            row.thread.linearIssueUrl,
          );
          return issue
            ? (linearIssueStatusByKey.get(
                linearIssueStatusKey(row.thread.environmentId, issue.identifier),
              ) ?? null)
            : null;
        })()}
        {...(tree ?? {})}
      />
    );
  };

  // T3-CUSTOM(expbkt3): BEGIN — a session tree renders as nested <ul>s so the
  // list stays a list for assistive tech, and each level animates on its own.
  const renderTreeNode = (node: PhaseSidebarTreeNode): ReactNode => {
    const expanded = expandedKeys.has(node.key);
    return (
      <Fragment key={node.key}>
        {renderThreadRow(node.row, "active", {
          treeActions,
          treeDepth: node.depth,
          treeDescendantCount: node.descendantCount,
          treeHasBusyDescendant: node.hasBusyDescendant,
          treeDescendantUnreadCount: node.descendantUnreadCount,
          treeDescendantRunningCount: node.descendantRunningCount,
          treeDescendantAttention: node.descendantAttention,
          treeExpanded: expanded,
          treeParentKey: node.orphanedFrom?.key ?? null,
          treeParentTitle: node.orphanedFrom?.title ?? null,
        })}
        {expanded && node.children.length > 0 ? (
          <li>
            <ul
              ref={autoAnimatedListRef}
              role="group"
              aria-label={`Sessions started by ${node.row.thread.title}`}
              className="mt-0.5 space-y-0.5 border-l border-sidebar-border pl-1"
            >
              {node.children.map((child) => renderTreeNode(child))}
            </ul>
          </li>
        ) : null}
      </Fragment>
    );
  };
  // T3-CUSTOM(expbkt3): END

  return (
    <>
      {linearIssueStatusRequests.map(({ environmentId, identifiers }) => (
        <LinearIssueStatusProbe
          key={`linear:${environmentId}:${identifiers.join(",")}`}
          environmentId={environmentId}
          identifiers={identifiers}
          refreshMinute={nowMinute}
          onStatus={recordLinearIssueStatuses}
        />
      ))}
      <SidebarChromeHeader isElectron={isElectron} />
      <SidebarContent className="gap-0">
        <SidebarGroup className="px-2 pt-2 pb-1">
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarSearchAction shortcutLabel={commandPaletteShortcutLabel} />
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                size="sm"
                className="gap-2 px-2 py-1.5"
                onClick={startGlobalNewThread}
              >
                <PlusIcon className="size-3.5" />
                <span className="flex-1 text-left text-xs">New thread</span>
                {newThreadShortcutLabel ? (
                  <Kbd className="h-4 px-1.5 text-[10px]">{newThreadShortcutLabel}</Kbd>
                ) : null}
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroup>
        <SidebarEnvironmentNotices />
        <SidebarGroup className="px-2 pt-1 pb-2">
          <div className="flex items-center justify-between px-1">
            {/* T3-CUSTOM(expbkt3): the caption is the group-by control. */}
            <PhaseSidebarGroupByPopover
              groups={customGroupOptions}
              onCreateGroup={createCustomGroup}
              onRenameGroup={renameCustomGroup}
              onDeleteGroup={deleteCustomGroup}
              onMoveGroup={moveCustomGroup}
            />
            <PhaseFilterPopover
              repositories={repositoryOptions}
              providers={providerOptions}
              groups={customGroupOptions}
            />
          </div>
          <ActiveFilterChips
            repositoryLabels={repositoryLabels}
            providerLabels={providerLabels}
            customGroupLabels={customGroupLabels}
          />
        </SidebarGroup>
        {activeThreadHidden ? (
          <div className="mx-2 mb-2 flex items-center justify-between gap-2 rounded-md border border-border/60 bg-muted/40 px-2 py-1.5 text-[10px] text-muted-foreground">
            <span>Current thread is hidden by filters</span>
            <button
              type="button"
              className="shrink-0 text-foreground hover:underline"
              onClick={clearFilters}
            >
              Clear
            </button>
          </div>
        ) : null}
        <div
          ref={autoAnimatedListRef}
          className="min-h-0 flex-1 overflow-y-auto px-2 pb-3"
          data-testid="phase-sidebar-groups"
        >
          {sections.map((section) => (
            <PhaseSidebarSectionBlock
              key={section.key}
              section={section}
              collapsed={collapsedSectionKeys.has(section.key)}
              showRunningDivider={
                section.phaseId !== null && section.phaseId === runningDividerPhaseId
              }
              onToggleCollapsed={toggleSectionCollapsed}
              renderTreeNode={renderTreeNode}
              {...(section.kind === "custom" && !section.isUngrouped
                ? {
                    onRenameGroup: () =>
                      setGroupRenameTarget({ id: section.id, label: section.label }),
                    onDeleteGroup: () => deleteCustomGroup(section.id),
                  }
                : {})}
            />
          ))}
          {/* T3-CUSTOM(expbkt3): BEGIN — parked shelves below the lifecycle
              groups: out of the way, never gone, always undoable. */}
          {snoozedRows.length > 0 ? (
            <section className="mb-3" data-testid="phase-sidebar-snoozed-shelf">
              <button
                type="button"
                onClick={toggleSnoozedShelf}
                aria-expanded={snoozedShelfExpanded}
                data-testid="phase-sidebar-snoozed-shelf-toggle"
                className="mb-1 flex w-full cursor-pointer items-center gap-2 px-2 text-left"
              >
                <AlarmClockIcon
                  aria-hidden
                  className="size-2.5 shrink-0 text-blue-600 dark:text-blue-400"
                />
                <span className="text-[10px] font-semibold uppercase tracking-wider text-blue-600 dark:text-blue-400">
                  Snoozed
                </span>
                <span className="h-px flex-1 bg-blue-500/20 dark:bg-blue-400/15" />
                <span className="text-[9px] tabular-nums text-muted-foreground/55">
                  {snoozedRows.length}
                </span>
                <ChevronDownIcon
                  aria-hidden
                  className={cn(
                    "size-3 text-blue-600 transition-transform dark:text-blue-400",
                    snoozedShelfExpanded && "rotate-180",
                  )}
                />
              </button>
              {/* T3-CUSTOM(expbkt3): a collapsed shelf renders no rows, so it must
                  render no list either. An empty list left in the tree is where
                  auto-animate re-inserts the row it is animating out, and it is
                  animated in turn, so the two bounce the row between them and it
                  blinks until the page is reloaded. The shelves are parked
                  history: they lose nothing by not animating. */}
              {renderedSnoozedRows.length > 0 ? (
                <ul className="space-y-0.5">
                  {renderedSnoozedRows.map((row) => renderThreadRow(row, "snoozed"))}
                </ul>
              ) : null}
            </section>
          ) : null}
          {settledRows.length > 0 ? (
            <section className="mb-3" data-testid="phase-sidebar-settled-shelf">
              <button
                type="button"
                onClick={toggleSettledShelf}
                aria-expanded={settledShelfExpanded}
                data-testid="phase-sidebar-settled-shelf-toggle"
                className="mb-1 flex w-full cursor-pointer items-center gap-2 px-2 text-left"
              >
                <CheckIcon aria-hidden className="size-2.5 shrink-0 text-muted-foreground/50" />
                <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/50">
                  Settled
                </span>
                <span className="h-px flex-1 bg-sidebar-border/60" />
                <span className="text-[9px] tabular-nums text-muted-foreground/55">
                  {settledRows.length}
                </span>
                <ChevronDownIcon
                  aria-hidden
                  className={cn(
                    "size-3 text-muted-foreground/50 transition-transform",
                    settledShelfExpanded && "rotate-180",
                  )}
                />
              </button>
              {renderedSettledRows.length > 0 ? (
                <ul className="space-y-0.5">
                  {renderedSettledRows.map((row) => renderThreadRow(row, "settled"))}
                </ul>
              ) : null}
              {settledShelfExpanded && hiddenSettledCount > 0 ? (
                <button
                  type="button"
                  onClick={showMoreSettled}
                  className="mt-1 flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-border py-1 font-mono text-[10px] text-muted-foreground transition-colors hover:border-solid hover:border-input hover:text-foreground"
                >
                  Show {Math.min(hiddenSettledCount, SETTLED_TAIL_PAGE_COUNT)} more
                  <span className="text-muted-foreground/50">({hiddenSettledCount} hidden)</span>
                </button>
              ) : null}
            </section>
          ) : null}
          {/* T3-CUSTOM(expbkt3): END */}
          {sections.every((section) => section.nodes.length === 0) &&
          snoozedRows.length + settledRows.length === 0 ? (
            <div className="flex flex-col items-center gap-2 px-4 py-12 text-center">
              <FilterIcon className="size-5 text-muted-foreground/40" />
              <p className="text-xs text-muted-foreground">No threads match these filters</p>
              {activeFiltersCount > 0 ? (
                <Button size="xs" variant="outline" onClick={clearFilters}>
                  Clear filters
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      </SidebarContent>
      {/* Upstream removed SidebarSeparator; same classes inlined. */}
      <Separator className="mx-2 w-auto! bg-sidebar-border" data-sidebar="separator" />
      <SidebarChromeFooter />
      {activeVisibleRows.slice(0, 10).map((row) => (
        <SidebarThreadDetailPrewarmer
          key={`prewarm:${row.thread.environmentId}:${row.thread.id}`}
          threadRef={scopeThreadRef(row.thread.environmentId, row.thread.id)}
        />
      ))}
      <NewThreadProjectPicker
        open={projectPickerOpen}
        projects={projects}
        activeProject={activeProject}
        primaryEnvironmentId={primaryEnvironmentId}
        resolveEnvironmentLabel={resolveNewThreadEnvironmentLabel}
        appearanceFor={resolveNewThreadEnvironmentAppearance}
        onOpenChange={setProjectPickerOpen}
        onSelect={selectNewThreadProject}
        onAddProject={() => {
          setProjectPickerOpen(false);
          openAddProject();
        }}
      />
      {/* T3-CUSTOM(expbkt3): custom groups — "New group…" from a row files that row. */}
      <PhaseSidebarGroupNameDialog
        open={groupNameDialogRow !== null}
        mode="create"
        initialLabel=""
        onOpenChange={(open) => {
          if (!open) setGroupNameDialogRow(null);
        }}
        onSubmit={(label) => {
          if (groupNameDialogRow) void setThreadCustomGroup(groupNameDialogRow, label);
          setGroupNameDialogRow(null);
        }}
      />
      {/* T3-CUSTOM(expbkt3): custom groups — rename from a section header. */}
      <PhaseSidebarGroupNameDialog
        open={groupRenameTarget !== null}
        mode="rename"
        initialLabel={groupRenameTarget?.label ?? ""}
        onOpenChange={(open) => {
          if (!open) setGroupRenameTarget(null);
        }}
        onSubmit={(label) => {
          if (groupRenameTarget) renameCustomGroup(groupRenameTarget.id, label);
          setGroupRenameTarget(null);
        }}
      />
      {/* T3-CUSTOM(expbkt3): session lineage. */}
      <MoveUnderSessionDialog
        subject={moveUnderRow?.thread ?? null}
        threads={allRows.map((row) => row.thread)}
        repositoryLabelFor={(thread) =>
          allRows.find(
            (row) =>
              row.thread.id === thread.id && row.thread.environmentId === thread.environmentId,
          )?.repositoryLabel ?? ""
        }
        onOpenChange={(open) => {
          if (!open) setMoveUnderRow(null);
        }}
        onSelect={(parent) => {
          if (moveUnderRow) setThreadParent(moveUnderRow, parent.id, parent.environmentId);
          setMoveUnderRow(null);
        }}
      />
    </>
  );
}

/**
 * T3-CUSTOM(expbkt3): one section of the list — a lifecycle phase, a project,
 * or a custom group. The header is the collapse toggle; when closed it keeps
 * saying what it hides (running / needs input / unread) so nothing goes quiet
 * just because it was folded away.
 */
function PhaseSidebarSectionBlock({
  section,
  collapsed,
  showRunningDivider,
  onToggleCollapsed,
  renderTreeNode,
  onRenameGroup,
  onDeleteGroup,
}: {
  readonly section: PhaseSidebarGroupSection;
  readonly collapsed: boolean;
  readonly showRunningDivider: boolean;
  readonly onToggleCollapsed: (sectionKey: string) => void;
  readonly renderTreeNode: (node: PhaseSidebarTreeNode) => ReactNode;
  /** Custom groups are managed from their header; absent on every other section. */
  readonly onRenameGroup?: () => void;
  readonly onDeleteGroup?: () => void;
}) {
  const { summary } = section;
  const phaseId = phaseSidebarSectionPhase(section);
  const manageable = onRenameGroup !== undefined || onDeleteGroup !== undefined;
  return (
    <section
      className="mb-3"
      data-phase-id={section.phaseId ?? undefined}
      data-section-key={section.key}
      data-testid="phase-sidebar-section"
    >
      {/* A quiet boundary before live agent work. */}
      {showRunningDivider ? <RunningSessionDivider /> : null}
      <div className={cn(manageable && "group/section flex items-stretch gap-0.5")}>
        <button
          type="button"
          aria-expanded={!collapsed}
          aria-label={`${section.label}, ${section.nodes.length} session${section.nodes.length === 1 ? "" : "s"}${collapsed ? ", collapsed" : ""}`}
          onClick={() => onToggleCollapsed(section.key)}
          className={cn(
            phaseSidebarSectionHeaderClassName(
              section.kind === "lifecycle" ? section.phaseId : phaseId,
            ),
            "w-full cursor-pointer text-left",
            manageable && "min-w-0 flex-1",
          )}
        >
          <ChevronDownIcon
            aria-hidden
            className={cn("size-3 shrink-0 transition-transform", collapsed && "-rotate-90")}
          />
          <span className="truncate text-[11px] font-bold uppercase tracking-[0.1em]">
            {section.label}
          </span>
          <span className="min-w-0 flex-1 truncate text-[9px] text-current/55">
            {section.helperText}
          </span>
          {collapsed && summary.attention > 0 ? (
            <span
              className="rounded-full bg-red-500/15 px-1.5 py-0.5 text-[9px] font-semibold tabular-nums text-red-700 dark:text-red-300"
              aria-label={`${summary.attention} waiting on you`}
            >
              {summary.attention}
            </span>
          ) : null}
          {collapsed && summary.running > 0 ? (
            <span
              className="rounded-full bg-sky-500/15 px-1.5 py-0.5 text-[9px] font-semibold tabular-nums text-sky-700 dark:text-sky-300"
              aria-label={`${summary.running} running`}
            >
              {summary.running}
            </span>
          ) : null}
          {collapsed && summary.unread > 0 ? (
            <span
              className="rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[9px] font-semibold tabular-nums text-emerald-700 dark:text-emerald-300"
              aria-label={`${summary.unread} unread`}
            >
              {summary.unread}
            </span>
          ) : null}
          <span className="min-w-4 rounded-full bg-background/45 px-1.5 py-0.5 text-center text-[9px] font-semibold tabular-nums text-current/70">
            {section.nodes.length}
          </span>
        </button>
        {manageable ? (
          <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover/section:opacity-100">
            {onRenameGroup ? (
              <button
                type="button"
                aria-label={`Rename group ${section.label}`}
                onClick={onRenameGroup}
                className="rounded p-0.5 text-muted-foreground hover:text-foreground"
              >
                <PencilIcon className="size-3" />
              </button>
            ) : null}
            {onDeleteGroup ? (
              <button
                type="button"
                aria-label={`Delete group ${section.label}`}
                onClick={onDeleteGroup}
                className="rounded p-0.5 text-muted-foreground hover:text-destructive"
              >
                <Trash2Icon className="size-3" />
              </button>
            ) : null}
          </span>
        ) : null}
      </div>
      {collapsed ? null : section.nodes.length === 0 ? (
        <p className="px-2 py-1 text-[10px] text-muted-foreground/60">
          Empty — use “Move to group” on a session.
        </p>
      ) : (
        <ul ref={autoAnimatedListRef} className="space-y-0.5">
          {section.nodes.map((node) => renderTreeNode(node))}
        </ul>
      )}
    </section>
  );
}

export default PhaseGroupedSidebar;
