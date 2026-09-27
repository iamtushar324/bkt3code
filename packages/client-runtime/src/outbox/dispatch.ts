// T3-CUSTOM(expbkt3): persistence is the gate before any message network side effect.
import * as Effect from "effect/Effect";

export function dispatchPersistedOutboxItem<A, EPersist, EDispatch, ERemove, R>(input: {
  readonly persist: Effect.Effect<void, EPersist, R>;
  readonly dispatch: Effect.Effect<A, EDispatch, R>;
  readonly remove: Effect.Effect<void, ERemove, R>;
}): Effect.Effect<A, EPersist | EDispatch, R> {
  return input.persist.pipe(
    Effect.andThen(input.dispatch),
    // An accepted receipt is authoritative. A failed local deletion leaves a
    // harmless duplicate that the server will deduplicate by commandId.
    Effect.tap(() => input.remove.pipe(Effect.catch(() => Effect.void))),
  );
}
