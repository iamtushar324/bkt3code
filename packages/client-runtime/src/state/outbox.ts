// T3-CUSTOM(expbkt3): reactive view of platform-persisted pending sends.
import { EnvironmentId, type EnvironmentId as EnvironmentIdType } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult, Atom, type AtomRegistry } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import type { QueuedThreadMessage } from "../outbox/model.ts";
import { EnvironmentCacheStore } from "../platform/persistence.ts";

const keyOf = (environmentId: EnvironmentIdType, identityKey: string) =>
  JSON.stringify([environmentId, identityKey]);

const parseKey = (key: string): readonly [EnvironmentIdType, string] => {
  const [environmentId, identityKey] = JSON.parse(key) as [string, string];
  return [EnvironmentId.make(environmentId), identityKey];
};

export const outboxRevisionAtom = Atom.family((key: string) =>
  Atom.make(0).pipe(Atom.keepAlive, Atom.withLabel(`durable-outbox:revision:${key}`)),
);

export function bumpOutboxRevision(
  registry: AtomRegistry.AtomRegistry,
  environmentId: EnvironmentIdType,
  identityKey: string,
): void {
  const atom = outboxRevisionAtom(keyOf(environmentId, identityKey));
  registry.set(atom, registry.get(atom) + 1);
}

export function createEnvironmentOutboxAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | EnvironmentCacheStore | R, E>,
) {
  const itemsAtom = Atom.family((key: string) => {
    const [environmentId, identityKey] = parseKey(key);
    return runtime
      .atom(
        (get) => {
          get(outboxRevisionAtom(key));
          return Effect.gen(function* () {
            const cache = yield* EnvironmentCacheStore;
            return cache.loadOutbox === undefined
              ? []
              : yield* cache.loadOutbox(environmentId, identityKey);
          });
        },
        { initialValue: [] as ReadonlyArray<QueuedThreadMessage> },
      )
      .pipe(Atom.keepAlive, Atom.withLabel(`durable-outbox:items:${key}`));
  });

  const itemsValueAtom = Atom.family((key: string) =>
    Atom.make((get) =>
      Option.getOrElse(
        AsyncResult.value(get(itemsAtom(key))),
        () => [] as ReadonlyArray<QueuedThreadMessage>,
      ),
    ).pipe(Atom.keepAlive, Atom.withLabel(`durable-outbox:value:${key}`)),
  );

  return {
    itemsAtom: (environmentId: EnvironmentIdType, identityKey: string) =>
      itemsAtom(keyOf(environmentId, identityKey)),
    itemsValueAtom: (environmentId: EnvironmentIdType, identityKey: string) =>
      itemsValueAtom(keyOf(environmentId, identityKey)),
  };
}
