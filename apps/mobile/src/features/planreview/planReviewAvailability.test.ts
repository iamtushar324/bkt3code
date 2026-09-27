// T3-CUSTOM(expbkt3): fork-owned coverage for the mobile plan-review gates.
//
// These live in a fork-owned file deliberately: after an upstream merge they are
// the proof that the mobile plan-review entry point survived conflict
// resolution.
import { describe, expect, it } from "@effect/vitest";
import type { ExecutionEnvironmentCapabilities, PlanReviewDocument } from "@t3tools/contracts";

import {
  environmentSupportsPlanReview,
  resolveOpenPlanReviewDocument,
  shouldOfferPlanReview,
} from "./planReviewAvailability";

const capabilities = (
  overrides: Partial<ExecutionEnvironmentCapabilities> = {},
): ExecutionEnvironmentCapabilities =>
  ({
    repositoryIdentity: false,
    planReview: true,
    ...overrides,
  }) as ExecutionEnvironmentCapabilities;

const document = (overrides: Partial<PlanReviewDocument> = {}): PlanReviewDocument =>
  ({
    documentId: "doc-1",
    threadId: "thread-1",
    projectId: "project-1",
    title: "Plan",
    currentRevision: 1,
    status: "open",
    format: "md",
    createdByUserId: null,
    createdAt: "2026-08-31T00:00:00.000Z",
    updatedAt: "2026-08-31T00:00:00.000Z",
    ...overrides,
  }) as PlanReviewDocument;

describe("environmentSupportsPlanReview", () => {
  it("requires the capability to be explicitly true", () => {
    expect(environmentSupportsPlanReview(capabilities())).toBe(true);
    expect(environmentSupportsPlanReview(capabilities({ planReview: false }))).toBe(false);
  });

  it("treats an upstream server, which omits the key entirely, as unsupported", () => {
    expect(environmentSupportsPlanReview(capabilities({ planReview: undefined }))).toBe(false);
    expect(environmentSupportsPlanReview(undefined)).toBe(false);
  });
});

describe("resolveOpenPlanReviewDocument", () => {
  it("returns null when there is nothing to review", () => {
    expect(resolveOpenPlanReviewDocument(null)).toBeNull();
    expect(resolveOpenPlanReviewDocument(undefined)).toBeNull();
    expect(resolveOpenPlanReviewDocument([])).toBeNull();
  });

  it("ignores documents whose decision has already been made", () => {
    const resolved = resolveOpenPlanReviewDocument([
      document({ documentId: "a", status: "approved" }),
      document({ documentId: "b", status: "changes-requested" }),
      document({ documentId: "c", status: "discarded" }),
    ]);
    expect(resolved).toBeNull();
  });

  it("picks the open document even when resolved ones are newer", () => {
    const resolved = resolveOpenPlanReviewDocument([
      document({ documentId: "old-open", updatedAt: "2026-08-01T00:00:00.000Z" }),
      document({
        documentId: "new-approved",
        status: "approved",
        updatedAt: "2026-08-30T00:00:00.000Z",
      }),
    ]);
    expect(resolved?.documentId).toBe("old-open");
  });

  it("takes the most recently updated when more than one is open", () => {
    const resolved = resolveOpenPlanReviewDocument([
      document({ documentId: "older", updatedAt: "2026-08-01T00:00:00.000Z" }),
      document({ documentId: "newer", updatedAt: "2026-08-30T00:00:00.000Z" }),
    ]);
    expect(resolved?.documentId).toBe("newer");
  });

  it("still returns an open document when its timestamp is unparseable", () => {
    const resolved = resolveOpenPlanReviewDocument([document({ updatedAt: "not-a-date" })]);
    expect(resolved?.documentId).toBe("doc-1");
  });
});

describe("shouldOfferPlanReview", () => {
  it("offers the CTA when every gate passes", () => {
    expect(
      shouldOfferPlanReview({
        capabilities: capabilities(),
        hasActionableProposedPlan: true,
        documents: [document()],
      }),
    ).toBe(true);
  });

  it("hides the CTA when the server cannot serve plan review", () => {
    expect(
      shouldOfferPlanReview({
        capabilities: capabilities({ planReview: undefined }),
        hasActionableProposedPlan: true,
        documents: [document()],
      }),
    ).toBe(false);
  });

  it("hides the CTA once the plan is no longer awaiting the user", () => {
    expect(
      shouldOfferPlanReview({
        capabilities: capabilities(),
        hasActionableProposedPlan: false,
        documents: [document()],
      }),
    ).toBe(false);
  });

  it("hides the CTA when ingest produced no open document", () => {
    expect(
      shouldOfferPlanReview({
        capabilities: capabilities(),
        hasActionableProposedPlan: true,
        documents: [document({ status: "approved" })],
      }),
    ).toBe(false);
  });
});
