// T3-CUSTOM(expbkt3): observable draft lifecycle and persisted group behavior.
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import {
  scopedProjectKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import { derivePhaseSidebarRepositoryKey } from "@t3tools/client-runtime/state/phase-sidebar";
import {
  DEFAULT_PHASE_SIDEBAR_GROUPING,
  prunePhaseSidebarGrouping,
  sanitizePhaseSidebarGrouping,
  togglePhaseSidebarSectionCollapsed,
} from "@t3tools/client-runtime/state/phase-sidebar-grouping";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  DraftId,
  useComposerDraftStore,
  type ComposerImageAttachment,
  type ComposerThreadDraftState,
  type DraftSessionState,
} from "../../composerDraftStore";
import {
  PHASE_SIDEBAR_GROUPING_STORAGE_KEY,
  usePhaseSidebarGroupingStore,
} from "../../phaseSidebarGroupingStore";
import { useThreadSelectionStore } from "../../threadSelectionStore";
import type { Project } from "../../types";
import {
  capturePhaseSidebarDraft,
  PHASE_SIDEBAR_DRAFTS_SECTION_KEY,
  phaseSidebarDraftPreview,
  selectPhaseSidebarDrafts,
  type PhaseSidebarDraftScope,
  type PhaseSidebarDraftSource,
} from "./PhaseSidebarDrafts.logic";
import { PhaseSidebarDraftsGroup, usePhaseSidebarDraftCount } from "./PhaseSidebarDraftsGroup";

const mocks = vi.hoisted(() => ({ navigate: vi.fn(), closeMobile: vi.fn(), release: vi.fn() }));
vi.mock("@tanstack/react-router", () => ({ useRouter: () => ({ navigate: mocks.navigate }) }));
vi.mock("../ui/sidebar", () => ({
  useSidebar: () => ({ isMobile: true, setOpenMobile: mocks.closeMobile }),
}));
vi.mock("../ProjectFavicon", () => ({ ProjectFavicon: () => null }));
vi.mock("../../lib/attachmentUploadQueue", () => ({ releaseDraftAttachments: mocks.release }));

const environment = EnvironmentId.make("local");
const remoteEnvironment = EnvironmentId.make("remote");
const projectId = ProjectId.make("project");
function project(environmentId = environment, id = projectId): Project {
  return {
    environmentId,
    id,
    title: "Beknown",
    workspaceRoot: `/repos/${environmentId}/${id}`,
    repositoryIdentity: null,
    faviconPath: null,
  } as Project;
}
const localProject = project();
const remoteProject = project(remoteEnvironment);
const projectByKey = new Map(
  [localProject, remoteProject].map((value) => [
    scopedProjectKey(scopeProjectRef(value.environmentId, value.id)),
    value,
  ]),
);
const allScope: PhaseSidebarDraftScope = { projectByKey, repositoryKeys: [], routeDraftId: null };

function composer(
  prompt = "",
  overrides: Partial<ComposerThreadDraftState> = {},
): ComposerThreadDraftState {
  return {
    prompt,
    images: [],
    files: [],
    nonPersistedImageIds: [],
    persistedAttachments: [],
    terminalContexts: [],
    previewAnnotations: [],
    reviewComments: [],
    threadContexts: [],
    modelSelectionByProvider: {},
    activeProvider: null,
    runtimeMode: null,
    interactionMode: null,
    ...overrides,
  };
}
function session(id: string, overrides: Partial<DraftSessionState> = {}): DraftSessionState {
  return {
    threadId: ThreadId.make(`thread-${id}`),
    environmentId: environment,
    projectId,
    logicalProjectKey: "beknown",
    createdAt: "2026-10-03T10:00:00.000Z",
    runtimeMode: "full-access",
    interactionMode: "plan",
    branch: "feature/draft",
    worktreePath: "/worktrees/draft",
    envMode: "worktree",
    startFromOrigin: false,
    ...overrides,
  };
}
function source(
  entries: ReadonlyArray<readonly [string, DraftSessionState, ComposerThreadDraftState]>,
): PhaseSidebarDraftSource {
  return {
    draftThreadsByThreadKey: Object.fromEntries(entries.map(([id, value]) => [id, value])),
    draftsByThreadKey: Object.fromEntries(entries.map(([id, , value]) => [id, value])),
  };
}
const emptyFrozen = { routeDraftId: null, row: null };

