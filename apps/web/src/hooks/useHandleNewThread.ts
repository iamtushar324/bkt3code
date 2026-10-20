import {
  scopedProjectKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
// T3-CUSTOM(expbkt3): multi-line to add the EnvironmentId type import below.
import {
  // T3-CUSTOM(expbkt3): plan mode is coerced off when its toggle is hidden.
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_SERVER_SETTINGS,
  // T3-CUSTOM(expbkt3): a child thread can start on another machine.
  type EnvironmentId,
  type ScopedProjectRef,
  type ThreadId,
} from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import {
  composerDraftHasUserContent,
  markPromotedDraftThreadByRef,
  type DraftId,
  type DraftThreadEnvMode,
  type DraftThreadState,
  useComposerDraftStore,
} from "../composerDraftStore";
import { newDraftId, newThreadId } from "../lib/utils";
import { orderItemsByPreferredIds } from "../components/Sidebar.logic";
import {
  deriveLogicalProjectKeyFromSettings,
  getProjectOrderKey,
  selectProjectGroupingSettings,
} from "../logicalProject";
import { resolveNewThreadEnvMode, resolveProjectSettings } from "@t3tools/shared/projectSettings";
import {
  readProject,
  readProjects,
  readThreadShell,
  readThreadShells,
  useProjects,
  useQuietThreadShell,
} from "../state/entities";
import {
  hasExplicitComposerModelSelection,
  resolveNewDraftStartFromOrigin,
  resolveNewThreadModelSelectionOverride,
} from "../lib/chatThreadActions";
import { readT3ProjectFile } from "../lib/t3ProjectFileDefaults";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentServerConfigsAtom } from "../state/server";
import { resolveThreadRouteTarget } from "../threadRoutes";
import { legacyProjectCwdPreferenceKey, useUiStateStore } from "../uiStateStore";
import { useClientSettings } from "./useSettings";
import { useThreadRouteTarget } from "./useThreadRouteTarget";

interface NewThreadWorkspaceOptions {
  branch?: string | null;
  worktreePath?: string | null;
  envMode?: DraftThreadEnvMode;
  startFromOrigin?: boolean;
  // T3-CUSTOM(expbkt3): promote the eventual thread as a child of this thread.
  parentThreadId?: ThreadId | null;
  // T3-CUSTOM(expbkt3): the environment that parent lives on, when the child is
  // being started somewhere else — typically because the parent's host is down.
  parentEnvironmentId?: EnvironmentId | null;
}

function pickExplicitWorkspaceOptions(options: NewThreadWorkspaceOptions | undefined) {
  return {
    ...(options?.branch !== undefined ? { branch: options.branch } : {}),
    ...(options?.worktreePath !== undefined ? { worktreePath: options.worktreePath } : {}),
    ...(options?.envMode !== undefined ? { envMode: options.envMode } : {}),
    ...(options?.startFromOrigin !== undefined ? { startFromOrigin: options.startFromOrigin } : {}),
    // T3-CUSTOM(expbkt3): explicit parent-thread picks ride along with the
    // other explicit workspace options.
    ...(options?.parentThreadId !== undefined ? { parentThreadId: options.parentThreadId } : {}),
    ...(options?.parentEnvironmentId !== undefined
      ? { parentEnvironmentId: options.parentEnvironmentId }
      : {}),
  };
}

