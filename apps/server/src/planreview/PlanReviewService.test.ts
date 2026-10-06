/**
 * T3-CUSTOM(expbkt3): round-trip coverage for the native plan review service.
 *
 * The prompts are the product here — the whole point of the feature is that an
 * approval stops re-sending the plan and feedback carries anchors instead of a
 * document — so every test asserts the exact text handed to the agent.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId, UserId, type OrchestrationCommand } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import { OrchestrationEngineService } from "../orchestration-v2/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration-v2/Services/ProjectionSnapshotQuery.ts";
import { MigrationsLive } from "../persistence/Migrations.ts";
import { layerMemory as SqlitePersistenceMemory } from "../persistence/Sqlite.ts";
import * as PlanReviewDocuments from "../persistence/PlanReviewDocuments.ts";
import * as PlanReviewServiceModule from "./PlanReviewService.ts";
import { derivePlanTitle, PlanReviewService } from "./PlanReviewService.ts";

const threadId = ThreadId.make("thread-plan-review");
const otherThreadId = ThreadId.make("thread-other");
const reviewerId = UserId.make("user_reviewer");

const PLAN = [
  "# Auth rewrite",
  "",
  "## Steps",
  "",
  "1. Add the migration",
  "2. Backfill the rows",
  "3. Flip the flag",
].join("\n");

/** Who each dispatched command was attributed to, in dispatch order. */
interface CommandSender {
  readonly type: OrchestrationCommand["type"];
  readonly actorUserId: UserId | null;
}

interface ThreadStub {
  readonly sessionStatus: string | null;
  readonly compactionAt: string | null;
  /** Plans already on the thread, as the projection would report them. */
  readonly proposedPlans?: ReadonlyArray<{
    readonly id: string;
    readonly planMarkdown: string;
    readonly implementedAt: string | null;
    readonly updatedAt: string;
  }>;
}

/**
 * Captures dispatched commands so a test can assert what reached the thread,
 * and stubs the one projection read the service performs.
 */
const makeHarness = (thread: ThreadStub) =>
  Effect.gen(function* () {
    const dispatched = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
    const senders = yield* Ref.make<ReadonlyArray<CommandSender>>([]);

    const dispatcherLayer = Layer.mock(OrchestrationEngineService)({
      dispatch: (
        command: OrchestrationCommand,
        options?: { readonly actorUserId?: UserId | null },
      ) =>
        Ref.update(dispatched, (current) => [...current, command]).pipe(
          Effect.andThen(
            Ref.update(senders, (current) => [
              ...current,
              { type: command.type, actorUserId: options?.actorUserId ?? null },
            ]),
          ),
          Effect.as({ sequence: 1 }),
        ),
    });

    const queryLayer = Layer.succeed(
      ProjectionSnapshotQuery,
      ProjectionSnapshotQuery.of({
        getThreadDetailById: () =>
          Effect.succeed(
            Option.some({
              id: threadId,
              projectId: "project-1",
              modelSelection: undefined,
              runtimeMode: "local",
              proposedPlans: thread.proposedPlans ?? [],
              session: thread.sessionStatus === null ? null : { status: thread.sessionStatus },
              activities:
                thread.compactionAt === null
                  ? []
                  : [{ kind: "context-compaction", createdAt: thread.compactionAt }],
            } as never),
          ),
      } as never),
    );

    return { dispatched, senders, dispatcherLayer, queryLayer };
  });

const runWithService = <A, E>(
  thread: ThreadStub,
  body: (input: {
    readonly service: PlanReviewService["Service"];
    readonly dispatched: Ref.Ref<ReadonlyArray<OrchestrationCommand>>;
    readonly senders: Ref.Ref<ReadonlyArray<CommandSender>>;
  }) => Effect.Effect<A, E, never>,
) =>
  Effect.gen(function* () {
    const harness = yield* makeHarness(thread);
    const layer = PlanReviewServiceModule.layer.pipe(
      Layer.provide(PlanReviewDocuments.layer),
      Layer.provide(harness.dispatcherLayer),
      Layer.provide(harness.queryLayer),
      Layer.provide(MigrationsLive),
      Layer.provide(SqlitePersistenceMemory),
      Layer.provide(NodeServices.layer),
    );

    return yield* Effect.gen(function* () {
      const service = yield* PlanReviewService;
      return yield* body({ service, dispatched: harness.dispatched, senders: harness.senders });
    }).pipe(Effect.provide(layer));
  });

const capturePlan = (
  service: PlanReviewService["Service"],
  planId: string,
  markdown = PLAN,
  onThread: ThreadId = threadId,
) =>
  service.capturePlan({
    threadId: onThread,
    projectId: "project-1",
    planId: planId as never,
    planMarkdown: markdown,
    title: derivePlanTitle(markdown),
    authorUserId: null,
  });

