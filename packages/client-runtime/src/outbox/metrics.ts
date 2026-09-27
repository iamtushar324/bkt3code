// T3-CUSTOM(expbkt3): client-owned outbox telemetry is recorded where
// persistence and delivery failures are observed.
import * as Effect from "effect/Effect";
import * as Metric from "effect/Metric";

export type ThreadOutboxFailureKind = "delivery" | "persistence";
export type ThreadOutboxFailureOutcome = "failed" | "retrying";

export const threadOutboxFailuresTotal = Metric.counter("t3_client_outbox_failures_total", {
  description: "Client outbox persistence or delivery failures.",
});

export function recordThreadOutboxFailure(input: {
  readonly kind: ThreadOutboxFailureKind;
  readonly operation: string;
  readonly outcome: ThreadOutboxFailureOutcome;
}) {
  return Metric.update(
    Metric.withAttributes(threadOutboxFailuresTotal, [
      ["kind", input.kind],
      ["operation", input.operation],
      ["outcome", input.outcome],
    ]),
    1,
  );
}

export function recordThreadOutboxFailureUnsafe(
  input: Parameters<typeof recordThreadOutboxFailure>[0],
): void {
  Effect.runFork(recordThreadOutboxFailure(input));
}
