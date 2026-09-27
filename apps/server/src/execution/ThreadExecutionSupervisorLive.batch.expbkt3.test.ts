// T3-CUSTOM(expbkt3): getSnapshots joins intents and request ledgers for many threads in one pass.
import { assert, it } from "@effect/vitest";
import {
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Tracer from "effect/Tracer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { makeSqlStatementCounter } from "../../integration/SqlStatementCounter.integration.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { layer as SessionRecoveryStateLayer } from "../persistence/SessionRecoveryState.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../provider/Services/ProviderService.ts";
import { ThreadExecutionSupervisor } from "./ThreadExecutionSupervisor.ts";
import { ThreadExecutionSupervisorLive } from "./ThreadExecutionSupervisorLive.ts";

const createdAt = "2026-09-27T00:00:00.000Z";
const providerInstanceId = ProviderInstanceId.make("codex");
const threadA = ThreadId.make("batch-a");
const threadB = ThreadId.make("batch-b");
const turnA = TurnId.make("turn-a");
const turnB = TurnId.make("turn-b");
const counter = makeSqlStatementCounter();

const turnStarted = (threadId: ThreadId, turnId: TurnId) => ({
  type: "turn.started" as const,
  eventId: EventId.make(`started-${threadId}`),
  provider: ProviderDriverKind.make("codex"),
  providerInstanceId,
  threadId,
  sessionGeneration: 1,
  turnId,
  createdAt,
  payload: {},
});

it.layer(SqlitePersistenceMemory)("batched execution snapshots", (it) => {
  it.effect(
    "keeps each thread's blockers to its own active turn and runs 3 statements for N threads",
    () =>
      Effect.gen(function* () {
        const start = yield* Deferred.make<void>();
        const delivered = yield* Deferred.make<void>();
        const providerService = {
          inspectSession: () => Effect.succeed(null),
          streamEvents: Stream.concat(
            Stream.fromEffect(Deferred.await(start)).pipe(
              Stream.flatMap(() =>
                Stream.make(turnStarted(threadA, turnA), turnStarted(threadB, turnB)),
              ),
            ),
            Stream.fromEffect(Deferred.succeed(delivered, undefined)).pipe(Stream.drain),
          ),
        } as unknown as ProviderServiceShape;
        const orchestration = {
          readEvents: () => Stream.empty,
          readThreadEvents: () => Stream.empty,
          getThreadReplayStats: () => Effect.die("unused"),
          subscribeDomainEvents: Effect.succeed(Stream.empty),
          dispatch: () => Effect.succeed({ sequence: 0 }),
          streamDomainEvents: Stream.empty,
          latestSequence: Effect.succeed(0),
        } satisfies OrchestrationEngineService["Service"];
        const supervisorLayer = ThreadExecutionSupervisorLive.pipe(
          Layer.provide(SessionRecoveryStateLayer),
          Layer.provide(Layer.succeed(ProviderService, providerService)),
          Layer.provide(Layer.succeed(OrchestrationEngineService, orchestration)),
          Layer.provide(NodeServices.layer),
        );
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const supervisor = yield* ThreadExecutionSupervisor;
          for (const threadId of [threadA, threadB]) {
            yield* supervisor.admitIdleTurn({
              threadId,
              executionId: `execution-${threadId}`,
              expectedExecutionRevision: 0,
              providerInstanceId,
              startedAt: createdAt,
            });
          }
          yield* Deferred.succeed(start, undefined);
          yield* Deferred.await(delivered);

          const add = (
            id: string,
            threadId: ThreadId,
            turnId: string,
            kind: string,
            requestId: string,
            sequence: number,
          ) =>
            sql`INSERT INTO projection_thread_activities
            (activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at)
            VALUES (${id}, ${threadId}, ${turnId}, 'info', ${kind}, ${id},
              ${JSON.stringify({ requestId })}, ${sequence}, ${createdAt})`;
          // Thread A: an approval on its own turn blocks it.
          yield* add("a-approval", threadA, turnA, "approval.requested", "a-1", 10);
          // Thread B: a question tagged with thread A's turn id must not block B,
          // and B's own answered question must not either.
          yield* add("b-foreign-turn", threadB, turnA, "user-input.requested", "b-1", 11);
          yield* add("b-question", threadB, turnB, "user-input.requested", "b-2", 12);
          yield* add("b-answer", threadB, turnB, "user-input.resolved", "b-2", 13);
          yield* sql`INSERT INTO projection_thread_execution_intents (
            work_item_id, thread_id, message_id, command_id, request_event_sequence,
            desired_state, phase, delivery_certainty, runnable, accepted_at, updated_at
          ) VALUES (
            'intent-a', ${threadA}, 'message-a', 'command-a', 9,
            'running', 'running', 'uncertain', 0, ${createdAt}, ${createdAt}
          )`;

          const idle = Array.from({ length: 40 }, (_, index) => ThreadId.make(`idle-${index}`));
          const before = counter.count();
          const batch = yield* supervisor.getSnapshots([threadA, ...idle, threadB]);
          const statements = counter.count() - before;

          assert.strictEqual(
            statements,
            3,
            "one intent query and two ledger queries for 42 threads",
          );
          assert.strictEqual(batch.size, 42);
          assert.strictEqual(batch.get(threadA)?.turn?.state, "waiting-for-approval");
          assert.strictEqual(batch.get(threadA)?.intent?.workItemId, "intent-a");
          assert.strictEqual(batch.get(threadB)?.turn?.state, "running");
          assert.strictEqual(batch.get(threadB)?.intent, undefined);
          assert.strictEqual(batch.get(idle[0]!)?.activity, "idle");
          // The single-thread path is the same code; it must agree.
          assert.deepStrictEqual(yield* supervisor.getSnapshot(threadA), batch.get(threadA));
          assert.deepStrictEqual(yield* supervisor.getSnapshot(threadB), batch.get(threadB));
        }).pipe(Effect.provide(supervisorLayer));
      }).pipe(Effect.provide(Layer.succeed(Tracer.Tracer, counter.tracer))),
  );
});
