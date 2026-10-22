import type { ThreadId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";

import type { Caller } from "../../threadAccess.ts";

/**
 * Runs a toolkit read of one session on the SQLite reader worker, off the
 * event loop. Agents read sessions through these tools all day (a brief, the
 * inbox); on bkt3 a cold read of one large session took 2–2.5 s, and on the
 * event loop it froze the whole server for that long.
 *
 * Every thread read first makes sure a migrated v1 transcript is imported,
 * which can write, and a write fails on the reader. So that check runs on the
 * writer first (one indexed read, none once the thread is known), and the read
 * then finds the transcript in place.
 */
export const readSessionOffEventLoop = <A, E, R>(
  caller: Caller,
  threadId: ThreadId,
  read: Effect.Effect<A, E, R>,
) =>
  caller.threads
    .ensureLegacyTranscript(threadId)
    .pipe(Effect.andThen(read.pipe(NodeSqliteClient.readOnly)));
