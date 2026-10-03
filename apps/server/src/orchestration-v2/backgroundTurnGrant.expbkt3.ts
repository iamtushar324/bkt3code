// T3-CUSTOM(expbkt3): durable background turns retain their original authority.
import type { RunId, ThreadId, UserId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { isActiveExternalGrant } from "../mcp/UserMcpProfileStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import { isOwnerOrMember } from "./accessRules.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

export class BackgroundTurnDenied extends Schema.TaggedError<BackgroundTurnDenied>()(
  "BackgroundTurnDenied",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

/** Capture services once; provider callbacks must not retain a whole projection. */
export const makeBackgroundTurnGuard = Effect.fn("backgroundTurnGrant.make")(function* () {
  const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
  const settings = yield* Effect.serviceOption(ServerSettings.ServerSettingsService);
  return Effect.fn("backgroundTurnGrant.check")(function* (input: {
    readonly threadId: ThreadId;
    readonly actorUserId: UserId | null;
    readonly grantHash: string | undefined;
    readonly runId: RunId | null;
  }) {
    if (input.grantHash === undefined) return;
    const denied = (detail: string) => new BackgroundTurnDenied({ detail });
    if (input.actorUserId === null || Option.isNone(settings)) {
      return yield* denied("The background actor is unavailable.");
    }
    const enabled = yield* settings.value.getSettings.pipe(
      Effect.map((value) => value.experimental.externalMcp.enabled),
      Effect.orElseSucceed(() => false),
    );
    if (!enabled || !(yield* isActiveExternalGrant(input.actorUserId, input.grantHash))) {
      return yield* denied("The background authorization grant was revoked.");
    }
    const thread = yield* projectionStore
      .getThreadShell(input.threadId)
      .pipe(Effect.mapError(() => denied("The background thread could not be checked.")));
    if (thread === null || !isOwnerOrMember(thread, input.actorUserId)) {
      return yield* denied("The background actor no longer has access to this thread.");
    }
    if (thread.archivedAt !== null || thread.deletedAt !== null || thread.snoozedUntil != null) {
      return yield* denied("The thread no longer accepts a background turn.");
    }
    if (
      input.runId === null ||
      thread.activeRunId !== input.runId ||
      (thread.status !== "starting" && thread.status !== "running") ||
      thread.pendingRuntimeRequest !== null ||
      thread.hasPendingAsyncUserInput === true ||
      thread.hasActionableProposedPlan ||
      (thread.pendingBackgroundTasks?.length ?? 0) > 0
    ) {
      return yield* denied("The background turn no longer owns an available thread.");
    }
  });
});
