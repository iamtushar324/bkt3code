// T3-CUSTOM(expbkt3): the saved default always wins for a new thread.
//
// Fork-owned twin of upstream's useHandleNewThread.test.ts: the same mocked
// surroundings, with the stored draft reporting an explicit model pick (which a
// saved default must still outrank), a configurable route target for the
// empty-open-draft path, and the plan toggle's availability under test control.
import { describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => {
  let completeProjectFileRead: (value: null) => void = () => undefined;
  let projectFileRead = Promise.resolve<null>(null);
  const model = {
    instanceId: "claudeAgent",
    model: "claude-opus-5",
    options: [{ id: "effort", value: "max" }],
  };
  let targetSettings = {
    defaultThreadEnvMode: "local" as "local" | "worktree",
    newWorktreesStartFromOrigin: false,
    defaultModelSelection: null as null | typeof model,
    defaultRuntimeMode: "full-access" as "full-access" | "approval-required",
    defaultThreadInteractionMode: "default" as "default" | "plan",
  };
  let storedDraft: {
    readonly draftId: string;
    readonly environmentId: string;
    readonly promotedTo: null;
    readonly threadId: string;
  } | null = null;
  let openDraft: {
    readonly draftId: string;
    readonly threadId: string;
    readonly createdAt: string;
    readonly logicalProjectKey: string;
    readonly promotedTo: null;
    readonly runtimeMode: string;
    readonly interactionMode: string;
  } | null = null;
  const router = {
    state: {
      location: { href: "/" },
      matches: [{ params: {} }],
    },
    navigate: vi.fn(async (request: { readonly params: { readonly draftId: string } }) => {
      router.state.location.href = `/draft/${request.params.draftId}`;
    }),
  };
  const draftStore = {
    getComposerDraft: vi.fn(() => ({})),
    getDraftSessionByLogicalProjectKey: vi.fn(() => storedDraft),
    getDraftSession: vi.fn(() => openDraft),
    getDraftThread: vi.fn(() => null),
    applyStickyState: vi.fn(),
    setDraftThreadContext: vi.fn(),
    setLogicalProjectDraftThreadId: vi.fn(),
    setModelSelection: vi.fn(),
    setRuntimeMode: vi.fn(),
    setInteractionMode: vi.fn(),
  };

  return {
    model,
    completeProjectFileRead: (value: null) => completeProjectFileRead(value),
    draftStore,
    planModeAvailable: true,
    get openDraft() {
      return openDraft;
    },
    get projectFileRead() {
      return projectFileRead;
    },
    get targetSettings() {
      return targetSettings;
    },
    reset(nextStoredDraft: typeof storedDraft, nextOpenDraft: typeof openDraft = null) {
      storedDraft = nextStoredDraft;
      openDraft = nextOpenDraft;
      targetSettings = {
        defaultThreadEnvMode: "local",
        newWorktreesStartFromOrigin: false,
        defaultModelSelection: null,
        defaultRuntimeMode: "full-access",
        defaultThreadInteractionMode: "default",
      };
      router.state.location.href = nextOpenDraft ? `/draft/${nextOpenDraft.draftId}` : "/";
      router.navigate.mockClear();
      for (const mock of Object.values(draftStore)) mock.mockClear();
      projectFileRead = new Promise<null>((resolve) => {
        completeProjectFileRead = resolve;
      });
    },
    router,
  };
});

vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => new Map([["environment-ssh", { settings: testState.targetSettings }]]),
}));
vi.mock("@t3tools/client-runtime/environment", () => ({
  scopedProjectKey: () => "remote-project",
  scopeProjectRef: (environmentId: string, projectId: string) => ({ environmentId, projectId }),
  scopeThreadRef: (environmentId: string, threadId: string) => ({ environmentId, threadId }),
}));
vi.mock("@t3tools/contracts", () => ({
  DEFAULT_PROVIDER_INTERACTION_MODE: "default",
  DEFAULT_RUNTIME_MODE: "default",
  DEFAULT_SERVER_SETTINGS: {},
}));
vi.mock("@t3tools/shared/projectSettings", () => ({
  // Environment settings pass through, like upstream's test; the override
  // precedence is covered by the shared resolver's own tests.
  resolveProjectSettings: (
    settings: Record<string, unknown>,
    _projectId: unknown,
    _project: unknown,
    projectFile?: { defaultThreadEnvMode?: "local" | "worktree" } | null,
  ) => ({
    settings:
      projectFile === undefined
        ? settings
        : {
            ...settings,
            defaultThreadEnvMode:
              settings.defaultThreadEnvMode ?? projectFile?.defaultThreadEnvMode ?? "local",
          },
    sources: {},
    overrides: {},
  }),
}));
vi.mock("@tanstack/react-router", () => ({
  useParams: () => null,
  useRouter: () => testState.router,
}));
vi.mock("react", () => ({
  useCallback: <T>(callback: T) => callback,
  useMemo: <T>(factory: () => T) => factory(),
}));
vi.mock("../components/Sidebar.logic", () => ({ orderItemsByPreferredIds: () => [] }));
vi.mock("../composerDraftStore", () => {
  const useComposerDraftStore = Object.assign(() => null, {
    getState: () => testState.draftStore,
  });
  return {
    composerDraftHasUserContent: () => false,
    markPromotedDraftThreadByRef: vi.fn(),
    useComposerDraftStore,
  };
});
vi.mock("../lib/chatThreadActions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/chatThreadActions")>()),
  // The stored draft always reports an explicit pick; the override resolver stays real.
  hasExplicitComposerModelSelection: () => true,
}));
vi.mock("../lib/t3ProjectFileDefaults", () => ({
  readT3ProjectFile: () => testState.projectFileRead,
}));
vi.mock("../lib/utils", () => ({
  newDraftId: () => "draft-fresh",
  newThreadId: () => "thread-fresh",
}));
vi.mock("../logicalProject", () => ({
  deriveLogicalProjectKeyFromSettings: () => "remote-project",
  getProjectOrderKey: () => "remote-project",
  selectProjectGroupingSettings: () => ({}),
}));
vi.mock("../state/entities", () => ({
  readProjects: () => [
    {
      id: "project-remote",
      environmentId: "environment-ssh",
      workspaceRoot: "/remote/project",
      defaultThreadEnvMode: null,
      defaultModelSelection: null,
    },
  ],
  readThreadShell: () => null,
  useProjects: () => [],
  useThread: () => null,
}));
vi.mock("../state/server", () => ({
  environmentServerConfigsAtom: {},
  primaryServerSettingsAtom: "primary-settings",
}));
vi.mock("../threadRoutes", () => ({
  resolveThreadRouteTarget: () =>
    testState.openDraft ? { kind: "draft", draftId: testState.openDraft.draftId } : null,
}));
vi.mock("../uiStateStore", () => ({
  legacyProjectCwdPreferenceKey: () => "remote-project",
  useUiStateStore: () => [],
}));
vi.mock("./useSettings", () => ({
  useClientSettings: (selector?: (settings: Record<string, unknown>) => unknown) =>
    selector ? selector({ planModeAvailable: testState.planModeAvailable }) : {},
}));

import { useNewThreadHandler } from "./useHandleNewThread";

const projectRef = { environmentId: "environment-ssh", projectId: "project-remote" } as never;
const storedDraft = {
  draftId: "draft-existing",
  environmentId: "environment-ssh",
  promotedTo: null,
  threadId: "thread-existing",
};

async function open() {
  const pendingOpen = useNewThreadHandler()(projectRef);
  testState.completeProjectFileRead(null);
  return await pendingOpen;
}

