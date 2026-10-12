/**
 * T3-CUSTOM(expbkt3): the details of what a session waits on.
 *
 * The shell says that a session waits; this reads what for, from the
 * session's own records filtered to the few turn items that matter: the open
 * question and its options, the open approval and its decisions, the
 * questions the agent asked while it kept working, and the newest plan.
 *
 * A question blocks the agent when its provider holds the turn open for the
 * answer. A non-blocking one (a Codex `delivery: "async"` question, or an
 * older fork activity question) did not stop the agent: the answer reaches it
 * as a new message, and a person may dismiss the question instead. The shell
 * leaves non-blocking requests out of `pendingRuntimeRequest`, so they are
 * read from the session's runtime requests whenever it flags one.
 */
import {
  type OrchestrationV2TurnItem,
  type ProviderApprovalDecision,
  type RunId,
  UserInputRequestedPayload,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { findForkAsyncRequest } from "../../../orchestration-v2/forkAsyncResponse.expbkt3.ts";
import type { Caller } from "../../threadAccess.ts";
import type { QuestionView } from "./answers.ts";
import { shortRef, toIso, type SessionShell } from "./view.ts";

export interface PendingQuestion {
  readonly requestId: string;
  readonly questions: ReadonlyArray<QuestionView>;
  /** The request resumes the agent with a message, so each answer must be text. */
  readonly textOnly: boolean;
  /** Non-blocking: asked while the agent kept working; the answer arrives as a new message. */
  readonly async: boolean;
  readonly askedAt: string | null;
}

/** The short form of a request id that t3_answer accepts: the first 8 characters of its last UUID. */
export const requestRef = (requestId: string): string => shortRef(requestId);

/** Whether `ref` names this request, by its full id or its short form. */
export const matchesRequest = (requestId: string, ref: string): boolean => {
  const wanted = ref.trim();
  return requestId === wanted || requestRef(requestId) === wanted.toLowerCase();
};

export interface ApprovalOptionView {
  readonly decision: ProviderApprovalDecision;
  readonly label: string;
  readonly warning?: string | undefined;
}

export interface PendingApproval {
  readonly requestId: string;
  readonly requestKind: string;
  readonly title: string | null;
  readonly prompt: string | null;
  readonly appName: string | null;
  /** The exact command or file the request is about, when the run's tool item names it. */
  readonly command: string | null;
  readonly file: string | null;
  readonly options: ReadonlyArray<ApprovalOptionView>;
  readonly askedAt: string | null;
}

export interface PendingPlan {
  readonly markdown: string;
  readonly proposedAt: string | null;
  /** The run that proposed it; a plan from an older run was answered or set aside. */
  readonly runId: string | null;
}

/**
 * Whether the plan still waits for review. The shell keeps a plan flagged
 * after it was approved and carried out, and after the agent answered a
 * revision in chat; in both cases a newer run followed the one that proposed it.
 */
export const planIsCurrent = (shell: SessionShell, plan: PendingPlan | null): boolean =>
  plan === null || plan.runId === null || plan.runId === shell.latestRunId;

/** A secret the agent asked for; only a person can enter it, in the app. */
export interface PendingSecret {
  readonly label: string;
  readonly reason: string;
}

export interface PendingDetail {
  readonly question: PendingQuestion | null;
  readonly asyncQuestions: ReadonlyArray<PendingQuestion>;
  readonly approval: PendingApproval | null;
  readonly secret: PendingSecret | null;
  readonly plan: PendingPlan | null;
}

export const EMPTY_PENDING: PendingDetail = {
  question: null,
  asyncQuestions: [],
  approval: null,
  secret: null,
  plan: null,
};

/** The choices a provider offers when it names none. */
const DEFAULT_APPROVAL_OPTIONS: ReadonlyArray<ApprovalOptionView> = [
  { decision: "accept", label: "Approve once" },
  { decision: "acceptForSession", label: "Approve for this session" },
  { decision: "decline", label: "Deny" },
  { decision: "cancel", label: "Cancel the turn" },
];

const decodeAsyncPayload = Schema.decodeUnknownOption(UserInputRequestedPayload);

const UNFINISHED_ITEM_STATUSES: ReadonlySet<string> = new Set([
  "idle",
  "pending",
  "running",
  "waiting",
]);

/** The command or file an open approval is about: the newest unfinished tool item of its run. */
const approvalSubject = (caller: Caller, shell: SessionShell, runId: RunId | null) =>
  runId === null
    ? Effect.succeed({ command: null, file: null })
    : caller.threads
        .getThreadRecords(shell.id, ["turnItems"], {
          turnItemTypes: ["command_execution", "file_change"],
          turnItemRunIds: [runId],
        })
        .pipe(
          Effect.map(({ turnItems }) => {
            const open = turnItems
              .filter((item) => UNFINISHED_ITEM_STATUSES.has(item.status))
              .toSorted(
                (left, right) =>
                  right.updatedAt.epochMilliseconds - left.updatedAt.epochMilliseconds,
              )[0];
            return {
              command: open?.type === "command_execution" ? open.input : null,
              file: open?.type === "file_change" ? open.fileName : null,
            };
          }),
          Effect.orElseSucceed(() => ({ command: null, file: null })),
        );

type TurnItemType = OrchestrationV2TurnItem["type"];

/**
 * Reads the details for the waits the shell reports. `includePlan` also reads
 * the newest proposed plan, which only a plan review needs.
 */
export const loadPendingDetail = Effect.fn("agentToolkit.loadPendingDetail")(function* (
  caller: Caller,
  shell: SessionShell,
  options: { readonly includePlan: boolean },
) {
  const request = shell.pendingRuntimeRequest;
  const asyncIds = shell.pendingAsyncUserInputIds ?? [];
  const nonBlocking = shell.hasPendingAsyncUserInput === true;
  const types = new Set<TurnItemType>();
  if (request?.kind === "user_input" || nonBlocking) types.add("user_input_request");
  // The shell stands a secret request in as a pending question.
  if (request?.kind === "user_input") types.add("secret_request");
  if (request !== null && request.kind !== "user_input" && request.kind !== "auth_refresh") {
    types.add("approval_request");
  }
  if (asyncIds.length > 0) types.add("dynamic_tool");
  if (options.includePlan && shell.hasActionableProposedPlan) types.add("proposed_plan");
  if (types.size === 0) return EMPTY_PENDING;

  const records = yield* caller.threads
    .getThreadRecords(shell.id, ["runtimeRequests", "turnItems"], {
      turnItemTypes: [...types],
    })
    .pipe(Effect.option);
  if (Option.isNone(records)) return EMPTY_PENDING;
  const { runtimeRequests, turnItems } = records.value;

  let question: PendingQuestion | null = null;
  let approval: PendingApproval | null = null;
  let secret: PendingSecret | null = null;
  if (request !== null) {
    const runtime = runtimeRequests.find((candidate) => candidate.id === request.id);
    const item = turnItems.find(
      (candidate) =>
        (candidate.type === "user_input_request" || candidate.type === "approval_request") &&
        candidate.requestId === request.id,
    );
    // The stand-in's id is the secret item's turn item id.
    const standInId: string = request.id;
    const secretItem = turnItems.find(
      (candidate) => candidate.type === "secret_request" && candidate.id === standInId,
    );
    if (secretItem?.type === "secret_request") {
      secret = { label: secretItem.label, reason: secretItem.reason };
    } else if (item?.type === "user_input_request") {
      question = {
        requestId: request.id,
        questions: item.questions,
        textOnly: runtime?.responseCapability.type === "message" || item.responseMode === "message",
        async: false,
        askedAt: toIso(request.createdAt),
      };
    } else if (item?.type === "approval_request") {
      // The approval item carries the agent's description; the tool item of
      // the same run that still runs carries the exact command or file.
      const subject = yield* approvalSubject(caller, shell, item.runId);
      approval = {
        requestId: request.id,
        requestKind: item.requestKind,
        title: item.title,
        prompt: item.prompt ?? null,
        appName: item.appName ?? null,
        ...subject,
        options:
          item.options === undefined || item.options.length === 0
            ? DEFAULT_APPROVAL_OPTIONS
            : item.options,
        askedAt: toIso(request.createdAt),
      };
    } else if (request.kind !== "user_input" && request.kind !== "auth_refresh") {
      approval = {
        requestId: request.id,
        requestKind: request.kind,
        title: null,
        prompt: null,
        appName: null,
        command: null,
        file: null,
        options: DEFAULT_APPROVAL_OPTIONS,
        askedAt: toIso(request.createdAt),
      };
    }
  }

  // Requests that resume the agent with a message: a Codex async question.
  const messageQuestions = runtimeRequests
    .filter(
      (runtime) =>
        runtime.status === "pending" &&
        runtime.kind === "user_input" &&
        runtime.responseCapability.type === "message",
    )
    .toSorted((left, right) => left.createdAt.epochMilliseconds - right.createdAt.epochMilliseconds)
    .flatMap((runtime): ReadonlyArray<PendingQuestion> => {
      const item = turnItems.find(
        (candidate) =>
          candidate.type === "user_input_request" && candidate.requestId === runtime.id,
      );
      if (item?.type !== "user_input_request") return [];
      return [
        {
          requestId: runtime.id,
          questions: item.questions,
          textOnly: true,
          async: true,
          askedAt: toIso(runtime.createdAt),
        },
      ];
    });

  // Older fork activity questions, listed on the session itself.
  const activityQuestions = asyncIds.flatMap((requestId): ReadonlyArray<PendingQuestion> => {
    const activity = findForkAsyncRequest(turnItems, requestId);
    if (activity?.kind !== "user-input.requested") return [];
    const payload = decodeAsyncPayload(activity.payload);
    if (Option.isNone(payload)) return [];
    return [
      {
        requestId,
        questions: payload.value.questions,
        textOnly: true,
        async: true,
        askedAt: activity.createdAt,
      },
    ];
  });

  const asyncQuestions = [
    ...messageQuestions,
    ...activityQuestions.filter(
      (candidate) => !messageQuestions.some((other) => other.requestId === candidate.requestId),
    ),
  ];

  // Ordinals restart in every run, so the newest plan is the newest update.
  const planItem = turnItems
    .filter((item) => item.type === "proposed_plan")
    .toSorted(
      (left, right) => right.updatedAt.epochMilliseconds - left.updatedAt.epochMilliseconds,
    )[0];
  const plan =
    planItem?.type === "proposed_plan"
      ? {
          markdown: planItem.markdown,
          proposedAt: toIso(planItem.updatedAt),
          runId: planItem.runId,
        }
      : null;

  return { question, asyncQuestions, approval, secret, plan } satisfies PendingDetail;
});