/** The proposed-plan records a decision closed, as dispatched to the thread. */
const implementedPlans = (
  commands: ReadonlyArray<OrchestrationCommand>,
): ReadonlyArray<{ id: string; implementedAt: string | null; implementationThreadId: unknown }> =>
  commands.flatMap((command) =>
    command.type === "thread.proposed-plan.upsert" && command.proposedPlan.implementedAt !== null
      ? [
          {
            id: command.proposedPlan.id,
            implementedAt: command.proposedPlan.implementedAt,
            implementationThreadId: command.proposedPlan.implementationThreadId,
          },
        ]
      : [],
  );

const turnText = (commands: ReadonlyArray<OrchestrationCommand>): string => {
  const turn = commands.find((command) => command.type === "thread.turn.start");
  if (turn === undefined || turn.type !== "thread.turn.start") {
    throw new Error("no turn was started");
  }
  return turn.message.text;
};

describe("derivePlanTitle", () => {
  it("uses the first heading", () => {
    expect(derivePlanTitle(PLAN)).toBe("Auth rewrite");
  });

  it("falls back to the first non-empty line", () => {
    expect(derivePlanTitle("\n\nJust do the thing\n")).toBe("Just do the thing");
  });

  it("falls back to a constant for an empty plan", () => {
    expect(derivePlanTitle("   \n\n")).toBe("Plan");
  });
});

describe("PlanReviewService capture", () => {
  it.effect("captures the agent plan as version 1", () =>
    runWithService({ sessionStatus: "running", compactionAt: null }, ({ service }) =>
      Effect.gen(function* () {
        const document = yield* capturePlan(service, "plan:a");
        const snapshot = yield* service.getReview(document.documentId);

        expect(snapshot.versions).toHaveLength(1);
        expect(snapshot.versions[0]?.revision).toBe(1);
        expect(snapshot.versions[0]?.authorKind).toBe("agent");
        expect(snapshot.versions[0]?.origin).toBe("agent-proposed");
        expect(snapshot.document.title).toBe("Auth rewrite");
        expect(snapshot.document.status).toBe("open");
      }),
    ),
  );

  it.effect("treats a redelivered plan id as a no-op", () =>
    runWithService({ sessionStatus: "running", compactionAt: null }, ({ service }) =>
      Effect.gen(function* () {
        const document = yield* capturePlan(service, "plan:a");
        yield* capturePlan(service, "plan:a");
        const snapshot = yield* service.getReview(document.documentId);

        expect(snapshot.versions).toHaveLength(1);
      }),
    ),
  );

  it.effect("appends an agent revision to the same lineage", () =>
    runWithService({ sessionStatus: "running", compactionAt: null }, ({ service }) =>
      Effect.gen(function* () {
        const document = yield* capturePlan(service, "plan:a");
        yield* capturePlan(service, "plan:b", `${PLAN}\n4. Announce it`);
        const snapshot = yield* service.getReview(document.documentId);

        expect(snapshot.versions).toHaveLength(2);
        expect(snapshot.versions[1]?.origin).toBe("agent-revision");
        expect(snapshot.versions[1]?.revision).toBe(2);
        expect(snapshot.document.currentRevision).toBe(2);
      }),
    ),
  );

  it.effect("ignores a revision whose body did not change", () =>
    runWithService({ sessionStatus: "running", compactionAt: null }, ({ service }) =>
      Effect.gen(function* () {
        const document = yield* capturePlan(service, "plan:a");
        yield* capturePlan(service, "plan:b", PLAN);
        const snapshot = yield* service.getReview(document.documentId);

        expect(snapshot.versions).toHaveLength(1);
      }),
    ),
  );
});

describe("PlanReviewService HTML plans", () => {
  const HTML_PLAN = [
    "<html><head><title>Quarterly growth</title></head>",
    '<body><h1>Growth</h1><canvas id="chart"></canvas></body></html>',
  ].join("");

  it.effect("records the renderer and titles from the document", () =>
    runWithService({ sessionStatus: "running", compactionAt: null }, ({ service }) =>
      Effect.gen(function* () {
        const document = yield* capturePlan(service, "plan:html", HTML_PLAN);
        expect(document.format).toBe("html");
        expect(document.title).toBe("Quarterly growth");
      }),
    ),
  );

  it.effect("keeps a markdown plan on the markdown renderer", () =>
    runWithService({ sessionStatus: "running", compactionAt: null }, ({ service }) =>
      Effect.gen(function* () {
        const document = yield* capturePlan(service, "plan:md");
        expect(document.format).toBe("md");
      }),
    ),
  );

  it.effect("does not treat inline HTML in markdown as an HTML plan", () =>
    runWithService({ sessionStatus: "running", compactionAt: null }, ({ service }) =>
      Effect.gen(function* () {
        const document = yield* capturePlan(
          service,
          "plan:inline",
          `${PLAN}\n\nUse <div> for the wrapper.`,
        );
        expect(document.format).toBe("md");
      }),
    ),
  );
});

