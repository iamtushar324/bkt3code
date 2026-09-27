import {
  CommandId,
  TextGenerationError,
  type MessageId,
  type ThreadId,
  type TurnId,
  type OrchestrationEvent,
  type OrchestrationThread,
  type ProviderRuntimeEvent,
  type SessionSummarySettings,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";

import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import * as TextGeneration from "../../textGeneration/TextGeneration.ts";
import {
  CatchupSummaryReactor,
  type CatchupSummaryReactorShape,
} from "../Services/CatchupSummaryReactor.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

/** Summarization must never outlive the session it describes. */
const SUMMARIZATION_TIMEOUT = "120 seconds";

/**
 * Bound on remembered `${threadId}:${turnId}` keys. A duplicate slipping past
 * this window only costs a redundant summarization, never corrupt state.
 */
const MAX_TRACKED_TURNS = 256;

/** Tail of the final assistant message fed to the short-summary prompt. */
const TURN_TAIL_CHARS = 4_000;
const CATCHUP_ERROR_FALLBACK =
  "The summarizer did not return a result. Check the selected model and try again.";
const MAX_CATCHUP_ERROR_CHARS = 500;
const isTextGenerationError = Schema.is(TextGenerationError);

type ReactorInput =
  | {
      readonly source: "runtime";
      readonly event: ProviderRuntimeEvent;
    }
  | {
      readonly source: "domain";
      readonly event: OrchestrationEvent;
    };

function turnKey(threadId: ThreadId, turnId: TurnId): string {
  return `${threadId}:${turnId}`;
}

/** Insertion-ordered set with a hard cap; oldest keys fall out first. */
function trackBounded(tracked: Set<string>, key: string): void {
  tracked.add(key);
  if (tracked.size <= MAX_TRACKED_TURNS) {
    return;
  }
  const oldest = tracked.values().next();
  if (!oldest.done) {
    tracked.delete(oldest.value);
  }
}

function parseIsoMs(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Keep provider failures useful in the inline card without forwarding defects,
 * stack traces, or arbitrarily large CLI output to the browser.
 */
export function catchupFailureMessage(cause: Cause.Cause<unknown>): string {
  const failure = Cause.findErrorOption(cause);
  const detail =
    Option.isSome(failure) && isTextGenerationError(failure.value)
      ? failure.value.detail.trim()
      : "";
  return detail && detail.length > 0
    ? detail.slice(0, MAX_CATCHUP_ERROR_CHARS)
    : CATCHUP_ERROR_FALLBACK;
}

/**
 * Render the turn's messages as a plain transcript. The user message that
 * started the turn is included when present so the summary knows what was asked.
 */
function buildTurnTranscript(thread: OrchestrationThread, turnId: TurnId): string {
  const lines: Array<string> = [];
  const messages = thread.messages;

  const firstTurnIndex = messages.findIndex((message) => message.turnId === turnId);
  if (firstTurnIndex > 0) {
    for (let index = firstTurnIndex - 1; index >= 0; index -= 1) {
      const candidate = messages[index];
      if (!candidate) {
        continue;
      }
      if (candidate.role === "user") {
        lines.push(`user: ${candidate.text}`);
        break;
      }
    }
  }

  for (const message of messages) {
    if (message.turnId !== turnId) {
      continue;
    }
    lines.push(`${message.role}: ${message.text}`);
  }

  return lines.join("\n\n");
}

function lastAssistantMessageForTurn(
  thread: OrchestrationThread,
  turnId: TurnId,
): { id: MessageId; text: string } | null {
  let found: { id: MessageId; text: string } | null = null;
  for (const message of thread.messages) {
    if (message.turnId === turnId && message.role === "assistant") {
      found = { id: message.id, text: message.text };
    }
  }
  return found;
}

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const randomUUID = crypto.randomUUIDv4;
  const serverCommandId = (tag: string) =>
    randomUUID.pipe(Effect.map((uuid) => CommandId.make(`server:${tag}:${uuid}`)));
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const providerService = yield* ProviderService;
  const serverSettingsService = yield* ServerSettingsService;
  const textGeneration = yield* TextGeneration.TextGeneration;

  // Turn start times observed live. Preferred over projection timestamps
  // because it cannot race the projection pipeline.
  const turnStartedAtMs = new Map<string, number>();
  const summarizedTurns = new Set<string>();

  const resolveTurnDurationMs = (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId;
    readonly thread: OrchestrationThread;
    readonly completedAtMs: number;
  }): number | null => {
    const observedStart = turnStartedAtMs.get(turnKey(input.threadId, input.turnId));
    if (observedStart !== undefined) {
      return input.completedAtMs - observedStart;
    }

    // Fall back to projected turn timing (e.g. after a server restart).
    const latestTurn = input.thread.latestTurn;
    if (latestTurn && latestTurn.turnId === input.turnId) {
      const startedAtMs = parseIsoMs(latestTurn.startedAt) ?? parseIsoMs(latestTurn.requestedAt);
      const completedAtMs = parseIsoMs(latestTurn.completedAt) ?? input.completedAtMs;
      if (startedAtMs !== null) {
        return completedAtMs - startedAtMs;
      }
    }
    return null;
  };

  const summarizeTurn = Effect.fn("summarizeTurn")(function* (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId;
    readonly completedAt: string;
    /** Assistant message the settling event anchored the turn to, when known. */
    readonly assistantMessageId?: MessageId | null | undefined;
    /** Operator-triggered: ignore the duration cutoff and re-summarize. */
    readonly force?: boolean | undefined;
  }) {
    const settings = yield* serverSettingsService.getSettings;
    const sessionSummary: SessionSummarySettings = settings.experimental.sessionSummary;
    // Disabling the experiment stops automatic calls and rolling ingestion;
    // an explicit operator request remains available from the message action.
    if (!sessionSummary.enabled && input.force !== true) {
      return;
    }

    const key = turnKey(input.threadId, input.turnId);
    if (summarizedTurns.has(key) && input.force !== true) {
      return;
    }

    const threadOption = yield* projectionSnapshotQuery.getThreadDetailById(input.threadId, {
      // Summaries read messages and turns only; skip every activity payload.
      activityKinds: [],
    });
    if (Option.isNone(threadOption)) {
      return;
    }
    const thread = threadOption.value;

    // A still-running session means the turn has not settled yet; the next
    // completion event for it will summarize.
    if (thread.session?.status === "running" && thread.session.activeTurnId === input.turnId) {
      return;
    }

    const turnTranscript = buildTurnTranscript(thread, input.turnId);
    if (turnTranscript.trim().length === 0) {
      return;
    }

    const contextOption = yield* projectionSnapshotQuery.getThreadCheckpointContext(input.threadId);
    if (Option.isNone(contextOption)) {
      return;
    }
    const cwd = contextOption.value.worktreePath ?? contextOption.value.workspaceRoot;

    // Claim the turn before spending tokens so a duplicate event that arrives
    // mid-flight cannot start a second summarization for the same turn.
    trackBounded(summarizedTurns, key);

    const lastAssistant = lastAssistantMessageForTurn(thread, input.turnId);
    // Prefer the settling event's anchor; the projection snapshot can still be
    // missing assistant messages that arrived late in the turn.
    const assistantMessageId = input.assistantMessageId ?? lastAssistant?.id ?? null;

    const completedAtMs = parseIsoMs(input.completedAt) ?? (yield* Clock.currentTimeMillis);
    const durationMs = resolveTurnDurationMs({
      threadId: input.threadId,
      turnId: input.turnId,
      thread,
      completedAtMs,
    });
    const cutoffMs = sessionSummary.minTurnDurationMinutes * 60_000;
    // A zero-minute cutoff means every settled turn, including a replay where
    // the server no longer has the original start timestamp.
    const qualifies =
      input.force === true || cutoffMs === 0 || (durationMs !== null && durationMs >= cutoffMs);

    const dispatchProgress = (progress: {
      readonly progress: "pending" | "ready" | "error" | "cleared";
      readonly rollingSummary: string | null;
      readonly displaySummary: string | null;
    }) =>
      Effect.gen(function* () {
        yield* orchestrationEngine.dispatch({
          type: "thread.catchup-summary.update",
          commandId: yield* serverCommandId("catchup-summary"),
          threadId: input.threadId,
          turnId: input.turnId,
          assistantMessageId,
          rollingSummary: progress.rollingSummary,
          displaySummary: progress.displaySummary,
          progress: progress.progress,
          createdAt: yield* nowIso,
        });
      });

    // Show the spinner immediately for qualifying turns: the rolling-summary
    // call below can take many seconds, and the user is looking at the output now.
    if (qualifies) {
      yield* dispatchProgress({ progress: "pending", rollingSummary: null, displaySummary: null });
    }

    // From here on a failure must replace the spinner with an actionable card.
    yield* Effect.gen(function* () {
      const rolling = yield* textGeneration
        .updateRollingSummary({
          cwd,
          threadTitle: thread.title,
          previousSummary: thread.rollingSummary,
          turnTranscript,
          dataLimitChars: sessionSummary.dataLimitChars,
          modelSelection: sessionSummary.modelSelection,
        })
        .pipe(Effect.timeout(SUMMARIZATION_TIMEOUT));

      if (!qualifies) {
        yield* dispatchProgress({
          progress: "cleared",
          rollingSummary: rolling.summary,
          displaySummary: null,
        });
        return;
      }
      if (rolling.summary.trim().length === 0) {
        yield* dispatchProgress({
          progress: "error",
          rollingSummary: rolling.summary,
          displaySummary: CATCHUP_ERROR_FALLBACK,
        });
        return;
      }

      const generated = yield* textGeneration
        .generateCatchupSummary({
          cwd,
          threadTitle: thread.title,
          rollingSummary: rolling.summary,
          turnTail: lastAssistant?.text ?? turnTranscript.slice(-TURN_TAIL_CHARS),
          modelSelection: sessionSummary.modelSelection,
          ...(sessionSummary.promptInstructions.trim().length > 0
            ? { customInstructions: sessionSummary.promptInstructions }
            : {}),
        })
        .pipe(Effect.timeout(SUMMARIZATION_TIMEOUT));

      const displaySummary = generated.summary.trim();
      yield* dispatchProgress(
        displaySummary.length > 0
          ? {
              progress: "ready",
              rollingSummary: rolling.summary,
              displaySummary,
            }
          : {
              progress: "error",
              rollingSummary: rolling.summary,
              displaySummary: CATCHUP_ERROR_FALLBACK,
            },
      );
    }).pipe(
      Effect.tapCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : // Replace the spinner, then let the worker log the failure.
            dispatchProgress({
              progress: "error",
              rollingSummary: null,
              displaySummary: catchupFailureMessage(cause),
            }).pipe(Effect.catch(() => Effect.void)),
      ),
    );

    turnStartedAtMs.delete(key);
  });

  const processDomainEvent = Effect.fn("processDomainEvent")(function* (event: OrchestrationEvent) {
    // Operator pressed "regenerate": always summarize, cutoff or not.
    if (event.type === "thread.catchup-summary-requested") {
      yield* summarizeTurn({
        threadId: event.payload.threadId,
        turnId: event.payload.turnId,
        completedAt: event.payload.createdAt,
        force: true,
      });
      return;
    }

    // A "missing" checkpoint is a mid-turn placeholder, not a settled turn.
    if (event.type === "thread.turn-diff-completed" && event.payload.status !== "missing") {
      yield* summarizeTurn({
        threadId: event.payload.threadId,
        turnId: event.payload.turnId,
        completedAt: event.payload.completedAt,
        assistantMessageId: event.payload.assistantMessageId,
      });
    }
  });

  const processRuntimeEvent = Effect.fn("processRuntimeEvent")(function* (
    event: ProviderRuntimeEvent,
  ) {
    if (event.turnId === undefined) {
      return;
    }

    if (event.type === "turn.started") {
      const startedAtMs = parseIsoMs(event.createdAt);
      if (startedAtMs !== null) {
        const key = turnKey(event.threadId, event.turnId);
        turnStartedAtMs.set(key, startedAtMs);
        if (turnStartedAtMs.size > MAX_TRACKED_TURNS) {
          const oldest = turnStartedAtMs.keys().next();
          if (!oldest.done) {
            turnStartedAtMs.delete(oldest.value);
          }
        }
      }
      return;
    }

    // Non-git workspaces never produce a checkpoint diff event, so turn
    // completion is the only settle signal there.
    if (event.type === "turn.completed") {
      yield* summarizeTurn({
        threadId: event.threadId,
        turnId: event.turnId,
        completedAt: event.createdAt,
      });
    }
  });

  const processInput = (input: ReactorInput) =>
    input.source === "domain" ? processDomainEvent(input.event) : processRuntimeEvent(input.event);

  const processInputSafely = (input: ReactorInput) =>
    processInput(input).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        // Summarization is a helper cue: it must never disturb the session.
        return Effect.logWarning("catchup summary reactor failed to process input", {
          source: input.source,
          eventType: input.event.type,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processInputSafely);

  const start: CatchupSummaryReactorShape["start"] = Effect.fn("start")(function* () {
    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        if (
          event.type !== "thread.turn-diff-completed" &&
          event.type !== "thread.catchup-summary-requested"
        ) {
          return Effect.void;
        }
        return worker.enqueue({ source: "domain", event });
      }),
    );

    yield* Effect.forkScoped(
      Stream.runForEach(providerService.streamEvents, (event) => {
        if (event.type !== "turn.started" && event.type !== "turn.completed") {
          return Effect.void;
        }
        return worker.enqueue({ source: "runtime", event });
      }),
    );
  });

  return {
    start,
    drain: worker.drain,
  } satisfies CatchupSummaryReactorShape;
});

export const CatchupSummaryReactorLive = Layer.effect(CatchupSummaryReactor, make);