describe("unstarted draft selection", () => {
  it("includes every invested unmapped session and excludes promoted, empty, and server-thread composers", () => {
    const value = source([
      ["prompt", session("prompt"), composer("Recover this work")],
      [
        "image",
        session("image"),
        composer("", {
          persistedAttachments: [
            {
              id: "image",
              name: "screen.png",
              mimeType: "image/png",
              sizeBytes: 3,
              dataUrl: "data:image/png;base64,YWJj",
            },
          ],
        }),
      ],
      ["empty", session("empty"), composer("   ", { interactionMode: "plan" })],
      [
        "promoted",
        session("promoted", { promotedTo: scopeThreadRef(environment, ThreadId.make("live")) }),
        composer("Already sent"),
      ],
    ]);
    const rows = selectPhaseSidebarDrafts(
      {
        ...value,
        draftsByThreadKey: {
          ...value.draftsByThreadKey,
          "local:server-thread": composer("Unsent text on a real thread"),
        },
      },
      allScope,
      emptyFrozen,
    );
    expect(rows.map((row) => row.draftId)).toEqual(["prompt", "image"]);
  });

  it("sorts by newest creation while preserving draft execution choices", () => {
    const old = session("old");
    const recent = session("recent", {
      createdAt: "2026-10-03T11:00:00.000Z",
      interactionMode: "default",
    });
    const rows = selectPhaseSidebarDrafts(
      source([
        ["old", old, composer("Old")],
        ["recent", recent, composer("New")],
      ]),
      allScope,
      emptyFrozen,
    );
    expect(rows.map((row) => row.draftId)).toEqual(["recent", "old"]);
    expect(rows[0]?.session).toBe(recent);
    expect(rows[1]?.session).toBe(old);
  });

  it("applies repository scope to the correct environment even when project IDs match", () => {
    const value = source([
      ["local", session("local"), composer("Local work")],
      ["remote", session("remote", { environmentId: remoteEnvironment }), composer("Remote work")],
    ]);
    const rows = selectPhaseSidebarDrafts(
      value,
      {
        ...allScope,
        repositoryKeys: [derivePhaseSidebarRepositoryKey(remoteProject)],
      },
      emptyFrozen,
    );
    expect(rows.map((row) => row.draftId)).toEqual(["remote"]);
    // No thread phase, provider runtime, or ownership record is needed for a draft.
    expect(
      selectPhaseSidebarDrafts(value, { ...allScope, projectByKey: new Map() }, emptyFrozen),
    ).toHaveLength(2);
  });

  it("freezes the active preview but still removes a promoted or discarded session", () => {
    const value = source([["active", session("active"), composer("Original preview")]]);
    const scope = { ...allScope, routeDraftId: "active" };
    const frozen = capturePhaseSidebarDraft(value, "active");
    const edited = { ...value, draftsByThreadKey: { active: composer("Per-keystroke edit") } };
    expect(selectPhaseSidebarDrafts(edited, scope, frozen)[0]?.composer.prompt).toBe(
      "Original preview",
    );
    const promoted = source([
      [
        "active",
        session("active", {
          promotedTo: scopeThreadRef(environment, ThreadId.make("live")),
        }),
        composer("Sent"),
      ],
    ]);
    expect(selectPhaseSidebarDrafts(promoted, scope, frozen)).toEqual([]);
    expect(selectPhaseSidebarDrafts(source([]), scope, frozen)).toEqual([]);
  });

  it("keeps a fresh active composer out until navigation leaves user content behind", () => {
    const initial = source([["active", session("active"), composer()]]);
    const frozen = capturePhaseSidebarDraft(initial, "active");
    const typed = source([["active", session("active"), composer("New work")]]);
    expect(
      selectPhaseSidebarDrafts(typed, { ...allScope, routeDraftId: "active" }, frozen),
    ).toEqual([]);
    expect(
      selectPhaseSidebarDrafts(typed, allScope, emptyFrozen).map((row) => row.draftId),
    ).toEqual(["active"]);
  });

  it("keeps the reserved collapse key through preference reload and live-thread pruning", () => {
    const closed = togglePhaseSidebarSectionCollapsed(
      DEFAULT_PHASE_SIDEBAR_GROUPING,
      PHASE_SIDEBAR_DRAFTS_SECTION_KEY,
    );
    const loaded = sanitizePhaseSidebarGrouping(JSON.parse(JSON.stringify(closed)));
    expect(prunePhaseSidebarGrouping(loaded, new Set()).collapsedSectionKeys).toContain(
      PHASE_SIDEBAR_DRAFTS_SECTION_KEY,
    );
    expect(
      togglePhaseSidebarSectionCollapsed(loaded, PHASE_SIDEBAR_DRAFTS_SECTION_KEY)
        .collapsedSectionKeys,
    ).toEqual([]);
  });

  it("uses the first prompt line or attachment count without double-counting saved images", () => {
    expect(phaseSidebarDraftPreview(composer("  First line\nSecond line"))).toBe("First line");
    expect(
      phaseSidebarDraftPreview(
        composer("", {
          persistedAttachments: [
            {
              id: "image",
              name: "screen.png",
              mimeType: "image/png",
              sizeBytes: 3,
              dataUrl: "data:image/png;base64,YWJj",
            },
          ],
        }),
      ),
    ).toBe("1 attachment");
  });
});

