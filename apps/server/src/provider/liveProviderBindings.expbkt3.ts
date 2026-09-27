/**
 * T3-CUSTOM(expbkt3): list only the provider bindings the reaper can act on.
 *
 * `ProviderSessionDirectory.listBindings()` decodes every row of
 * `provider_session_runtime` (two Schema passes plus a provider-kind decode
 * per row), and the reaper then skips every `stopped` one. In prod that was
 * 1,351 of 1,355 rows, and the decode made the sweep's bindings phase take
 * ~2 s at p90 and up to 5 s, on the shared event loop, every 5 minutes.
 *
 * This selects the ids of non-stopped rows first (one indexed-by-rowid scan
 * of a small table, no JSON) and decodes only those through the directory, so
 * the bindings keep exactly the shape `listBindings` returns. If the id query
 * fails, it falls back to the full list.
 */
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import type {
  ProviderRuntimeBindingWithMetadata,
  ProviderSessionDirectoryShape,
} from "./Services/ProviderSessionDirectory.ts";

export const listLiveProviderBindings = (directory: ProviderSessionDirectoryShape) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly threadId: string }>`
      SELECT thread_id AS "threadId" FROM provider_session_runtime WHERE status <> 'stopped'
    `;
    const bindings = yield* Effect.forEach(rows, (row) =>
      directory.getBinding(ThreadId.make(row.threadId)),
    );
    // getBinding and listBindings build the same object (toRuntimeBinding), so
    // it carries lastSeenAt; getBinding's declared type just omits it.
    return bindings.flatMap((binding) =>
      Option.isSome(binding) ? [binding.value as ProviderRuntimeBindingWithMetadata] : [],
    );
  }).pipe(Effect.catchTag("SqlError", () => directory.listBindings()));
