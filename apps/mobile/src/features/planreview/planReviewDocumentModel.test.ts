// T3-CUSTOM(expbkt3): fork-owned coverage for the mobile plan-review model.
import { describe, expect, it } from "@effect/vitest";
import type {
  PlanReviewComment,
  PlanReviewDiscussion,
  PlanReviewSnapshotResult,
  PlanReviewVersion,
} from "@t3tools/contracts";

import {
  buildPlanReviewView,
  quotedTextForLineRange,
  resolveCurrentPlanVersion,
} from "./planReviewDocumentModel";

const PLAN = ["# Auth rewrite", "", "1. Add the migration", "2. Backfill the rows"].join("\n");

const version = (overrides: Partial<PlanReviewVersion> = {}): PlanReviewVersion =>
  ({
    versionId: "v1",
    documentId: "doc-1",
    revision: 1,
    authorKind: "agent",
    authorUserId: null,
    origin: "agent-proposed",
    contentMarkdown: PLAN,
    contentValueJson: null,
    summary: null,
    createdAt: "2026-08-31T00:00:00.000Z",
    ...overrides,
  }) as PlanReviewVersion;

const discussion = (overrides: Partial<PlanReviewDiscussion> = {}): PlanReviewDiscussion =>
  ({
    discussionId: "d-1",
    documentId: "doc-1",
    anchorVersionId: "v1",
    quotedText: "1. Add the migration",
    isResolved: false,
    resolvedByUserId: null,
    resolvedAt: null,
    createdByUserId: null,
    createdAt: "2026-08-31T00:00:00.000Z",
    ...overrides,
  }) as PlanReviewDiscussion;

const comment = (overrides: Partial<PlanReviewComment> = {}): PlanReviewComment =>
  ({
    commentId: "c-1",
    discussionId: "d-1",
    authorUserId: null,
    bodyMarkdown: "Split this.",
    isEdited: false,
    createdAt: "2026-08-31T00:00:00.000Z",
    updatedAt: "2026-08-31T00:00:00.000Z",
    ...overrides,
  }) as PlanReviewComment;

const snapshot = (overrides: Partial<PlanReviewSnapshotResult> = {}): PlanReviewSnapshotResult =>
  ({
    document: {
      documentId: "doc-1",
      threadId: "thread-1",
      projectId: "project-1",
      title: "Auth rewrite",
      currentRevision: 1,
      status: "open",
      format: "md",
      createdByUserId: null,
      createdAt: "2026-08-31T00:00:00.000Z",
      updatedAt: "2026-08-31T00:00:00.000Z",
    },
    versions: [version()],
    draft: null,
    discussions: [],
    comments: [],
    ...overrides,
  }) as PlanReviewSnapshotResult;

describe("resolveCurrentPlanVersion", () => {
  it("picks the revision the document names as current", () => {
    const resolved = resolveCurrentPlanVersion(
      snapshot({
        document: { ...snapshot().document, currentRevision: 2 },
        versions: [
          version({ versionId: "v1", revision: 1 }),
          version({ versionId: "v2", revision: 2 }),
        ],
      }),
    );
    expect(resolved?.versionId).toBe("v2");
  });

  it("falls back to the highest revision when the named one is missing", () => {
    const resolved = resolveCurrentPlanVersion(
      snapshot({
        document: { ...snapshot().document, currentRevision: 9 },
        versions: [
          version({ versionId: "v1", revision: 1 }),
          version({ versionId: "v2", revision: 2 }),
        ],
      }),
    );
    expect(resolved?.versionId).toBe("v2");
  });

  it("returns null when there are no versions at all", () => {
    expect(resolveCurrentPlanVersion(snapshot({ versions: [] }))).toBeNull();
  });
});

describe("buildPlanReviewView", () => {
  it("renders one row per markdown line", () => {
    const view = buildPlanReviewView(snapshot());
    expect(view.lines.map((line) => line.text)).toEqual([
      "# Auth rewrite",
      "",
      "1. Add the migration",
      "2. Backfill the rows",
    ]);
  });

  it("anchors a discussion to the line its quote matches", () => {
    const view = buildPlanReviewView(snapshot({ discussions: [discussion()] }));
    expect(view.threads[0]?.startIndex).toBe(2);
    expect(view.threads[0]?.endIndex).toBe(2);
    expect(view.lines[2]?.discussionIds).toEqual(["d-1"]);
    expect(view.lines[3]?.discussionIds).toEqual([]);
  });

  it("lists a discussion whose quote the agent has rewritten, without anchoring it", () => {
    const view = buildPlanReviewView(
      snapshot({ discussions: [discussion({ quotedText: "3. Something long gone" })] }),
    );
    expect(view.threads).toHaveLength(1);
    expect(view.threads[0]?.startIndex).toBeNull();
    expect(view.lines.every((line) => line.discussionIds.length === 0)).toBe(true);
  });

  it("does not decorate lines for a resolved discussion", () => {
    const view = buildPlanReviewView(snapshot({ discussions: [discussion({ isResolved: true })] }));
    expect(view.threads[0]?.startIndex).toBe(2);
    expect(view.lines[2]?.discussionIds).toEqual([]);
    expect(view.unresolvedCount).toBe(0);
  });

  it("groups comments under their discussion, oldest first", () => {
    const view = buildPlanReviewView(
      snapshot({
        discussions: [discussion()],
        comments: [
          comment({ commentId: "c-2", createdAt: "2026-08-31T02:00:00.000Z" }),
          comment({ commentId: "c-1", createdAt: "2026-08-31T01:00:00.000Z" }),
          comment({ commentId: "other", discussionId: "d-other" }),
        ],
      }),
    );
    expect(view.threads[0]?.comments.map((entry) => entry.commentId)).toEqual(["c-1", "c-2"]);
  });

  it("counts only unresolved discussions", () => {
    const view = buildPlanReviewView(
      snapshot({
        discussions: [
          discussion({ discussionId: "a" }),
          discussion({ discussionId: "b", isResolved: true }),
        ],
      }),
    );
    expect(view.unresolvedCount).toBe(1);
  });

  it("renders an empty plan rather than throwing when no version exists", () => {
    const view = buildPlanReviewView(snapshot({ versions: [] }));
    expect(view.currentVersion).toBeNull();
    expect(view.markdown).toBe("");
  });
});

describe("quotedTextForLineRange", () => {
  it("returns the selected source lines verbatim", () => {
    const view = buildPlanReviewView(snapshot());
    expect(quotedTextForLineRange(view.lines, 2, 3)).toBe(
      "1. Add the migration\n2. Backfill the rows",
    );
  });

  it("returns a single line for a single-line range", () => {
    const view = buildPlanReviewView(snapshot());
    expect(quotedTextForLineRange(view.lines, 0, 0)).toBe("# Auth rewrite");
  });
});
