import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { dispatchPersistedOutboxItem } from "./dispatch.ts";

class TestOutboxError extends Schema.TaggedError<TestOutboxError>()("TestOutboxError", {
  message: Schema.String,
}) {}

describe("durable outbox dispatch", () => {
  it.effect("does not touch the network when local persistence fails", () =>
    Effect.gen(function* () {
      let dispatched = false;
      const failure = new TestOutboxError({ message: "disk full" });

      const result = yield* dispatchPersistedOutboxItem({
        persist: Effect.fail(failure),
        dispatch: Effect.sync(() => {
          dispatched = true;
          return "accepted";
        }),
        remove: Effect.void,
      }).pipe(Effect.flip);

      expect(result).toBe(failure);
      expect(dispatched).toBe(false);
    }),
  );

  it.effect("removes only after an accepted command receipt", () =>
    Effect.gen(function* () {
      const order: string[] = [];
      const result = yield* dispatchPersistedOutboxItem({
        persist: Effect.sync(() => order.push("persisted")),
        dispatch: Effect.sync(() => {
          order.push("accepted");
          return 42;
        }),
        remove: Effect.sync(() => order.push("removed")),
      });

      expect(result).toBe(42);
      expect(order).toEqual(["persisted", "accepted", "removed"]);
    }),
  );

  it.effect("retains the same item when dispatch is uncertain or rejected", () =>
    Effect.gen(function* () {
      let removed = false;
      const failure = new TestOutboxError({ message: "acknowledgement timeout" });

      expect(
        yield* dispatchPersistedOutboxItem({
          persist: Effect.void,
          dispatch: Effect.fail(failure),
          remove: Effect.sync(() => {
            removed = true;
          }),
        }).pipe(Effect.flip),
      ).toBe(failure);
      expect(removed).toBe(false);
    }),
  );

  it.effect("does not turn an accepted receipt into a failure when local cleanup fails", () =>
    Effect.gen(function* () {
      const result = yield* dispatchPersistedOutboxItem({
        persist: Effect.void,
        dispatch: Effect.succeed("accepted"),
        remove: Effect.fail(new TestOutboxError({ message: "IndexedDB cleanup failed" })),
      });

      expect(result).toBe("accepted");
    }),
  );
});
