/**
 * T3-CUSTOM(expbkt3): Bulk session manager work summary reactor.
 *
 * Consumes `thread.work-summary-requested`, renders the session's context,
 * asks the configured model for a work summary plus an assigned progress, and
 * dispatches the result back as `thread.work-summary.update`.
 *
 * Every failure path still dispatches a terminal update. A row in the bulk
 * table shows a spinner from the moment the request is projected, so a request
 * that silently gives up is indistinguishable from one still running — the
 * operator would wait forever on a session that will never answer.
 */
import {
  CommandId,
  TextGenerationError,
  type OrchestrationEvent,
  type OrchestrationThread,
  type SessionWorkSummarySettings,
  type ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";

import { ServerSettingsService } from "../../serverSettings.ts";
import * as TextGeneration from "../../textGeneration/TextGeneration.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  WorkSummaryReactor,
  type WorkSummaryReactorShape,
} from "../Services/WorkSummaryReactor.ts";

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

/** A bulk run must not be held up indefinitely by one wedged provider call. */
const WORK_SUMMARY_TIMEOUT = "120 seconds";

const WORK_SUMMARY_ERROR_FALLBACK =
  "The summarizer did not return a result. Check the selected model and try again.";
const WORK_SUMMARY_DISABLED_MESSAGE =
  "Session work summaries are turned off in Settings → Experiments.";
const WORK_SUMMARY_EMPTY_SESSION_MESSAGE = "This session has no conversation to summarize yet.";
/**
 * An archived session is not in the detail read model and its worktree may be
 * reclaimed, so there is nothing to summarize. Say so instead of returning
 * quietly: the projector already wrote a `pending` marker, and only a terminal
 * update clears the table's "Summarizing…" spinner.
 */
const WORK_SUMMARY_NO_CONTEXT_MESSAGE =
  "This session is archived, so it is no longer available to summarize.";
const MAX_WORK_SUMMARY_ERROR_CHARS = 500;

/** Hard cap for providers that ignore the requested spoken-summary length. */
export function limitWorkSummaryWords(summary: string, maxWords: number): string {
  const words = summary.trim().split(/\s+/u).filter(Boolean);
  if (words.length <= maxWords) return words.join(" ");
  return `${words
    .slice(0, maxWords)
    .join(" ")
    .replace(/[,:;.!?]+$/u, "")}…`;
}

const isTextGenerationError = Schema.is(TextGenerationError);

/** Leaves room for the prompt's own rules inside the configured budget. */
const CONTEXT_HEADROOM_CHARS = 2_000;

/**
 * Keep provider failures useful in the table cell without forwarding defects,
 * stack traces, or arbitrarily large CLI output to the browser.
 */
export function workSummaryFailureMessage(cause: Cause.Cause<unknown>): string {
  const failure = Cause.findErrorOption(cause);
  const detail =
    Option.isSome(failure) && isTextGenerationError(failure.value)
      ? failure.value.detail.trim()
      : "";
  return detail.length > 0
    ? detail.slice(0, MAX_WORK_SUMMARY_ERROR_CHARS)
    : WORK_SUMMARY_ERROR_FALLBACK;
}

/**
 * Render the whole session as a plain transcript for the summarizer.
 *
 * The rolling catch-up summary is included when the catch-up pipeline happens
 * to have produced one — it is a cheap, already-condensed record of the early
 * turns — but nothing here depends on it: a session with catch-up summaries
 * disabled still summarizes correctly from its transcript alone.
 *
 * The tail is kept rather than the head. What a session most recently did
 * decides its stage and percentage; how it opened is usually restated in the
 * title anyway.
 */