describe("PlanReviewService listForThread", () => {
  it.effect("captures a plan that startup reconciliation never reached", () =>
    runWithService(
      {
        sessionStatus: "running",
        compactionAt: null,
        proposedPlans: [
          {
            id: "plan:pre-existing",
            planMarkdown: PLAN,
            implementedAt: null,
            updatedAt: "2026-08-07T10:00:00.000Z",
          },
        ],
      },
      ({ service }) =>
        Effect.gen(function* () {
          // Nothing captured this plan, so without a backfill the UI would
          // offer no way into it.
          const documents = yield* service.listForThread(threadId);
          expect(documents).toHaveLength(1);
          expect(documents[0]?.status).toBe("open");
          expect(documents[0]?.title).toBe("Auth rewrite");

          // Idempotent: a second read must not create a second lineage.
          expect(yield* service.listForThread(threadId)).toHaveLength(1);
        }),
    ),
  );

  it.effect("ignores an already-implemented plan", () =>
    runWithService(
      {
        sessionStatus: "running",
        compactionAt: null,
        proposedPlans: [
          {
            id: "plan:done",
            planMarkdown: PLAN,
            implementedAt: "2026-08-07T11:00:00.000Z",
            updatedAt: "2026-08-07T10:00:00.000Z",
          },
        ],
      },
      ({ service }) =>
        Effect.gen(function* () {
          expect(yield* service.listForThread(threadId)).toHaveLength(0);
        }),
    ),
  );

  it.effect("does not backfill over a review that is already resolved", () =>
    runWithService(
      {
        sessionStatus: "running",
        compactionAt: null,
        proposedPlans: [
          {
            id: "plan:a",
            planMarkdown: PLAN,
            implementedAt: null,
            updatedAt: "2026-08-07T10:00:00.000Z",
          },
        ],
      },
      ({ service }) =>
        Effect.gen(function* () {
          const document = yield* capturePlan(service, "plan:a");
          yield* service.submit({
            documentId: document.documentId,
            decision: "approved",
            globalComment: "",
            editedMarkdown: null,
            actorUserId: reviewerId,
            actorLabel: "Tushar",
          });

          // The plan is approved; re-listing must not resurrect it as a new
          // open review.
          const documents = yield* service.listForThread(threadId);
          expect(documents).toHaveLength(1);
          expect(documents[0]?.status).toBe("approved");
        }),
    ),
  );
});

