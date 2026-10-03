// T3-CUSTOM(expbkt3): receipt reconciliation must stay bounded by its command's events.
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  ProviderSessionId,
  ThreadId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Statement from "effect/unstable/sql/Statement";

import * as EventStore from "../../orchestration-v2/EventStore.ts";
import * as OrchestrationEventStore from "../Services/OrchestrationEventStore.ts";
import { OrchestrationEventStoreLive } from "./OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const TestLayer = EventStore.layerFromOrchestrationEventStore.pipe(
  Layer.provideMerge(OrchestrationEventStoreLive.pipe(Layer.provideMerge(SqlitePersistenceMemory))),
);

it.effect("seeks command receipt events without scanning unrelated application history", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const store = yield* EventStore.EventStoreV2;
    const application = yield* OrchestrationEventStore.OrchestrationEventStore;
    const now = DateTime.makeUnsafe("2026-10-03T00:00:00Z");
    const occurredAt = DateTime.formatIso(now);
    const commandId = CommandId.make("manager-review:receipt-index");
    const threadId = ThreadId.make("manager:receipt-index");

    yield* sql`
      WITH RECURSIVE history(n) AS (
        SELECT 1 UNION ALL SELECT n + 1 FROM history WHERE n < 1500
      )
      INSERT INTO orchestration_events (
        event_id, aggregate_kind, stream_id, stream_version, event_type,
        occurred_at, command_id, actor_kind, payload_json, metadata_json,
        application_event_version
      )
      SELECT 'unrelated:' || n, 'thread', 'thread:unrelated', n,
        'provider-session.detached', ${occurredAt}, 'command:unrelated:' || n,
        'server', json_object('providerSessionId', 'session:unrelated:' || n,
        'detachedAt', ${occurredAt}), '{}', 2
      FROM history
    `;
    const events = [1, 2, 3].map((index): OrchestrationV2DomainEvent => ({
      id: EventId.make(`event:receipt-index:${index}`),
      threadId,
      type: "provider-session.detached",
      occurredAt: now,
      payload: {
        providerSessionId: ProviderSessionId.make(`session:receipt-index:${index}`),
        detachedAt: now,
      },
    }));
    const appended = yield* store.append({ commandId, events });
    const queries: Array<{ query: string; params: ReadonlyArray<unknown> }> = [];
    const recordReads: Statement.Transformer = (statement) => {
      const [query, params] = statement.compile();
      if (query.includes("FROM orchestration_events")) queries.push({ query, params });
      return Effect.succeed(statement);
    };

    for (const id of [commandId, CommandId.make("manager-review:absent")]) {
      const rows = yield* store
        .readByCommandId({ commandId: id })
        .pipe(Stream.provideService(Statement.CurrentTransformer, recordReads), Stream.runCollect);
      assert.deepEqual(
        rows.map((row) => row.sequence),
        id === commandId ? appended.map((row) => row.sequence) : [],
      );
    }
    const bounded = yield* application
      .readAgentEvents({
        commandId,
        threadId,
        eventType: "provider-session.detached",
        afterSequence: appended[0]!.sequence,
        throughSequence: appended[2]!.sequence,
        limit: 1,
      })
      .pipe(Stream.provideService(Statement.CurrentTransformer, recordReads), Stream.runCollect);
    assert.deepEqual(
      bounded.map((row) => row.sequence),
      [appended[1]!.sequence],
    );
    assert.lengthOf(queries, 3);
    for (const { query, params } of queries) {
      const plan = yield* sql.unsafe<{ readonly detail: string }>(
        `EXPLAIN QUERY PLAN ${query}`,
        params,
      );
      const details = plan.map((row) => row.detail).join("\n");
      assert.match(
        details,
        /SEARCH orchestration_events USING (?:COVERING )?INDEX idx_orch_events_command_id \(command_id=\?/,
      );
      assert.notMatch(details, /idx_orchestration_events_application_sequence|TEMP B-TREE/);
    }

    queries.length = 0;
    const feed = yield* application
      .readApplicationEvents({
        afterSequence: appended[0]!.sequence - 1,
        throughSequence: appended[2]!.sequence,
      })
      .pipe(Stream.provideService(Statement.CurrentTransformer, recordReads), Stream.runCollect);
    assert.deepEqual(
      feed.map((row) => row.sequence),
      appended.map((row) => row.sequence),
    );
    assert.lengthOf(queries, 1);
    const plan = yield* sql.unsafe<{ readonly detail: string }>(
      `EXPLAIN QUERY PLAN ${queries[0]!.query}`,
      queries[0]!.params,
    );
    assert.match(
      plan.map((row) => row.detail).join("\n"),
      /USING (?:COVERING )?INDEX idx_orchestration_events_application_high_water/,
    );
  }).pipe(Effect.provide(TestLayer)),
);
