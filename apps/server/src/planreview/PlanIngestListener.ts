/**
 * T3-CUSTOM(expbkt3): captures agent plans as plan-review documents.
 *
 * Subscribes to `thread.proposed-plan-upserted` and turns every proposed plan
 * into a version. Plan ids are `plan:${threadId}:${turnId}`, so each revision
 * turn arrives as a new id — the service resolves lineage explicitly rather
 * than guessing, and redelivery of an id already captured is a no-op.
 */
import { ThreadId, type OrchestrationProposedPlan } from "@t3tools/contracts";
import { makeKeyedCoalescingWorker } from "@t3tools/shared/KeyedCoalescingWorker";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { derivePlanTitle, PlanReviewService } from "./PlanReviewService.ts";
import { withoutLegacyReviewMarker } from "./planFormat.ts";

export interface PlanIngestInput {
  readonly threadId: ThreadId;
  readonly proposedPlan: OrchestrationProposedPlan;
}

export class PlanIngestListener extends Context.Service<
  PlanIngestListener,
  {
    /** Captures one plan now. Exposed so tests can drive ingestion directly. */
    readonly ingest: (input: PlanIngestInput) => Effect.Effect<void>;
  }
>()("t3/planreview/PlanIngestListener") {}

/**
 * Reconciles plans that landed while the server was down. Reads only the newest
 * unimplemented plan per active thread rather than hydrating full history.
 */
export const reconcilePlansOnStartup = Effect.fn("PlanIngestListener.reconcileOnStartup")(
  function* (
    query: Pick<ProjectionSnapshotQuery["Service"], "listLatestProposedPlansForActiveThreads">,
    schedule: (input: PlanIngestInput) => Effect.Effect<void>,
  ) {
    const candidates = yield* query.listLatestProposedPlansForActiveThreads();
    yield* Effect.forEach(
      candidates,
      ({ threadId, proposedPlan }) => schedule({ threadId, proposedPlan }),
      { concurrency: 4, discard: true },
    );
  },
);

export const make = Effect.gen(function* () {
  const service = yield* PlanReviewService;
  const query = yield* ProjectionSnapshotQuery;
  const orchestrationEngine = yield* OrchestrationEngineService;

  const capture = (input: PlanIngestInput) =>
    Effect.gen(function* () {
      // An implemented plan is history; there is nothing left to review.
      if (input.proposedPlan.implementedAt !== null) return;

      const planMarkdown = withoutLegacyReviewMarker(input.proposedPlan.planMarkdown).trim();
      if (planMarkdown.length === 0) return;

      const threadOption = yield* query.getThreadDetailById(input.threadId);
      if (Option.isNone(threadOption)) return;

      yield* service.capturePlan({
        threadId: input.threadId,
        projectId: threadOption.value.projectId,
        planId: input.proposedPlan.id,
        planMarkdown,
        title: derivePlanTitle(planMarkdown),
        authorUserId: null,
      });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("could not capture a proposed plan for review", {
          threadId: input.threadId,
          planId: input.proposedPlan.id,
          cause: String(cause),
        }),
      ),
    );

  // Coalesce per plan so a burst of streaming-plan upserts captures once, with
  // the newest body winning.
  const worker = yield* makeKeyedCoalescingWorker<string, PlanIngestInput, never, never>({
    merge: (current, next) =>
      next.proposedPlan.updatedAt >= current.proposedPlan.updatedAt ? next : current,
    process: (_key, value) => capture(value),
  });

  const schedule = (input: PlanIngestInput) =>
    worker.enqueue(`${input.threadId}:${input.proposedPlan.id}`, input);

  // Subscribe before reconciling so a plan emitted during startup cannot fall
  // into the gap between the two operations.
  yield* Effect.forkScoped(
    Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) =>
      event.type === "thread.proposed-plan-upserted"
        ? schedule({
            threadId: event.payload.threadId,
            proposedPlan: event.payload.proposedPlan,
          })
        : Effect.void,
    ),
  );

  yield* reconcilePlansOnStartup(query, schedule).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("could not reconcile proposed plans for review", { cause: String(cause) }),
    ),
  );

  return PlanIngestListener.of({ ingest: capture });
});

export const layer = Layer.effect(PlanIngestListener, make);
