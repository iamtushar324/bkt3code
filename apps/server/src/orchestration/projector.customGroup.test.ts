// T3-CUSTOM(expbkt3): custom sidebar group projection coverage.
import {
  CommandId,
  EventId,
  ProviderDriverKind,
  ThreadId,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { createEmptyReadModel, projectEvent } from "./projector.ts";

const now = "2026-01-01T00:00:00.000Z";

function threadEvent(input: {
  sequence: number;
  type: OrchestrationEvent["type"];
  payload: unknown;
}): OrchestrationEvent {
  return {
    sequence: input.sequence,
    eventId: EventId.make(`event-${input.sequence}`),
    type: input.type,
    aggregateKind: "thread",
    aggregateId: ThreadId.make("thread-1"),
    occurredAt: now,
    commandId: CommandId.make(`cmd-${input.sequence}`),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: input.payload as never,
  } as OrchestrationEvent;
}

const created = (customGroup?: string | null) =>
  threadEvent({
    sequence: 1,
    type: "thread.created",
    payload: {
      threadId: "thread-1",
      projectId: "project-1",
      title: "demo",
      modelSelection: { provider: ProviderDriverKind.make("codex"), model: "gpt-5-codex" },
      runtimeMode: "full-access",
      branch: null,
      worktreePath: null,
      sourceControlProfileId: null,
      createdAt: now,
      updatedAt: now,
      ...(customGroup === undefined ? {} : { customGroup }),
    },
  });

const metaUpdated = (sequence: number, payload: Record<string, unknown>) =>
  threadEvent({
    sequence,
    type: "thread.meta-updated",
    payload: { threadId: "thread-1", updatedAt: now, ...payload },
  });

it.effect("projects a creation-time custom group and defaults it to null", () =>
  Effect.gen(function* () {
    const grouped = yield* projectEvent(createEmptyReadModel(now), created("Sprint 42"));
    expect(grouped.threads[0]?.customGroup).toBe("Sprint 42");

    const plain = yield* projectEvent(createEmptyReadModel(now), created());
    expect(plain.threads[0]?.customGroup).toBe(null);
  }),
);

it.effect("sets, keeps and clears the custom group through thread.meta-updated", () =>
  Effect.gen(function* () {
    let model = yield* projectEvent(createEmptyReadModel(now), created());
    model = yield* projectEvent(model, metaUpdated(2, { customGroup: "Sprint 42" }));
    expect(model.threads[0]?.customGroup).toBe("Sprint 42");

    // A rename that says nothing about the group leaves it alone.
    model = yield* projectEvent(model, metaUpdated(3, { title: "Renamed" }));
    expect(model.threads[0]?.customGroup).toBe("Sprint 42");
    expect(model.threads[0]?.title).toBe("Renamed");

    model = yield* projectEvent(model, metaUpdated(4, { customGroup: null }));
    expect(model.threads[0]?.customGroup).toBe(null);
  }),
);