describe("PlanReviewService approval", () => {
  it.effect("sends a short ack instead of the plan body", () =>
    runWithService({ sessionStatus: "running", compactionAt: null }, ({ service, dispatched }) =>
      Effect.gen(function* () {
        const document = yield* capturePlan(service, "plan:a");
        const result = yield* service.submit({
          documentId: document.documentId,
          decision: "approved",
          globalComment: "",
          editedMarkdown: null,
          actorUserId: reviewerId,
          actorLabel: "Tushar",
        });

        expect(result.resentPlan).toBe(false);
        expect(result.prompt).toBe(
          "Plan approved. Implement the plan you proposed above, exactly as written.",
        );

        const commands = yield* Ref.get(dispatched);
        expect(turnText(commands)).not.toContain("Flip the flag");

        // Only approval may leave Plan mode.
        const modeCommand = commands.find(
          (command) => command.type === "thread.interaction-mode.set",
        );
        expect(modeCommand).toBeDefined();

        const turn = commands.find((command) => command.type === "thread.turn.start");
        expect(turn?.type === "thread.turn.start" && turn.interactionMode).toBe("default");
        expect(turn?.type === "thread.turn.start" && turn.sourceProposedPlan?.planId).toBe(
          "plan:a",
        );
      }),
    ),
  );

  it.effect("sends approval and feedback turns as the reviewer", () =>
    runWithService({ sessionStatus: "running", compactionAt: null }, ({ service, senders }) =>
      Effect.gen(function* () {
        // A sender-less turn resolves a different session identity than the
        // reviewer's own messages, and that restarts the provider process
        // right as the approval is delivered.
        const feedbackDocument = yield* capturePlan(service, "plan:a", PLAN, otherThreadId);
        yield* service.submit({
          documentId: feedbackDocument.documentId,
          decision: "changes-requested",
          globalComment: "Split step 2.",
          editedMarkdown: null,
          actorUserId: reviewerId,
          actorLabel: "Tushar",
        });
        const approvalDocument = yield* capturePlan(service, "plan:b");
        yield* service.submit({
          documentId: approvalDocument.documentId,
          decision: "approved",
          globalComment: "",
          editedMarkdown: null,
          actorUserId: reviewerId,
          actorLabel: "Tushar",
        });

        const turnSenders = (yield* Ref.get(senders)).filter(
          (sender) =>
            sender.type === "thread.turn.start" || sender.type === "thread.interaction-mode.set",
        );
        expect(turnSenders.map((sender) => sender.type)).toEqual([
          "thread.turn.start",
          "thread.interaction-mode.set",
          "thread.turn.start",
        ]);
        expect(turnSenders.every((sender) => sender.actorUserId === reviewerId)).toBe(true);
      }),
    ),
  );

  it.effect("re-sends the plan when the thread compacted after it", () =>
    runWithService(
      { sessionStatus: "running", compactionAt: "2099-01-01T00:00:00.000Z" },
      ({ service, dispatched }) =>
        Effect.gen(function* () {
          const document = yield* capturePlan(service, "plan:a");
          const result = yield* service.submit({
            documentId: document.documentId,
            decision: "approved",
            globalComment: "",
            editedMarkdown: null,
            actorUserId: reviewerId,
            actorLabel: "Tushar",
          });

          expect(result.resentPlan).toBe(true);
          const text = turnText(yield* Ref.get(dispatched));
          expect(text).toContain("PLEASE IMPLEMENT THIS APPROVED PLAN:");
          expect(text).toContain("3. Flip the flag");
          expect(text).toContain("compacted its context");
        }),
    ),
  );

  it.effect("re-sends the plan when no provider session is bound", () =>
    runWithService({ sessionStatus: null, compactionAt: null }, ({ service }) =>
      Effect.gen(function* () {
        const document = yield* capturePlan(service, "plan:a");
        const result = yield* service.submit({
          documentId: document.documentId,
          decision: "approved",
          globalComment: "",
          editedMarkdown: null,
          actorUserId: reviewerId,
          actorLabel: "Tushar",
        });

        expect(result.resentPlan).toBe(true);
      }),
    ),
  );

  it.effect("carries reviewer edits as one complete plan and records a human version", () =>
    runWithService({ sessionStatus: "running", compactionAt: null }, ({ service, dispatched }) =>
      Effect.gen(function* () {
        const document = yield* capturePlan(service, "plan:a");
        yield* service.submit({
          documentId: document.documentId,
          decision: "approved",
          globalComment: "",
          editedMarkdown: PLAN.replace("Flip the flag", "Flip the flag behind a kill switch"),
          actorUserId: reviewerId,
          actorLabel: "Tushar",
        });

        const text = turnText(yield* Ref.get(dispatched));
        expect(text).toContain("Plan approved with reviewer edits.");
        expect(text).toContain("1. Add the migration\n2. Backfill the rows");
        expect(text).toContain("3. Flip the flag behind a kill switch");
        expect(text).not.toContain("```diff");
        expect(text.split("# Auth rewrite")).toHaveLength(2);

        const snapshot = yield* service.getReview(document.documentId);
        expect(snapshot.versions).toHaveLength(2);
        expect(snapshot.versions[1]?.authorKind).toBe("user");
        expect(snapshot.versions[1]?.authorUserId).toBe(reviewerId);
        expect(snapshot.document.status).toBe("approved");
      }),
    ),
  );

  it.effect("includes unresolved comments when approving without repeating the plan", () =>
    runWithService({ sessionStatus: "running", compactionAt: null }, ({ service, dispatched }) =>
      Effect.gen(function* () {
        const document = yield* capturePlan(service, "plan:a");
        yield* service.upsertDiscussion({
          documentId: document.documentId,
          discussionId: "discussion-1",
          quotedText: "2. Backfill the rows",
          bodyMarkdown: "Keep this safe for a rolling deploy.",
          actorUserId: reviewerId,
        });

        yield* service.submit({
          documentId: document.documentId,
          decision: "approved",
          globalComment: "Start with the migration.",
          editedMarkdown: null,
          actorUserId: reviewerId,
          actorLabel: "Tushar",
        });

        const text = turnText(yield* Ref.get(dispatched));
        // T3-CUSTOM(expbkt3): approving with comments open means "start now, and
        // fold these in" — so the prompt must not also say "exactly as written".
        expect(text).toContain("Plan approved — start implementing it now.");
        expect(text).toContain("apply them as you implement");
        expect(text).not.toContain("exactly as written");
        expect(text).toContain("Reviewer notes:\nStart with the migration.");
        expect(text).toContain("<review_comment ");
        expect(text).toContain("Keep this safe for a rolling deploy.");
        expect(text).not.toContain("3. Flip the flag");

        const snapshot = yield* service.getReview(document.documentId);
        expect(snapshot.discussions[0]?.isResolved).toBe(true);
      }),
    ),
  );
});

