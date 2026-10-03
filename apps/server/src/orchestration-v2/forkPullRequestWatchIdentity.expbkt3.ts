import { SourceControlProfileError, type ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { CurrentPullRequestProfileViewer } from "../pullRequest/sourceControlCredentialNamespace.expbkt3.ts";
import { withSourceControlExecutionEnvironment } from "../sourceControl/SourceControlExecutionEnvironment.ts";
import { SourceControlProfileService } from "../sourceControl/SourceControlProfileService.ts";
import { ProjectionStoreV2 } from "./ProjectionStore.ts";

/** Capture services before the reactor daemon runs outside the application layer context. */
export const makePullRequestWatchOwnerExecution = Effect.gen(function* () {
  const projections = yield* ProjectionStoreV2;
  const profiles = yield* SourceControlProfileService;
  return Effect.fn("PullRequestWatch.ownerExecution")(function* <A, E, R>(
    threadId: ThreadId,
    read: Effect.Effect<A, E, R>,
  ): Effect.fn.Return<A, E | SourceControlProfileError, R> {
    const thread = yield* projections.getThreadShell(threadId).pipe(
      Effect.mapError(
        () =>
          new SourceControlProfileError({
            operation: "resolve-thread-profile",
            reason: "thread-not-found",
            detail: "Could not read the thread's GitHub owner.",
            threadId,
          }),
      ),
    );
    if (thread === null || thread.deletedAt !== null) {
      return yield* new SourceControlProfileError({
        operation: "resolve-thread-profile",
        reason: "thread-not-found",
        detail: "The selected thread no longer exists.",
        threadId,
      });
    }
    const context = yield* profiles.resolveThreadExecutionContext(
      threadId,
      thread.ownerUserId ?? null,
      {},
    );
    return yield* withSourceControlExecutionEnvironment(
      read.pipe(Effect.provideService(CurrentPullRequestProfileViewer, context?.login ?? null)),
      context,
    );
  });
});