describe.each([
  ["fresh", null],
  ["reused empty stored", storedDraft],
])("useNewThreadHandler saved defaults with a %s draft", (_, draft) => {
  it.each(["plan", "default"] as const)(
    "starts the new thread in the saved %s mode",
    async (interactionMode) => {
      testState.reset(draft);
      testState.planModeAvailable = true;
      testState.targetSettings.defaultThreadInteractionMode = interactionMode;
      const opened = await open();

      expect(testState.draftStore.setLogicalProjectDraftThreadId).toHaveBeenCalledWith(
        "remote-project",
        projectRef,
        opened!.draftId,
        expect.objectContaining({ interactionMode, runtimeMode: "full-access" }),
      );
    },
  );

  it("coerces a saved Plan default to Build while the plan toggle is hidden", async () => {
    testState.reset(draft);
    testState.planModeAvailable = false;
    testState.targetSettings.defaultThreadInteractionMode = "plan";
    const opened = await open();
    testState.planModeAvailable = true;

    expect(testState.draftStore.setLogicalProjectDraftThreadId).toHaveBeenCalledWith(
      "remote-project",
      projectRef,
      opened!.draftId,
      expect.objectContaining({ interactionMode: "default" }),
    );
  });

  it("applies the saved default model, options included, over the last pick", async () => {
    testState.reset(draft);
    testState.targetSettings.defaultModelSelection = testState.model;
    const opened = await open();

    // The draft reports an explicit pick (see the chatThreadActions mock); the
    // saved default still replaces it, as a complete snapshot.
    expect(testState.draftStore.setModelSelection).toHaveBeenCalledWith(
      opened!.draftId,
      testState.model,
      { replaceOptions: true },
    );
  });

  it("leaves an explicit pick alone when no default model is saved", async () => {
    testState.reset(draft);
    await open();
    expect(testState.draftStore.setModelSelection).not.toHaveBeenCalled();
  });

  it("clears a reused draft's composer mode overrides so the defaults show", async () => {
    testState.reset(draft);
    await open();

    if (draft) {
      expect(testState.draftStore.setRuntimeMode).toHaveBeenCalledWith(draft.draftId, null);
      expect(testState.draftStore.setInteractionMode).toHaveBeenCalledWith(draft.draftId, null);
    } else {
      expect(testState.draftStore.setRuntimeMode).not.toHaveBeenCalled();
      expect(testState.draftStore.setInteractionMode).not.toHaveBeenCalled();
    }
  });
});

describe("useNewThreadHandler on an empty draft already open for the project", () => {
  const openDraft = {
    draftId: "draft-open",
    threadId: "thread-open",
    createdAt: "2026-10-01T00:00:00.000Z",
    logicalProjectKey: "remote-project",
    promotedTo: null,
    runtimeMode: "approval-required",
    interactionMode: "plan",
  };

  it("resets the draft's modes and model to the saved defaults", async () => {
    testState.reset(null, openDraft);
    testState.targetSettings.defaultModelSelection = testState.model;
    testState.targetSettings.defaultRuntimeMode = "full-access";
    testState.targetSettings.defaultThreadInteractionMode = "default";
    const opened = await open();

    expect(opened).toEqual({ draftId: "draft-open", threadId: "thread-open" });
    // The open draft's own modes ("approval-required", "plan") are replaced.
    expect(testState.draftStore.setLogicalProjectDraftThreadId).toHaveBeenCalledWith(
      "remote-project",
      projectRef,
      "draft-open",
      expect.objectContaining({ runtimeMode: "full-access", interactionMode: "default" }),
    );
    expect(testState.draftStore.setRuntimeMode).toHaveBeenCalledWith("draft-open", null);
    expect(testState.draftStore.setInteractionMode).toHaveBeenCalledWith("draft-open", null);
    expect(testState.draftStore.setModelSelection).toHaveBeenCalledWith(
      "draft-open",
      testState.model,
      { replaceOptions: true },
    );
    expect(testState.router.navigate).not.toHaveBeenCalled();
  });

  it("keeps the model pick when no default model is saved", async () => {
    testState.reset(null, openDraft);
    await open();
    expect(testState.draftStore.setModelSelection).not.toHaveBeenCalled();
    expect(testState.draftStore.setRuntimeMode).toHaveBeenCalledWith("draft-open", null);
  });
});