describe("PlanReviewService feedback", () => {
  it.effect("sends anchored comments without the plan body", () =>
    runWithService({ sessionStatus: "running", compactionAt: null }, ({ service, dispatched }) =>
      Effect.gen(function* () {
        const document = yield* capturePlan(service, "plan:a");
        yield* service.upsertDiscussion({
          documentId: document.documentId,
          discussionId: "discussion-1",
          quotedText: "2. Backfill the rows",
          bodyMarkdown: "Split this into its own migration.",
          actorUserId: reviewerId,
        });

        yield* service.submit({
          documentId: document.documentId,
          decision: "changes-requested",
          globalComment: "Too broad overall.",
          editedMarkdown: null,
          actorUserId: reviewerId,
          actorLabel: "Tushar",
        });

        const commands = yield* Ref.get(dispatched);
        const text = turnText(commands);

        expect(text).toContain("Revise the plan you proposed.");
        expect(text).toContain("Too broad overall.");
        expect(text).toContain("<review_comment ");
        // The anchor resolves to the quoted line, 0-based.
        expect(text).toContain('startIndex="5"');
        expect(text).toContain('rangeLabel="L6"');
        expect(text).toContain("Split this into its own migration.");
        expect(text).not.toContain("3. Flip the flag");

        // Feedback keeps the thread planning and never persists a mode change.
        expect(commands.some((command) => command.type === "thread.interaction-mode.set")).toBe(
          false,
        );
        const turn = commands.find((command) => command.type === "thread.turn.start");
        expect(turn?.type === "thread.turn.start" && turn.interactionMode).toBe("plan");

        const snapshot = yield* service.getReview(document.documentId);
        expect(snapshot.document.status).toBe("changes-requested");
      }),
    ),
  );

  it.effect("sends one complete revised plan instead of a formatting-sensitive diff", () =>
    runWithService({ sessionStatus: "running", compactionAt: null }, ({ service, dispatched }) =>
      Effect.gen(function* () {
        const document = yield* capturePlan(service, "plan:a");
        const revised = PLAN.replace("Flip the flag", "Flip the flag behind a kill switch");

        yield* service.submit({
          documentId: document.documentId,
          decision: "changes-requested",
          globalComment: "Use this wording.",
          editedMarkdown: revised,
          actorUserId: reviewerId,
          actorLabel: "Tushar",
        });

        const text = turnText(yield* Ref.get(dispatched));
        expect(text).toContain('<plan_edit filePath="Auth rewrite.md" mode="full">');
        expect(text).toContain(revised);
        expect(text).not.toContain("```diff");
        expect(text.split("# Auth rewrite")).toHaveLength(2);
      }),
    ),
  );

  it.effect("omits a resolved discussion from the feedback", () =>
    runWithService({ sessionStatus: "running", compactionAt: null }, ({ service, dispatched }) =>
      Effect.gen(function* () {
        const document = yield* capturePlan(service, "plan:a");
        yield* service.upsertDiscussion({
          documentId: document.documentId,
          discussionId: "discussion-1",
          quotedText: "2. Backfill the rows",
          bodyMarkdown: "Split this into its own migration.",
          actorUserId: reviewerId,
        });
        yield* service.resolveDiscussion({
          documentId: document.documentId,
          discussionId: "discussion-1",
          isResolved: true,
          actorUserId: reviewerId,
        });

        yield* service.submit({
          documentId: document.documentId,
          decision: "changes-requested",
          globalComment: "Still too broad.",
          editedMarkdown: null,
          actorUserId: reviewerId,
          actorLabel: "Tushar",
        });

        const text = turnText(yield* Ref.get(dispatched));
        expect(text).toContain("Still too broad.");
        expect(text).not.toContain("<review_comment ");
      }),
    ),
  );

  it.effect("discards without starting a turn", () =>
    runWithService({ sessionStatus: "running", compactionAt: null }, ({ service, dispatched }) =>
      Effect.gen(function* () {
        const document = yield* capturePlan(service, "plan:a");
        const result = yield* service.submit({
          documentId: document.documentId,
          decision: "discarded",
          globalComment: "",
          editedMarkdown: null,
          actorUserId: reviewerId,
          actorLabel: "Tushar",
        });

        expect(result.turnStarted).toBe(false);
        expect(result.prompt).toBeNull();

        const commands = yield* Ref.get(dispatched);
        expect(commands.some((command) => command.type === "thread.turn.start")).toBe(false);

        const snapshot = yield* service.getReview(document.documentId);
        expect(snapshot.document.status).toBe("discarded");
      }),
    ),
  );
});