export function useNewThreadHandler() {
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  // T3-CUSTOM(expbkt3): a saved Plan default only applies while the plan toggle exists.
  const planModeAvailable = useClientSettings((settings) => settings.planModeAvailable);
  const router = useRouter();
  const getCurrentRouteTarget = () => {
    const currentRouteParams = router.state.matches[router.state.matches.length - 1]?.params ?? {};
    return resolveThreadRouteTarget(currentRouteParams);
  };

  return (
    projectRef: ScopedProjectRef,
    options?: {
      branch?: string | null;
      worktreePath?: string | null;
      envMode?: DraftThreadEnvMode;
      startFromOrigin?: boolean;
      // T3-CUSTOM(expbkt3): promote the eventual thread as a child of this thread.
      parentThreadId?: ThreadId | null;
      // T3-CUSTOM(expbkt3): the parent's environment, when the child is being
      // started on a different machine from the session it continues.
      parentEnvironmentId?: EnvironmentId | null;
      replace?: boolean;
    },
  ): Promise<{ draftId: DraftId; threadId: ThreadId } | null> => {
    const projects = readProjects();
    // Read at call time: every provider status push replaces the config map, and
    // subscribing would hand every sidebar row a new handler.
    const environmentServerConfigs = appAtomRegistry.get(environmentServerConfigsAtom);
    const targetServerSettings =
      environmentServerConfigs.get(projectRef.environmentId)?.settings ?? DEFAULT_SERVER_SETTINGS;
    const {
      getComposerDraft,
      getDraftSessionByLogicalProjectKey,
      getDraftSession,
      getDraftThread,
      applyStickyState,
      setDraftThreadContext,
      setLogicalProjectDraftThreadId,
      setModelSelection,
      // T3-CUSTOM(expbkt3): a reused empty draft drops its composer mode overrides.
      setRuntimeMode,
      setInteractionMode,
    } = useComposerDraftStore.getState();
    const requestingRouteHref = router.state.location.href;
    const routeChangedSinceRequest = () => router.state.location.href !== requestingRouteHref;
    const currentRouteTarget = getCurrentRouteTarget();
    // T3-CUSTOM(expbkt3): in the fork the interaction mode does not carry
    // either: the saved Starting mode (project, then host) always wins, and
    // the model carries only when no default is saved.
    const carrySourceShell =
      currentRouteTarget?.kind === "server" ? readThreadShell(currentRouteTarget.threadRef) : null;
    const carrySourceComposer = currentRouteTarget
      ? getComposerDraft(
          currentRouteTarget.kind === "server"
            ? currentRouteTarget.threadRef
            : currentRouteTarget.draftId,
        )
      : null;
    const composerActiveProvider = carrySourceComposer?.activeProvider ?? null;
    const composerModelSelection = composerActiveProvider
      ? (carrySourceComposer?.modelSelectionByProvider[composerActiveProvider] ?? null)
      : null;
    const carryModelSelection = composerModelSelection ?? carrySourceShell?.modelSelection ?? null;
    const project = projects.find(
      (candidate) =>
        candidate.id === projectRef.projectId &&
        candidate.environmentId === projectRef.environmentId,
    );
    const abandonedSinceRequest = () =>
      routeChangedSinceRequest() || (project !== undefined && readProject(projectRef) === null);
    const projectSettings = resolveProjectSettings(
      targetServerSettings,
      project?.id ?? null,
      project,
    );
    const projectDefaultModelSelection = projectSettings.settings.defaultModelSelection;
    const defaultRuntimeMode = projectSettings.settings.defaultRuntimeMode;
    // T3-CUSTOM(expbkt3): the saved Starting mode (project override, then host)
    // seeds every new thread; Plan only while its toggle exists.
    const defaultInteractionMode = planModeAvailable
      ? projectSettings.settings.defaultThreadInteractionMode
      : DEFAULT_PROVIDER_INTERACTION_MODE;
    const resolveModelSelectionOverride = (destinationDraftId: DraftId) =>
      resolveNewThreadModelSelectionOverride({
        projectDefaultSelection: projectDefaultModelSelection ?? null,
        carrySelection: carryModelSelection,
        carrySourceDraftId:
          currentRouteTarget?.kind === "draft" ? currentRouteTarget.draftId : null,
        destinationDraftId,
      });
    const resolveDefaultEnvMode = async (): Promise<DraftThreadEnvMode> => {
      const consultProjectFile =
        project !== undefined && projectSettings.settings.defaultThreadEnvMode === null;
      const projectFile = consultProjectFile
        ? await readT3ProjectFile(project.environmentId, project.workspaceRoot)
        : null;
      return resolveNewThreadEnvMode({
        projectSettings: resolveProjectSettings(
          targetServerSettings,
          project?.id ?? null,
          project,
          projectFile,
        ),
        workspaceRoot: project?.workspaceRoot ?? null,
        newProjectsRoot: environmentServerConfigs.get(projectRef.environmentId)?.newProjectsRoot,
        projectHasThreads: readThreadShells().some(
          (thread) =>
            thread.environmentId === projectRef.environmentId &&
            thread.projectId === projectRef.projectId,
        ),
      });
    };
    const logicalProjectKey = project
      ? deriveLogicalProjectKeyFromSettings(project, projectGroupingSettings)
      : scopedProjectKey(projectRef);
    const hasBranchOption = options?.branch !== undefined;
    const hasWorktreePathOption = options?.worktreePath !== undefined;
    const hasEnvModeOption = options?.envMode !== undefined;
    const hasStartFromOriginOption = options?.startFromOrigin !== undefined;
    const hasParentThreadIdOption = options?.parentThreadId !== undefined; // T3-CUSTOM(expbkt3)
    const storedDraftThread = getDraftSessionByLogicalProjectKey(logicalProjectKey);
    const storedDraftThreadRef = storedDraftThread
      ? scopeThreadRef(storedDraftThread.environmentId, storedDraftThread.threadId)
      : null;
    const reusableStoredDraftThread =
      storedDraftThread !== null &&
      storedDraftThread.promotedTo == null &&
      storedDraftThreadRef !== null &&
      readThreadShell(storedDraftThreadRef) === null
        ? storedDraftThread
        : null;
    if (storedDraftThreadRef && reusableStoredDraftThread === null) {
      markPromotedDraftThreadByRef(storedDraftThreadRef);
    }
    const emptyStoredDraftThread =
      reusableStoredDraftThread &&
      !composerDraftHasUserContent(getComposerDraft(reusableStoredDraftThread.draftId))
        ? reusableStoredDraftThread
        : null;
    const latestActiveDraftThread: DraftThreadState | null = currentRouteTarget
      ? currentRouteTarget.kind === "server"
        ? getDraftThread(currentRouteTarget.threadRef)
        : getDraftSession(currentRouteTarget.draftId)
      : null;
    if (emptyStoredDraftThread) {
      return (async () => {
        const isDraftAlreadyOpen =
          currentRouteTarget?.kind === "draft" &&
          currentRouteTarget.draftId === emptyStoredDraftThread.draftId;
        // T3-CUSTOM(expbkt3): BEGIN — an explicit parent thread is also a workspace option.
        const hasExplicitWorkspaceOption =
          hasBranchOption ||
          hasWorktreePathOption ||
          hasEnvModeOption ||
          hasStartFromOriginOption ||
          hasParentThreadIdOption;
        // T3-CUSTOM(expbkt3): END
        let workspaceContext: NewThreadWorkspaceOptions | null = null;
        if (hasExplicitWorkspaceOption) {
          // T3-CUSTOM(expbkt3): carry parent-thread lineage into the resurrected draft's context.
          workspaceContext = {
            ...pickExplicitWorkspaceOptions(options),
            // T3-CUSTOM(expbkt3): always written alongside explicit options
            // so a resurrected draft never keeps a stale parent from a
            // previous seeding.
            parentThreadId: options?.parentThreadId ?? null,
            parentEnvironmentId: options?.parentEnvironmentId ?? null,
          };
        } else if (!isDraftAlreadyOpen) {
          const defaultEnvMode = await resolveDefaultEnvMode();
          if (abandonedSinceRequest()) {
            return null;
          }
          // If the draft was opened (a concurrent invocation's navigation
          // landed), promoted to a real thread, remapped away (a concurrent
          // invocation registered a fresh draft — remapping back would evict
          // the winner and let the store GC it), or gained content (no longer
          // a reusable empty draft) in the meantime, this invocation is a
          // stale loser: resetting context, remapping, or navigating would
          // all clobber state written after the snapshot above.
          const routeTargetNow = getCurrentRouteTarget();
          const openedMeanwhile =
            routeTargetNow?.kind === "draft" &&
            routeTargetNow.draftId === emptyStoredDraftThread.draftId;
          const promotedMeanwhile =
            storedDraftThreadRef !== null && readThreadShell(storedDraftThreadRef) !== null;
          const remappedMeanwhile =
            getDraftSessionByLogicalProjectKey(logicalProjectKey)?.draftId !==
            emptyStoredDraftThread.draftId;
          const investedMeanwhile = composerDraftHasUserContent(
            getComposerDraft(emptyStoredDraftThread.draftId),
          );
          if (openedMeanwhile || promotedMeanwhile || remappedMeanwhile || investedMeanwhile) {
            return null;
          }
          workspaceContext = {
            branch: null,
            worktreePath: null,
            envMode: defaultEnvMode,
            startFromOrigin: resolveNewDraftStartFromOrigin({
              envMode: defaultEnvMode,
              newWorktreesStartFromOrigin: projectSettings.settings.newWorktreesStartFromOrigin,
            }),
            parentThreadId: null, // T3-CUSTOM(expbkt3)
          };
        }
        if (workspaceContext) {
          setDraftThreadContext(emptyStoredDraftThread.draftId, {
            ...workspaceContext,
            // T3-CUSTOM(expbkt3): saved defaults, not the stale draft's modes.
            runtimeMode: defaultRuntimeMode,
            interactionMode: defaultInteractionMode,
          });
        }
        // T3-CUSTOM(expbkt3): BEGIN — a reused empty draft is a new thread:
        // its composer-level permission and plan toggles from the previous
        // visit are cleared so the saved defaults show and send.
        setRuntimeMode(emptyStoredDraftThread.draftId, null);
        setInteractionMode(emptyStoredDraftThread.draftId, null);
        // T3-CUSTOM(expbkt3): END
        const storedDraft = getComposerDraft(emptyStoredDraftThread.draftId);
        const storedDraftHasExplicitModelPick = hasExplicitComposerModelSelection(storedDraft);
        // T3-CUSTOM(expbkt3): a saved default model outranks an explicit pick
        // left in an empty draft; without one, the explicit pick stands.
        if (!storedDraftHasExplicitModelPick || projectDefaultModelSelection !== null) {
          applyStickyState(emptyStoredDraftThread.draftId);
          const modelSelectionOverride = resolveModelSelectionOverride(
            emptyStoredDraftThread.draftId,
          );
          if (modelSelectionOverride) {
            setModelSelection(emptyStoredDraftThread.draftId, modelSelectionOverride, {
              replaceOptions: true,
            });
          }
        }
        // The workspace context must also ride along here: when projectRef
        // targets a different physical member of the logical project,
        // createDraftThreadState treats the remap as a project change and
        // would otherwise wipe branch/worktree, undoing the write above.
        setLogicalProjectDraftThreadId(
          logicalProjectKey,
          projectRef,
          emptyStoredDraftThread.draftId,
          {
            threadId: emptyStoredDraftThread.threadId,
            ...workspaceContext,
            // T3-CUSTOM(expbkt3): saved defaults, not the stale draft's modes.
            runtimeMode: defaultRuntimeMode,
            interactionMode: defaultInteractionMode,
          },
        );
        const opened = {
          draftId: emptyStoredDraftThread.draftId,
          threadId: emptyStoredDraftThread.threadId,
        };
        const routeTargetAfterWrites = getCurrentRouteTarget();
        if (
          routeTargetAfterWrites?.kind === "draft" &&
          routeTargetAfterWrites.draftId === emptyStoredDraftThread.draftId
        ) {
          return opened;
        }
        await router.navigate({
          to: "/draft/$draftId",
          params: { draftId: emptyStoredDraftThread.draftId },
          replace: options?.replace ?? false,
        });
        return opened;
      })();
    }

    if (
      latestActiveDraftThread &&
      currentRouteTarget?.kind === "draft" &&
      latestActiveDraftThread.logicalProjectKey === logicalProjectKey &&
      latestActiveDraftThread.promotedTo == null &&
      !composerDraftHasUserContent(getComposerDraft(currentRouteTarget.draftId))
    ) {
      if (
        hasBranchOption ||
        hasWorktreePathOption ||
        hasEnvModeOption ||
        hasStartFromOriginOption || // T3-CUSTOM(expbkt3): joins the parent-thread check below.
        hasParentThreadIdOption // T3-CUSTOM(expbkt3)
      ) {
        setDraftThreadContext(currentRouteTarget.draftId, pickExplicitWorkspaceOptions(options));
      }
      setLogicalProjectDraftThreadId(logicalProjectKey, projectRef, currentRouteTarget.draftId, {
        threadId: latestActiveDraftThread.threadId,
        createdAt: latestActiveDraftThread.createdAt,
        // T3-CUSTOM(expbkt3): saved defaults, not the open draft's modes.
        runtimeMode: defaultRuntimeMode,
        interactionMode: defaultInteractionMode,
        ...pickExplicitWorkspaceOptions(options),
      });
      // T3-CUSTOM(expbkt3): BEGIN — same reset as the stored-draft path: the
      // composer's mode toggles and model pick give way to the saved defaults.
      setRuntimeMode(currentRouteTarget.draftId, null);
      setInteractionMode(currentRouteTarget.draftId, null);
      if (projectDefaultModelSelection !== null) {
        setModelSelection(currentRouteTarget.draftId, projectDefaultModelSelection, {
          replaceOptions: true,
        });
      }
      // T3-CUSTOM(expbkt3): END
      return Promise.resolve({
        draftId: currentRouteTarget.draftId,
        threadId: latestActiveDraftThread.threadId,
      });
    }

    const draftId = newDraftId();
    const threadId = newThreadId();
    const createdAt = new Date().toISOString();
    return (async () => {
      const initialEnvMode = options?.envMode ?? (await resolveDefaultEnvMode());
      if (abandonedSinceRequest()) {
        return null;
      }
      // The await yields, so a concurrent invocation may have registered a
      // draft for this logical project in the meantime. Registering ours
      // too would evict that draft while its navigation is in flight —
      // reuse the winner instead, like the synchronous path above does.
      const racedDraft = getDraftSessionByLogicalProjectKey(logicalProjectKey);
      if (
        racedDraft &&
        racedDraft.draftId !== storedDraftThread?.draftId &&
        readThreadShell(scopeThreadRef(racedDraft.environmentId, racedDraft.threadId)) === null
      ) {
        setLogicalProjectDraftThreadId(logicalProjectKey, projectRef, racedDraft.draftId, {
          threadId: racedDraft.threadId,
          createdAt: racedDraft.createdAt,
          runtimeMode: racedDraft.runtimeMode,
          interactionMode: racedDraft.interactionMode,
          ...pickExplicitWorkspaceOptions(options),
        });
        await router.navigate({
          to: "/draft/$draftId",
          params: { draftId: racedDraft.draftId },
          replace: options?.replace ?? false,
        });
        return { draftId: racedDraft.draftId, threadId: racedDraft.threadId };
      }
      setLogicalProjectDraftThreadId(logicalProjectKey, projectRef, draftId, {
        threadId,
        createdAt,
        branch: options?.branch ?? null,
        // T3-CUSTOM(expbkt3): session lineage for the eventual thread.
        parentThreadId: options?.parentThreadId ?? null,
        parentEnvironmentId: options?.parentEnvironmentId ?? null,
        worktreePath: options?.worktreePath ?? null,
        envMode: initialEnvMode,
        startFromOrigin:
          options?.startFromOrigin ??
          resolveNewDraftStartFromOrigin({
            envMode: initialEnvMode,
            newWorktreesStartFromOrigin: projectSettings.settings.newWorktreesStartFromOrigin,
          }),
        runtimeMode: defaultRuntimeMode,
        interactionMode: defaultInteractionMode, // T3-CUSTOM(expbkt3): the saved Starting mode.
      });
      applyStickyState(draftId);
      const modelSelectionOverride = resolveModelSelectionOverride(draftId);
      if (modelSelectionOverride) {
        setModelSelection(draftId, modelSelectionOverride, { replaceOptions: true });
      }
      await router.navigate({
        to: "/draft/$draftId",
        params: { draftId },
        replace: options?.replace ?? false,
      });
      return { draftId, threadId };
    })();
  };
}

