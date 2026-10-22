import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";

/**
 * Runs a toolkit read of one session on the SQLite reader worker, off the
 * event loop. Agents read sessions through these tools all day (a brief, the
 * inbox); on bkt3 a cold read of one large session took 2–2.5 s, and on the
 * event loop it froze the whole server for that long.
 *
 * Every thread read first makes sure a migrated v1 transcript is imported,
 * which can write. A write fails on the reader, so a read that fails there
 * runs again on the writer, where the import can happen.
 */
export const readOffEventLoop = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  effect.pipe(
    NodeSqliteClient.readOnly,
    Effect.orElse(() => effect),
  );