describe("PlanReviewService regressions", () => {
  it.effect("keeps the lineage when the agent answers feedback", () =>
    runWithService({ sessionStatus: "running", compactionAt: null }, ({ service }) =>
      Effect.gen(function* () {
        const document = yield* capturePlan(service, "plan:a");
        yield* service.upsertDiscussion({
          documentId: document.documentId,
          discussionId: "discussion-1",
          quotedText: "2. Backfill the rows",
          bodyMarkdown: "Split this.",
          actorUserId: reviewerId,
        });
        yield* service.submit({
          documentId: document.documentId,
          decision: "changes-requested",
          globalComment: "",
          editedMarkdown: null,
          actorUserId: reviewerId,
          actorLabel: "Tushar",
        });

        // The agent's answer must append to the same document, not start a new
        // history that orphans the comments that asked for it.
        const revised = yield* capturePlan(service, "plan:b", `${PLAN}\n4. Announce it`);
        expect(revised.documentId).toBe(document.documentId);
        expect(revised.status).toBe("open");

        const snapshot = yield* service.getReview(document.documentId);
        expect(snapshot.versions).toHaveLength(2);
        expect(snapshot.versions[1]?.origin).toBe("agent-revision");
      }),
    ),
  );

  it.effect("does not re-send comments that already reached the agent", () =>
    runWithService({ sessionStatus: "running", compactionAt: null }, ({ service, dispatched }) =>
      Effect.gen(function* () {
        const document = yield* capturePlan(service, "plan:a");
        yield* service.upsertDiscussion({
          documentId: document.documentId,
          discussionId: "discussion-1",
          quotedText: "2. Backfill the rows",
          bodyMarkdown: "Split this.",
          actorUserId: reviewerId,
        });
        yield* service.submit({
          documentId: document.documentId,
          decision: "changes-requested",
          globalComment: "",
          editedMarkdown: null,
          actorUserId: reviewerId,
          actorLabel: "Tushar",
        });
        yield* capturePlan(service, "plan:b", `${PLAN}\n4. Announce it`);

        yield* service.submit({
          documentId: document.documentId,
          decision: "changes-requested",
          globalComment: "Second round.",
          editedMarkdown: null,
          actorUserId: reviewerId,
          actorLabel: "Tushar",
        });

        const turns = (yield* Ref.get(dispatched)).filter(
          (command) => command.type === "thread.turn.start",
        );
        expect(turns).toHaveLength(2);
        const second = turns[1];
        const secondText = second?.type === "thread.turn.start" ? second.message.text : "";
        expect(secondText).toContain("Second round.");
        expect(secondText).not.toContain("Split this.");
      }),
    ),
  );

  it.effect("refuses a second decision on the same review", () =>
    runWithService({ sessionStatus: "running", compactionAt: null }, ({ service, dispatched }) =>
      Effect.gen(function* () {
        const document = yield* capturePlan(service, "plan:a");
        const approve = {
          documentId: document.documentId,
          decision: "approved" as const,
          globalComment: "",
          editedMarkdown: null,
          actorUserId: reviewerId,
          actorLabel: "Tushar",
        };

        yield* service.submit(approve);
        const second = yield* service.submit(approve).pipe(Effect.exit);
        expect(second._tag).toBe("Failure");

        // The agent must not be told to implement the plan twice.
        const turns = (yield* Ref.get(dispatched)).filter(
          (command) => command.type === "thread.turn.start",
        );
        expect(turns).toHaveLength(1);
      }),
    ),
  );

  it.effect("refuses to edit a review that is no longer open", () =>
    runWithService({ sessionStatus: "running", compactionAt: null }, ({ service }) =>
      Effect.gen(function* () {
        const document = yield* capturePlan(service, "plan:a");
        yield* service.submit({
          documentId: document.documentId,
          decision: "discarded",
          globalComment: "",
          editedMarkdown: null,
          actorUserId: reviewerId,
          actorLabel: "Tushar",
        });

        const saved = yield* service
          .saveDraft({
            documentId: document.documentId,
            contentValueJson: '{"markdown":"late"}',
            expectedRevisionToken: null,
            actorUserId: reviewerId,
          })
          .pipe(Effect.exit);
        expect(saved._tag).toBe("Failure");
      }),
    ),
  );

  it.effect("does not reach a discussion through a document the caller owns", () =>
    runWithService({ sessionStatus: "running", compactionAt: null }, ({ service }) =>
      Effect.gen(function* () {
        const victim = yield* capturePlan(service, "plan:victim");
        yield* service.upsertDiscussion({
          documentId: victim.documentId,
          discussionId: "discussion-victim",
          quotedText: "2. Backfill the rows",
          bodyMarkdown: "Split this.",
          actorUserId: reviewerId,
        });
        const attacker = yield* capturePlan(service, "plan:attacker", PLAN, otherThreadId);

        // The caller authorizes their own document, then names a discussion id
        // from a thread they cannot read. Both writes must miss.
        yield* service.resolveDiscussion({
          documentId: attacker.documentId,
          discussionId: "discussion-victim",
          isResolved: true,
          actorUserId: reviewerId,
        });
        yield* service.upsertDiscussion({
          documentId: attacker.documentId,
          discussionId: "discussion-victim",
          quotedText: "injected quote",
          bodyMarkdown: "injected body",
          actorUserId: reviewerId,
        });

        const snapshot = yield* service.getReview(victim.documentId);
        expect(snapshot.discussions).toHaveLength(1);
        expect(snapshot.discussions[0]?.isResolved).toBe(false);
        expect(snapshot.discussions[0]?.quotedText).toBe("2. Backfill the rows");
        expect(snapshot.comments.map((comment) => comment.bodyMarkdown)).toEqual(["Split this."]);
      }),
    ),
  );

  it.effect("does not diff versions belonging to another document", () =>
    runWithService({ sessionStatus: "running", compactionAt: null }, ({ service }) =>
      Effect.gen(function* () {
        const victim = yield* capturePlan(service, "plan:victim");
        const attacker = yield* capturePlan(service, "plan:attacker", PLAN, otherThreadId);
        const victimVersions = yield* service.getReview(victim.documentId);
        const versionId = victimVersions.versions[0]!.versionId;

        const result = yield* service
          .getVersionDiff({
            documentId: attacker.documentId,
            fromVersionId: versionId,
            toVersionId: versionId,
          })
          .pipe(Effect.exit);
        expect(result._tag).toBe("Failure");
      }),
    ),
  );
});