export function useHandleNewThread() {
  const projectOrder = useUiStateStore((store) => store.projectOrder);
  const routeTarget = useThreadRouteTarget();
  const routeThreadRef = routeTarget?.kind === "server" ? routeTarget.threadRef : null;
  const routeDraftId = routeTarget?.kind === "draft" ? routeTarget.draftId : null;
  const activeThread = useQuietThreadShell(routeThreadRef);
  const getDraftThread = useComposerDraftStore((store) => store.getDraftThread);
  const activeDraftThread = useComposerDraftStore(() =>
    routeTarget
      ? routeTarget.kind === "server"
        ? getDraftThread(routeTarget.threadRef)
        : useComposerDraftStore.getState().getDraftSession(routeTarget.draftId)
      : null,
  );
  const projects = useProjects();
  const handleNewThread = useNewThreadHandler();
  const [defaultProject] = orderItemsByPreferredIds({
    items: projects,
    preferredIds: projectOrder,
    getId: getProjectOrderKey,
    getPreferenceIds: (project) => [
      getProjectOrderKey(project),
      legacyProjectCwdPreferenceKey(project.workspaceRoot),
    ],
  });
  const defaultProjectRef = defaultProject
    ? scopeProjectRef(defaultProject.environmentId, defaultProject.id)
    : null;

  return {
    activeDraftThread,
    activeThread,
    defaultProjectRef,
    handleNewThread,
    routeDraftId,
    routeThreadRef,
  };
}
