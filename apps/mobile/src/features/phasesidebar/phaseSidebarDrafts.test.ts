// T3-CUSTOM(expbkt3): preserve stock mobile drafts in the experimental sidebar.
import {
  DEFAULT_PHASE_SIDEBAR_GROUPING,
  sanitizePhaseSidebarGrouping,
  setPhaseSidebarGroupBy,
  togglePhaseSidebarSectionCollapsed,
} from "@t3tools/client-runtime/state/phase-sidebar-grouping";
import { CommandId, EnvironmentId, MessageId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { scopedProjectKey } from "../../lib/scopedEntities";
import { buildPendingNewTasks } from "../../state/pending-new-tasks-model";
import type { ComposerDraft } from "../../state/use-composer-drafts";
import {
  buildPhaseSidebarDraftItems,
  PHASE_SIDEBAR_DRAFTS_SECTION_KEY,
  selectPhaseSidebarDrafts,
} from "./phaseSidebarDrafts";
import type { PhaseSidebarHostFilters } from "./phaseSidebarHostFilters";

const local = EnvironmentId.make("local");
const remote = EnvironmentId.make("remote");
const alpha = ProjectId.make("alpha");
const beta = ProjectId.make("beta");
const allScopes: PhaseSidebarHostFilters = {
  selectedEnvironmentId: null,
  selectedProjectKeys: null,
  searchQuery: "",
  matchedThreadKeys: new Set(),
};

function draft(
  text: string,
  createdAt: string,
  environmentId = local,
  projectId = alpha,
): ComposerDraft {
  return { text, attachments: [], project: { environmentId, projectId, createdAt } };
}

const tasks = buildPendingNewTasks({
  drafts: {
    "new-task:old": draft("Fix sidebar", "2026-10-03T09:00:00.000Z"),
    "new-task:new": draft("Write docs", "2026-10-03T10:00:00.000Z", local, beta),
    "new-task:remote": draft("Release", "2026-10-03T11:00:00.000Z", remote),
    "new-task:empty": draft("", "2026-10-03T12:00:00.000Z"),
    "local:started-thread": { text: "Existing thread follow-up", attachments: [] },
    "pending-task:queued": { text: "Queued task editor", attachments: [] },
  },
  queuedMessages: [
    {
      environmentId: local,
      threadId: ThreadId.make("queued-thread"),
      messageId: MessageId.make("queued-message"),
      commandId: CommandId.make("queued-command"),
      text: "Queued task",
      attachments: [],
      createdAt: "2026-10-03T13:00:00.000Z",
      creation: { projectId: alpha, workspaceMode: "local", branch: null, worktreePath: null },
    },
  ],
});

describe("selectPhaseSidebarDrafts", () => {
  it("keeps normal new-task drafts in order and excludes queued tasks and thread composers", () => {
    expect(selectPhaseSidebarDrafts(tasks, allScopes).map((item) => item.draftKey)).toEqual([
      "new-task:remote",
      "new-task:new",
      "new-task:old",
    ]);
  });

  it("applies the normal sidebar's environment and scoped-project filters", () => {
    const selected = selectPhaseSidebarDrafts(tasks, {
      ...allScopes,
      selectedEnvironmentId: local,
      selectedProjectKeys: new Set([scopedProjectKey(local, alpha)]),
    });
    expect(selected.map((item) => item.draftKey)).toEqual(["new-task:old"]);
    expect(
      selectPhaseSidebarDrafts(tasks, {
        ...allScopes,
        selectedEnvironmentId: remote,
        selectedProjectKeys: new Set([scopedProjectKey(local, alpha)]),
      }),
    ).toEqual([]);
  });

  it("searches draft titles without treating server message hits as draft matches", () => {
    expect(
      selectPhaseSidebarDrafts(tasks, { ...allScopes, searchQuery: "  DOCS  " }).map(
        (item) => item.draftKey,
      ),
    ).toEqual(["new-task:new"]);
    expect(
      selectPhaseSidebarDrafts(tasks, {
        ...allScopes,
        searchQuery: "unmatched",
        matchedThreadKeys: new Set(["draft-task:new-task:old"]),
      }),
    ).toEqual([]);
  });
});

describe("buildPhaseSidebarDraftItems", () => {
  const drafts = selectPhaseSidebarDrafts(tasks, allScopes);

  it("shows no empty section and expands drafts by default", () => {
    expect(buildPhaseSidebarDraftItems([], new Set())).toEqual([]);
    const items = buildPhaseSidebarDraftItems(drafts, new Set());
    expect(items[0]).toEqual({
      kind: "drafts-section",
      key: PHASE_SIDEBAR_DRAFTS_SECTION_KEY,
      count: 3,
      collapsed: false,
    });
    expect(items.slice(1).map((item) => item.key)).toEqual(drafts.map((item) => item.key));
  });

  it("remembers collapse after preference reload, mode changes, and an empty draft list", () => {
    const original = {
      ...DEFAULT_PHASE_SIDEBAR_GROUPING,
      collapsedSectionKeys: ["section:existing"],
    };
    const collapsed = togglePhaseSidebarSectionCollapsed(
      original,
      PHASE_SIDEBAR_DRAFTS_SECTION_KEY,
    );
    const reloaded = sanitizePhaseSidebarGrouping(JSON.parse(JSON.stringify(collapsed)));
    const regrouped = setPhaseSidebarGroupBy(reloaded, "project");
    expect(buildPhaseSidebarDraftItems([], new Set(regrouped.collapsedSectionKeys))).toEqual([]);
    expect(buildPhaseSidebarDraftItems(drafts, new Set(regrouped.collapsedSectionKeys))).toEqual([
      {
        kind: "drafts-section",
        key: PHASE_SIDEBAR_DRAFTS_SECTION_KEY,
        count: 3,
        collapsed: true,
      },
    ]);
    const expanded = togglePhaseSidebarSectionCollapsed(
      regrouped,
      PHASE_SIDEBAR_DRAFTS_SECTION_KEY,
    );
    expect(expanded.collapsedSectionKeys).toEqual(["section:existing"]);
    expect(
      buildPhaseSidebarDraftItems(drafts, new Set(expanded.collapsedSectionKeys)),
    ).toHaveLength(4);
  });
});
