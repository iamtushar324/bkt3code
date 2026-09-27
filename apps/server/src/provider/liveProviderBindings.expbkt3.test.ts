import { ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ProviderSessionRuntime from "../persistence/ProviderSessionRuntime.ts";
import { ProviderSessionDirectoryLive } from "./Layers/ProviderSessionDirectory.ts";
import { listLiveProviderBindings } from "./liveProviderBindings.expbkt3.ts";
import { ProviderSessionDirectory } from "./Services/ProviderSessionDirectory.ts";

const layer = it.layer(
  ProviderSessionDirectoryLive.pipe(
    Layer.provideMerge(ProviderSessionRuntime.layer),
    Layer.provideMerge(SqlitePersistenceMemory),
  ),
);

layer("listLiveProviderBindings", (it) => {
  it.effect("returns exactly the non-stopped bindings listBindings would return", () =>
    Effect.gen(function* () {
      const repository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
      const directory = yield* ProviderSessionDirectory;
      const upsert = (id: string, status: "running" | "stopped" | "starting") =>
        repository.upsert({
          threadId: ThreadId.make(id),
          providerName: "claudeAgent",
          providerInstanceId: null,
          adapterKey: "claudeAgent",
          runtimeMode: "full-access",
          status,
          lastSeenAt: "2026-09-27T00:00:00.000Z",
          resumeCursor: { opaque: `resume-${id}` },
          runtimePayload: null,
        });
      for (let index = 0; index < 300; index += 1) yield* upsert(`stopped-${index}`, "stopped");
      yield* upsert("running-a", "running");
      yield* upsert("starting-b", "starting");

      const live = yield* listLiveProviderBindings(directory);
      const expected = (yield* directory.listBindings()).filter(
        (binding) => binding.status !== "stopped",
      );
      const byThread = <T extends { readonly threadId: string }>(items: ReadonlyArray<T>) =>
        [...items].sort((left, right) => left.threadId.localeCompare(right.threadId));
      assert.strictEqual(live.length, 2);
      assert.deepStrictEqual(byThread(live), byThread(expected));
    }),
  );
});
