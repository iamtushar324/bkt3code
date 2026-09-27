import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  OrchestrationReactor,
  type OrchestrationReactorShape,
} from "../Services/OrchestrationReactor.ts";
import { CheckpointReactor } from "../Services/CheckpointReactor.ts";
import { ProviderCommandReactor } from "../Services/ProviderCommandReactor.ts";
import { ProviderRuntimeIngestionService } from "../Services/ProviderRuntimeIngestion.ts";
import { ThreadDeletionReactor } from "../Services/ThreadDeletionReactor.ts";
// T3-CUSTOM(expbkt3): archive-time session history export.
import { ArchiveExportReactor } from "../Services/ArchiveExportReactor.ts";
import * as ThreadSettlementReactor from "../ThreadSettlementReactor.ts";
import * as PullRequestSyncReactor from "../PullRequestSyncReactor.ts";
import * as ThreadPullRequestReactor from "../ThreadPullRequestReactor.ts";
import * as AgentAwarenessRelay from "../../relay/AgentAwarenessRelay.ts";
// T3-CUSTOM(expbkt3): T3_EXTERNAL_PR_SYNC gate for the two PR reactors.
import { unlessExternalPullRequestSync } from "../externalPullRequestSync.expbkt3.ts";
import * as StorageCleanup from "../../storageCleanup.ts";

export const makeOrchestrationReactor = Effect.gen(function* () {
  const providerRuntimeIngestion = yield* ProviderRuntimeIngestionService;
  const providerCommandReactor = yield* ProviderCommandReactor;
  const checkpointReactor = yield* CheckpointReactor;
  const threadDeletionReactor = yield* ThreadDeletionReactor;
  // T3-CUSTOM(expbkt3): archive-time session history export.
  const archiveExportReactor = yield* ArchiveExportReactor;
  const threadSettlementReactor = yield* ThreadSettlementReactor.ThreadSettlementReactor;
  const pullRequestSyncReactor = yield* PullRequestSyncReactor.PullRequestSyncReactor;
  const threadPullRequestReactor = yield* ThreadPullRequestReactor.ThreadPullRequestReactor;
  const agentAwarenessRelay = yield* AgentAwarenessRelay.AgentAwarenessRelay;
  const storageCleanup = yield* StorageCleanup.StorageCleanup;

  const start: OrchestrationReactorShape["start"] = Effect.fn("start")(function* () {
    yield* providerRuntimeIngestion.start();
    yield* providerCommandReactor.start();
    yield* checkpointReactor.start();
    yield* threadDeletionReactor.start();
    // T3-CUSTOM(expbkt3): archive-time session history export.
    yield* archiveExportReactor.start();
    // T3-CUSTOM(expbkt3): off when T3_EXTERNAL_PR_SYNC hands PR state to the bridge.
    yield* unlessExternalPullRequestSync(
      "ThreadPullRequestReactor",
      threadPullRequestReactor.start(),
    );
    yield* threadSettlementReactor.start();
    // T3-CUSTOM(expbkt3): off when T3_EXTERNAL_PR_SYNC hands PR state to the bridge.
    yield* unlessExternalPullRequestSync("PullRequestSyncReactor", pullRequestSyncReactor.start());
    yield* agentAwarenessRelay.start();
    yield* storageCleanup.start();
  });

  return {
    start,
  } satisfies OrchestrationReactorShape;
});

export const OrchestrationReactorLive = Layer.effect(
  OrchestrationReactor,
  makeOrchestrationReactor,
);