describe("PlanReviewService drafts", () => {
  it.effect("rejects a save that carried a stale revision token", () =>
    runWithService({ sessionStatus: "running", compactionAt: null }, ({ service }) =>
      Effect.gen(function* () {
        const document = yield* capturePlan(service, "plan:a");

        const first = yield* service.saveDraft({
          documentId: document.documentId,
          contentValueJson: '{"markdown":"one"}',
          expectedRevisionToken: null,
          actorUserId: reviewerId,
        });

        // A second writer who never saw `first` still holds the old token.
        const conflict = yield* service
          .saveDraft({
            documentId: document.documentId,
            contentValueJson: '{"markdown":"two"}',
            expectedRevisionToken: null,
            actorUserId: reviewerId,
          })
          .pipe(Effect.exit);

        expect(conflict._tag).toBe("Failure");

        const accepted = yield* service.saveDraft({
          documentId: document.documentId,
          contentValueJson: '{"markdown":"three"}',
          expectedRevisionToken: first.revisionToken,
          actorUserId: reviewerId,
        });
        expect(accepted.revisionToken).not.toBe(first.revisionToken);
      }),
    ),
  );

  it.effect("rejects a stale token even after the draft was cleared", () =>
    runWithService({ sessionStatus: "running", compactionAt: null }, ({ service }) =>
      Effect.gen(function* () {
        const document = yield* capturePlan(service, "plan:a");
        const first = yield* service.saveDraft({
          documentId: document.documentId,
          contentValueJson: '{"markdown":"one"}',
          expectedRevisionToken: null,
          actorUserId: reviewerId,
        });

        // An agent revision invalidates the draft it was based on.
        yield* capturePlan(service, "plan:b", `${PLAN}\n4. Announce it`);

        // Resurrecting it with the pre-revision token would record content
        // against a version it was never derived from.
        const stale = yield* service
          .saveDraft({
            documentId: document.documentId,
            contentValueJson: '{"markdown":"one"}',
            expectedRevisionToken: first.revisionToken,
            actorUserId: reviewerId,
          })
          .pipe(Effect.exit);
        expect(stale._tag).toBe("Failure");
      }),
    ),
  );

  it.effect("clears the draft when an agent revision lands", () =>
    runWithService({ sessionStatus: "running", compactionAt: null }, ({ service }) =>
      Effect.gen(function* () {
        const document = yield* capturePlan(service, "plan:a");
        yield* service.saveDraft({
          documentId: document.documentId,
          contentValueJson: '{"markdown":"mine"}',
          expectedRevisionToken: null,
          actorUserId: reviewerId,
        });

        yield* capturePlan(service, "plan:b", `${PLAN}\n4. Announce it`);

        const snapshot = yield* service.getReview(document.documentId);
        expect(snapshot.draft).toBeNull();
      }),
    ),
  );
});