let renderer: ReactTestRenderer | null = null;
let parentRenderCount = 0;
function Host({ scope }: { readonly scope: PhaseSidebarDraftScope }) {
  parentRenderCount += 1;
  const count = usePhaseSidebarDraftCount(scope);
  return (
    <>
      <output data-testid="draft-count">{count}</output>
      <PhaseSidebarDraftsGroup {...scope} />
    </>
  );
}
function mount(scope = allScope) {
  act(() => {
    if (renderer) renderer.update(<Host scope={scope} />);
    else renderer = create(<Host scope={scope} />);
  });
}
function rows() {
  return renderer!.root.findAllByProps({ "data-testid": "phase-sidebar-draft-row" });
}
function count() {
  return renderer!.root.findByProps({ "data-testid": "draft-count" }).children[0];
}
function seed(value: PhaseSidebarDraftSource) {
  useComposerDraftStore.setState({
    draftThreadsByThreadKey: { ...value.draftThreadsByThreadKey },
    draftsByThreadKey: { ...value.draftsByThreadKey },
  });
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  mocks.navigate.mockReset();
  mocks.closeMobile.mockReset();
  mocks.release.mockReset();
  useComposerDraftStore.setState({
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
  });
  usePhaseSidebarGroupingStore.setState({ grouping: DEFAULT_PHASE_SIDEBAR_GROUPING });
  useThreadSelectionStore.getState().clearSelection();
  parentRenderCount = 0;
});
afterEach(() => {
  if (renderer) act(() => renderer!.unmount());
  renderer = null;
  usePhaseSidebarGroupingStore.persist.clearStorage();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Drafts group interactions", () => {
  it("hides the entire group when no eligible draft exists", () => {
    seed(
      source([
        ["empty", session("empty"), composer()],
        [
          "promoted",
          session("promoted", { promotedTo: scopeThreadRef(environment, ThreadId.make("live")) }),
          composer("Sent"),
        ],
      ]),
    );
    mount();
    expect(renderer!.root.findAllByProps({ "data-testid": "phase-sidebar-drafts" })).toHaveLength(
      0,
    );
    expect(count()).toBe("0");
  });

  it("starts expanded, persists collapse through reload, and retains the count while closed", async () => {
    seed(source([["saved", session("saved"), composer("Saved work")]]));
    mount();
    const toggle = () =>
      renderer!.root.findByProps({ "data-testid": "phase-sidebar-drafts-toggle" });
    expect(toggle().props["aria-expanded"]).toBe(true);
    expect(rows()).toHaveLength(1);
    act(() => toggle().props.onClick());
    expect(toggle().props["aria-expanded"]).toBe(false);
    expect(rows()).toHaveLength(0);
    expect(count()).toBe("1");
    act(() => useComposerDraftStore.getState().clearDraftThread(DraftId.make("saved")));
    expect(renderer!.root.findAllByProps({ "data-testid": "phase-sidebar-drafts" })).toHaveLength(
      0,
    );
    expect(count()).toBe("0");
    act(() =>
      seed(source([["replacement", session("replacement"), composer("Replacement draft")]])),
    );
    expect(toggle().props["aria-expanded"]).toBe(false);
    expect(rows()).toHaveLength(0);
    expect(count()).toBe("1");
    const storage = usePhaseSidebarGroupingStore.persist.getOptions().storage!;
    const saved = await storage.getItem(PHASE_SIDEBAR_GROUPING_STORAGE_KEY);
    expect(saved).toMatchObject({
      state: { grouping: { collapsedSectionKeys: [PHASE_SIDEBAR_DRAFTS_SECTION_KEY] } },
    });
    if (!saved) throw new Error("The collapse preference was not persisted");
    act(() => renderer!.unmount());
    renderer = null;
    usePhaseSidebarGroupingStore.setState({ grouping: DEFAULT_PHASE_SIDEBAR_GROUPING });
    await storage.setItem(PHASE_SIDEBAR_GROUPING_STORAGE_KEY, saved);
    await usePhaseSidebarGroupingStore.persist.rehydrate();
    mount();
    expect(toggle().props["aria-expanded"]).toBe(false);
    act(() => toggle().props.onClick());
    expect(rows()).toHaveLength(1);
  });

  it("holds the active preview without repainting the parent on prompt edits, then removes it on send", () => {
    seed(source([["active", session("active"), composer("Original preview")]]));
    mount({ ...allScope, routeDraftId: "active" });
    const rendersBeforeEdit = parentRenderCount;
    act(() => useComposerDraftStore.getState().setPrompt(DraftId.make("active"), "Edited preview"));
    expect(rows()[0]?.props["aria-label"]).toContain("Original preview");
    expect(rows()[0]?.props["aria-label"]).not.toContain("Edited preview");
    expect(parentRenderCount).toBe(rendersBeforeEdit);
    act(() => useComposerDraftStore.getState().markDraftThreadPromoting(DraftId.make("active")));
    expect(rows()).toHaveLength(0);
    expect(count()).toBe("0");
  });

  it("adds a fresh active draft only after the user leaves its composer", () => {
    seed(source([["fresh", session("fresh"), composer()]]));
    mount({ ...allScope, routeDraftId: "fresh" });
    act(() =>
      useComposerDraftStore.getState().setPrompt(DraftId.make("fresh"), "Retain this draft"),
    );
    expect(rows()).toHaveLength(0);
    expect(count()).toBe("0");
    mount();
    expect(rows()[0]?.props["aria-label"]).toContain("Retain this draft");
    expect(count()).toBe("1");
  });

  it("releases upload ownership before discard removes the row and its composer", () => {
    const image: ComposerImageAttachment = {
      id: "image",
      type: "image",
      name: "screen.png",
      mimeType: "image/png",
      sizeBytes: 3,
      previewUrl: "blob:draft",
      file: new File(["abc"], "screen.png", { type: "image/png" }),
    };
    seed(source([["discard", session("discard"), composer("", { images: [image] })]]));
    mount({ ...allScope, routeDraftId: "discard" });
    mocks.release.mockImplementation(() =>
      expect(
        useComposerDraftStore.getState().getDraftSession(DraftId.make("discard")),
      ).not.toBeNull(),
    );
    const event = { preventDefault: vi.fn(), stopPropagation: vi.fn() };
    act(() => rows()[0]!.findByProps({ "aria-label": "Discard draft" }).props.onClick(event));
    expect(mocks.release).toHaveBeenCalledWith([image]);
    expect(useComposerDraftStore.getState().getComposerDraft(DraftId.make("discard"))).toBeNull();
    expect(useComposerDraftStore.getState().getDraftSession(DraftId.make("discard"))).toBeNull();
    expect(count()).toBe("0");
    expect(rows()).toHaveLength(0);
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it.each(["Enter", " "])(
    "opens a saved draft with %s while preserving all execution choices",
    (key) => {
      const saved = session("open");
      seed(source([["open", saved, composer("Saved work")]]));
      useThreadSelectionStore.getState().toggleThread("local:other-thread");
      mount();
      act(() =>
        rows()[0]!.props.onKeyDown({
          key,
          target: { closest: () => null },
          preventDefault: vi.fn(),
        }),
      );
      expect(mocks.navigate).toHaveBeenCalledWith({
        to: "/draft/$draftId",
        params: { draftId: "open" },
      });
      expect(mocks.closeMobile).toHaveBeenCalledWith(false);
      expect(useThreadSelectionStore.getState().selectedThreadKeys.size).toBe(0);
      expect(useComposerDraftStore.getState().getDraftSession(DraftId.make("open"))).toBe(saved);
    },
  );
});