export function buildSessionContext(thread: OrchestrationThread, dataLimitChars: number): string {
  const transcriptBudget = Math.max(1_000, dataLimitChars - CONTEXT_HEADROOM_CHARS);

  const transcript = thread.messages
    .filter((message) => message.text.trim().length > 0)
    .map((message) => `${message.role}: ${message.text}`)
    .join("\n\n");

  const boundedTranscript =
    transcript.length <= transcriptBudget
      ? transcript
      : `[earlier turns truncated]\n\n${transcript.slice(transcript.length - transcriptBudget)}`;

  return [
    `Session title: ${thread.title}`,
    `Session state: ${thread.archivedAt !== null ? "archived" : "active"}; latest turn ${
      thread.latestTurn?.state ?? "none"
    }`,
    "",
    ...(thread.rollingSummary !== null && thread.rollingSummary.trim().length > 0
      ? ["Condensed history of earlier turns:", thread.rollingSummary.trim(), ""]
      : []),
    "Transcript:",
    boundedTranscript.length > 0 ? boundedTranscript : "(no messages yet)",
  ].join("\n");
}

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const serverCommandId = (tag: string) =>
    crypto.randomUUIDv4.pipe(Effect.map((uuid) => CommandId.make(`server:${tag}:${uuid}`)));
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const serverSettingsService = yield* ServerSettingsService;
  const textGeneration = yield* TextGeneration.TextGeneration;

  /**
   * Threads whose generation is currently running. A duplicate request for a
   * thread already in flight is dropped rather than queued: the worker is
   * serial, so a bulk double-selection reaches this guard only when the same
   * thread is already being answered, and the queued newer request resolves the
   * row when the worker reaches it.
   */
  const inFlightThreadIds = new Set<ThreadId>();

  const dispatchUpdate = Effect.fn("dispatchWorkSummaryUpdate")(function* (input: {
    readonly threadId: ThreadId;
    readonly requestId: CommandId;
    readonly result:
      | {
          readonly status: "ready";
          readonly summary: string;
          readonly stage: "planning" | "implementing" | "blocked" | "awaiting-review" | "done";
          readonly remaining: string;
          readonly percent: number;
        }
      | { readonly status: "error"; readonly error: string };
  }) {
    const updatedAt = yield* nowIso;
    yield* orchestrationEngine.dispatch({
      type: "thread.work-summary.update",
      commandId: yield* serverCommandId("work-summary"),
      threadId: input.threadId,
      requestId: input.requestId,
      workSummary:
        input.result.status === "ready"
          ? {
              status: "ready",
              summary: input.result.summary,
              stage: input.result.stage,
              remaining: input.result.remaining,
              percent: input.result.percent,
              error: null,
              requestId: input.requestId,
              updatedAt,
            }
          : {
              status: "error",
              summary: null,
              stage: null,
              remaining: null,
              percent: null,
              error: input.result.error,
              requestId: input.requestId,
              updatedAt,
            },
      createdAt: updatedAt,
    });
  });

  const summarizeThread = Effect.fn("summarizeThreadWork")(function* (input: {
    readonly threadId: ThreadId;
    readonly requestId: CommandId;
  }) {
    const settings = yield* serverSettingsService.getSettings;
    const workSummary: SessionWorkSummarySettings = settings.experimental.sessionWorkSummary;

    // Report the disabled state instead of returning quietly: the request event
    // already put a spinner on the row, and only a terminal update clears it.
    if (!workSummary.enabled) {
      yield* dispatchUpdate({
        threadId: input.threadId,
        requestId: input.requestId,
        result: { status: "error", error: WORK_SUMMARY_DISABLED_MESSAGE },
      });
      return;
    }

    // Archived threads are excluded from the detail read, so this is the path a
    // request against an archived session takes. The projector has already put a
    // spinner on the row, so resolve it: returning quietly here left archived
    // rows spinning on "Summarizing…" forever on expbkt3.
    const threadOption = yield* projectionSnapshotQuery.getThreadDetailById(input.threadId, {
      // Summaries read messages and turns only; skip every activity payload.
      activityKinds: [],
    });
    if (Option.isNone(threadOption)) {
      yield* dispatchUpdate({
        threadId: input.threadId,
        requestId: input.requestId,
        result: { status: "error", error: WORK_SUMMARY_NO_CONTEXT_MESSAGE },
      });
      return;
    }
    const thread = threadOption.value;

    // Collapse a bulk double-selection. The projector installs the newest
    // request id as the pending marker the moment its event lands, so by the
    // time the queue reaches an older request the row already belongs to a
    // newer one. Generating anyway would spend a second model call on the same
    // session state and produce a result the projector would then discard.
    const currentRequestId = thread.workSummary?.requestId ?? null;
    if (currentRequestId !== null && currentRequestId !== input.requestId) {
      return;
    }

    const contextOption = yield* projectionSnapshotQuery.getThreadCheckpointContext(input.threadId);
    if (Option.isNone(contextOption)) {
      yield* dispatchUpdate({
        threadId: input.threadId,
        requestId: input.requestId,
        result: { status: "error", error: WORK_SUMMARY_NO_CONTEXT_MESSAGE },
      });
      return;
    }
    const cwd = contextOption.value.worktreePath ?? contextOption.value.workspaceRoot;

    const context = buildSessionContext(thread, workSummary.dataLimitChars);
    if (thread.messages.every((message) => message.text.trim().length === 0)) {
      yield* dispatchUpdate({
        threadId: input.threadId,
        requestId: input.requestId,
        result: { status: "error", error: WORK_SUMMARY_EMPTY_SESSION_MESSAGE },
      });
      return;
    }

    yield* Effect.gen(function* () {
      const lengthInstruction = `Keep the summary to at most ${workSummary.maxWords} words so it can be read aloud.`;
      const promptInstructions = [lengthInstruction, workSummary.promptInstructions]
        .filter((value) => value.trim().length > 0)
        .join("\n");
      const generated = yield* textGeneration
        .generateWorkSummary({
          cwd,
          context,
          modelSelection: workSummary.modelSelection,
          promptInstructions,
        })
        .pipe(Effect.timeout(WORK_SUMMARY_TIMEOUT));

      const summary = limitWorkSummaryWords(generated.summary, workSummary.maxWords);
      yield* dispatchUpdate({
        threadId: input.threadId,
        requestId: input.requestId,
        result:
          summary.length > 0
            ? {
                status: "ready",
                summary,
                stage: generated.stage,
                remaining: generated.remaining,
                percent: generated.percent,
              }
            : { status: "error", error: WORK_SUMMARY_ERROR_FALLBACK },
      });
    }).pipe(
      Effect.tapCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : // Replace the spinner, then let the worker log the failure.
            dispatchUpdate({
              threadId: input.threadId,
              requestId: input.requestId,
              result: { status: "error", error: workSummaryFailureMessage(cause) },
            }).pipe(Effect.catch(() => Effect.void)),
      ),
    );
  });

  const processRequest = Effect.fn("processWorkSummaryRequest")(function* (
    event: Extract<OrchestrationEvent, { type: "thread.work-summary-requested" }>,
  ) {
    const threadId = event.payload.threadId;
    if (inFlightThreadIds.has(threadId)) {
      return;
    }
    inFlightThreadIds.add(threadId);
    yield* summarizeThread({ threadId, requestId: event.payload.requestId }).pipe(
      // A finalizer, not a trailing statement: an interrupted or failed run must
      // still release the thread or it could never be summarized again.
      Effect.ensuring(Effect.sync(() => inFlightThreadIds.delete(threadId))),
    );
  });

  const processRequestSafely = (
    event: Extract<OrchestrationEvent, { type: "thread.work-summary-requested" }>,
  ) =>
    processRequest(event).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        // Summaries are an operator convenience: never disturb the session.
        return Effect.logWarning("work summary reactor failed to process request", {
          threadId: event.payload.threadId,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processRequestSafely);

  const start: WorkSummaryReactorShape["start"] = Effect.fn("start")(function* () {
    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) =>
        event.type === "thread.work-summary-requested" ? worker.enqueue(event) : Effect.void,
      ),
    );
  });

  return {
    start,
    drain: worker.drain,
  } satisfies WorkSummaryReactorShape;
});

export const WorkSummaryReactorLive = Layer.effect(WorkSummaryReactor, make);