describe("PlanReviewService version diff", () => {
  it.effect("renders a diff between two versions", () =>
    runWithService({ sessionStatus: "running", compactionAt: null }, ({ service }) =>
      Effect.gen(function* () {
        const document = yield* capturePlan(service, "plan:a");
        yield* capturePlan(service, "plan:b", `${PLAN}\n4. Announce it`);
        const snapshot = yield* service.getReview(document.documentId);

        const diff = yield* service.getVersionDiff({
          documentId: document.documentId,
          fromVersionId: snapshot.versions[0]!.versionId,
          toVersionId: snapshot.versions[1]!.versionId,
        });

        expect(diff.diff).toContain("diff --git a/Auth rewrite.md");
        expect(diff.diff).toContain("+4. Announce it");
      }),
    ),
  );
});

describe("PlanReviewService closes the plan it decided", () => {
  const withPlan = (planId: string) => ({
    sessionStatus: "running",
    compactionAt: null,
    proposedPlans: [
      {
        id: planId,
        planMarkdown: PLAN,
        implementedAt: null,
        updatedAt: "2026-09-01T10:00:00.000Z",
      },
    ],
  });

  it.effect("marks the plan implemented when the review is approved", () =>
    runWithService(withPlan("plan:a"), ({ service, dispatched }) =>
      Effect.gen(function* () {
        const document = yield* capturePlan(service, "plan:a");
        yield* service.submit({
          documentId: document.documentId,
          decision: "approved",
          globalComment: "",
          editedMarkdown: null,
          actorUserId: reviewerId,
          actorLabel: "Tushar",
        });

        const closed = implementedPlans(yield* Ref.get(dispatched));
        expect(closed).toHaveLength(1);
        expect(closed[0]?.id).toBe("plan:a");
        // Implementation runs in this thread, so it owns the plan.
        expect(closed[0]?.implementationThreadId).toBe(threadId);
      }),
    ),
  );

  it.effect("marks the plan implemented when the review is discarded", () =>
    runWithService(withPlan("plan:a"), ({ service, dispatched }) =>
      Effect.gen(function* () {
        const document = yield* capturePlan(service, "plan:a");
        yield* service.submit({
          documentId: document.documentId,
          decision: "discarded",
          globalComment: "",
          editedMarkdown: null,
          actorUserId: reviewerId,
          actorLabel: "Tushar",
        });

        const closed = implementedPlans(yield* Ref.get(dispatched));
        expect(closed).toHaveLength(1);
        expect(closed[0]?.id).toBe("plan:a");
        expect(closed[0]?.implementationThreadId).toBeNull();
      }),
    ),
  );

  it.effect("leaves the plan open while the agent answers feedback", () =>
    runWithService(withPlan("plan:a"), ({ service, dispatched }) =>
      Effect.gen(function* () {
        const document = yield* capturePlan(service, "plan:a");
        yield* service.upsertDiscussion({
          documentId: document.documentId,
          discussionId: "plan-discussion:1",
          quotedText: "Backfill the rows",
          bodyMarkdown: "In batches, please.",
          actorUserId: reviewerId,
        });
        yield* service.submit({
          documentId: document.documentId,
          decision: "changes-requested",
          globalComment: "",
          editedMarkdown: null,
          actorUserId: reviewerId,
          actorLabel: "Tushar",
        });

        // The lineage is still live: its revision is what the reviewer waits
        // for, and closing the record here would hide it.
        expect(implementedPlans(yield* Ref.get(dispatched))).toHaveLength(0);
      }),
    ),
  );

  it.effect("heals a decision taken before the write-back existed", () =>
    runWithService(withPlan("plan:a"), ({ service, dispatched }) =>
      Effect.gen(function* () {
        const document = yield* capturePlan(service, "plan:a");
        yield* service.submit({
          documentId: document.documentId,
          decision: "approved",
          globalComment: "",
          editedMarkdown: null,
          actorUserId: reviewerId,
          actorLabel: "Tushar",
        });
        yield* Ref.set(dispatched, []);

        // Startup reconciliation re-offers every plan whose record is still
        // open. This one's review is approved, so the record is closed instead
        // of the plan being captured again.
        yield* capturePlan(service, "plan:a");

        const closed = implementedPlans(yield* Ref.get(dispatched));
        expect(closed).toHaveLength(1);
        expect(closed[0]?.id).toBe("plan:a");
      }),
    ),
  );
});
