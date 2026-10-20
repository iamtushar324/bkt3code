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
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { act, render, type Screen } from "../../../test/render";

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
// The group renders without the test router (`router: false`), so navigation is observed here.
vi.mock(import("@tanstack/react-router"), async (original) => ({
  ...(await original()),
  useRouter: (() => ({ navigate: mocks.navigate })) as never,
}));
vi.mock(import("../ui/sidebar"), async (original) => ({
  ...(await original()),
  useSidebar: (() => ({ isMobile: true, setOpenMobile: mocks.closeMobile })) as never,
}));
vi.mock(import("../ProjectFavicon"), async (original) => ({
  ...(await original()),
  ProjectFavicon: () => null,
}));
vi.mock(import("../../lib/attachmentUploadQueue"), async (original) => ({
  ...(await original()),
  releaseDraftAttachments: mocks.release,
}));

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

let screen: Screen | null = null;
// Counts the parent's commits from an effect with no dependencies, which runs after every
// render of it that React commits.
const onParentCommit = vi.fn();
function Host({
  scope,
  onCommit,
}: {
  readonly scope: PhaseSidebarDraftScope;
  readonly onCommit: () => void;
}) {
  useEffect(() => {
    onCommit();
  });
  const count = usePhaseSidebarDraftCount(scope);
  return (
    <>
      <output data-testid="draft-count">{count}</output>
      <PhaseSidebarDraftsGroup {...scope} />
    </>
  );
}
async function mount(scope = allScope) {
  const host = <Host scope={scope} onCommit={onParentCommit} />;
  if (screen) await screen.rerender(host);
  else screen = await render(host, { router: false });
}
async function unmount() {
  await screen?.[Symbol.asyncDispose]();
  screen = null;
}
function rows() {
  return [
    ...screen!.container.querySelectorAll<HTMLElement>('[data-testid="phase-sidebar-draft-row"]'),
  ];
}
function count() {
  return screen!.container.querySelector('[data-testid="draft-count"]')!.textContent;
}
function group() {
  return screen!.container.querySelectorAll('[data-testid="phase-sidebar-drafts"]');
}
function toggle() {
  return screen!.container.querySelector<HTMLElement>(
    '[data-testid="phase-sidebar-drafts-toggle"]',
  )!;
}
function seed(value: PhaseSidebarDraftSource) {
  useComposerDraftStore.setState({
    draftThreadsByThreadKey: { ...value.draftThreadsByThreadKey },
    draftsByThreadKey: { ...value.draftsByThreadKey },
  });
}
beforeEach(() => {
  // The composer store debounces its persistence on setTimeout.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
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
  onParentCommit.mockReset();
});
afterEach(async () => {
  await unmount();
  usePhaseSidebarGroupingStore.persist.clearStorage();
  vi.useRealTimers();
});

describe("Drafts group interactions", () => {
  it("hides the entire group when no eligible draft exists", async () => {
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
    await mount();
    expect(group()).toHaveLength(0);
    expect(count()).toBe("0");
  });

  it("starts expanded, persists collapse through reload, and retains the count while closed", async () => {
    seed(source([["saved", session("saved"), composer("Saved work")]]));
    await mount();
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect(rows()).toHaveLength(1);
    await userEvent.click(toggle());
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(rows()).toHaveLength(0);
    expect(count()).toBe("1");
    await act(() => useComposerDraftStore.getState().clearDraftThread(DraftId.make("saved")));
    expect(group()).toHaveLength(0);
    expect(count()).toBe("0");
    await act(() =>
      seed(source([["replacement", session("replacement"), composer("Replacement draft")]])),
    );
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(rows()).toHaveLength(0);
    expect(count()).toBe("1");
    const storage = usePhaseSidebarGroupingStore.persist.getOptions().storage!;
    const saved = await storage.getItem(PHASE_SIDEBAR_GROUPING_STORAGE_KEY);
    expect(saved).toMatchObject({
      state: { grouping: { collapsedSectionKeys: [PHASE_SIDEBAR_DRAFTS_SECTION_KEY] } },
    });
    if (!saved) throw new Error("The collapse preference was not persisted");
    await unmount();
    usePhaseSidebarGroupingStore.setState({ grouping: DEFAULT_PHASE_SIDEBAR_GROUPING });
    await storage.setItem(PHASE_SIDEBAR_GROUPING_STORAGE_KEY, saved);
    await usePhaseSidebarGroupingStore.persist.rehydrate();
    await mount();
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    await userEvent.click(toggle());
    expect(rows()).toHaveLength(1);
  });

  it("holds the active preview without repainting the parent on prompt edits, then removes it on send", async () => {
    seed(source([["active", session("active"), composer("Original preview")]]));
    await mount({ ...allScope, routeDraftId: "active" });
    const rendersBeforeEdit = onParentCommit.mock.calls.length;
    await act(() =>
      useComposerDraftStore.getState().setPrompt(DraftId.make("active"), "Edited preview"),
    );
    expect(rows()[0]?.getAttribute("aria-label")).toContain("Original preview");
    expect(rows()[0]?.getAttribute("aria-label")).not.toContain("Edited preview");
    expect(onParentCommit).toHaveBeenCalledTimes(rendersBeforeEdit);
    await act(() =>
      useComposerDraftStore.getState().markDraftThreadPromoting(DraftId.make("active")),
    );
    expect(rows()).toHaveLength(0);
    expect(count()).toBe("0");
  });

  it("adds a fresh active draft only after the user leaves its composer", async () => {
    seed(source([["fresh", session("fresh"), composer()]]));
    await mount({ ...allScope, routeDraftId: "fresh" });
    await act(() =>
      useComposerDraftStore.getState().setPrompt(DraftId.make("fresh"), "Retain this draft"),
    );
    expect(rows()).toHaveLength(0);
    expect(count()).toBe("0");
    await mount();
    expect(rows()[0]?.getAttribute("aria-label")).toContain("Retain this draft");
    expect(count()).toBe("1");
  });

  it("releases upload ownership before discard removes the row and its composer", async () => {
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
    await mount({ ...allScope, routeDraftId: "discard" });
    mocks.release.mockImplementation(() =>
      expect(
        useComposerDraftStore.getState().getDraftSession(DraftId.make("discard")),
      ).not.toBeNull(),
    );
    // A real click bubbles, so the row must not also open the draft it discards.
    await userEvent.click(rows()[0]!.querySelector('button[aria-label="Discard draft"]')!);
    expect(mocks.release).toHaveBeenCalledWith([image]);
    expect(useComposerDraftStore.getState().getComposerDraft(DraftId.make("discard"))).toBeNull();
    expect(useComposerDraftStore.getState().getDraftSession(DraftId.make("discard"))).toBeNull();
    expect(count()).toBe("0");
    expect(rows()).toHaveLength(0);
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it.each(["Enter", " "])(
    "opens a saved draft with %s while preserving all execution choices",
    async (key) => {
      const saved = session("open");
      seed(source([["open", saved, composer("Saved work")]]));
      useThreadSelectionStore.getState().toggleThread("local:other-thread");
      await mount();
      const row = rows()[0]!;
      const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      await act(() => {
        row.dispatchEvent(event);
      });
      expect(event.defaultPrevented).toBe(true);
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
