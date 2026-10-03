// T3-CUSTOM(expbkt3): export a session's history the moment it is archived.
//
// Reclaim-time export (the sweeper's) is too late for the raw provider
// transcripts: their location is derived from the worktree path, so they are
// findable only while the thread's cursor and worktree are still on record.
// Reacting to `thread.archived` captures everything at the earliest durable
// moment. Re-archiving after an unarchive simply re-exports over the same
// files — the export is idempotent by construction.
import type { OrchestrationEvent } from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { forkParked } from "../../serverActivation.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { SessionArchiveService } from "../../sessionArchive/SessionArchiveService.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  ArchiveExportReactor,
  type ArchiveExportReactorShape,
} from "../Services/ArchiveExportReactor.ts";

type ThreadArchivedEvent = Extract<OrchestrationEvent, { type: "thread.archived" }>;

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const sessionArchive = yield* SessionArchiveService;
  const settingsService = yield* ServerSettingsService;

  const processThreadArchived = Effect.fn("processThreadArchived")(function* (
    event: ThreadArchivedEvent,
  ) {
    // Re-read per event, like the sweeper: the operator can flip the setting
    // without a restart and the next archive honors it.
    const settings = yield* settingsService.getSettings;
    if (!settings.experimental.sessionArchive.enabled) {
      return;
    }

    const result = yield* sessionArchive.exportHistory([event.payload.threadId]);
    for (const failure of result.failures) {
      yield* Effect.logWarning("archive export reactor could not export a session", {
        threadId: failure.threadId,
        message: failure.message,
      });
    }
  });

  const processThreadArchivedSafely = (event: ThreadArchivedEvent) =>
    processThreadArchived(event).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("archive export reactor failed to process event", {
          eventType: event.type,
          threadId: event.payload.threadId,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processThreadArchivedSafely);

  const start: ArchiveExportReactorShape["start"] = Effect.fn("start")(function* () {
    yield* forkParked(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        if (event.type !== "thread.archived") {
          return Effect.void;
        }
        return worker.enqueue(event);
      }),
    );
  });

  return {
    start,
    drain: worker.drain,
  } satisfies ArchiveExportReactorShape;
});

export const ArchiveExportReactorLive = Layer.effect(ArchiveExportReactor, make);
