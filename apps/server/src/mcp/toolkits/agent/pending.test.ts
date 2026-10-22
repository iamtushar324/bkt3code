import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import type { Caller } from "../../threadAccess.ts";
import { loadPendingDetail, matchesRequest, requestRef } from "./pending.ts";
import type { SessionShell } from "./view.ts";

// The ids and texts of a Codex async question on bkt3 (2026-10-12), which
// t3_answer could not see: the shell only flags it.
const ASYNC_ID =
  "runtime-request:provider:codex:provider-turn:provider-turn%3Aprovider%3Acodex%3Anative-turn%3A01a12ec9-fa33-7680-9a4e-a5e0af57da87:native-request:async%3Acall_04f18b02c891414083d01ab154ff366e:9e9c4c3e-50f1-4f9e-a521-b41c3a04c7af";
const BLOCKING_ID =
  "runtime-request:provider:codex:provider-turn:provider-turn%3Aprovider%3Acodex%3Anative-turn%3A01a12ec9-fa33-7680-9a4e-a5e0af57da87:native-request:7:2b982706-8007-48e8-8e46-f0308942084c";
const ASKED = "2026-10-12T06:34:48.759Z";
const OPTION = "Prime-service starts dbt four times daily (recommended).";

const runtimeRequest = (fields: Record<string, unknown>) => ({
  nodeId: "node-1",
  providerTurnId: "provider-turn-1",
  nativeRequestRef: null,
  kind: "user_input",
  status: "pending",
  createdAt: DateTime.makeUnsafe(ASKED),
  resolvedAt: null,
  ...fields,
});

const questionItem = (requestId: string, question: string, responseMode?: "message") => ({
  id: `turn-item:${requestId}`,
  type: "user_input_request",
  status: "waiting",
  requestId,
  runId: "run-1",
  updatedAt: DateTime.makeUnsafe(ASKED),
  questions: [
    {
      id: "0",
      header: "Question",
      question,
      options: [{ label: OPTION, description: OPTION }],
    },
  ],
  ...(responseMode === undefined ? {} : { responseMode }),
});

// Only the fields the loader reads.
const shell = (fields: Partial<Record<string, unknown>>): SessionShell =>
  ({
    id: "86157111-97e0-449f-9a7e-f65b82072544",
    pendingRuntimeRequest: null,
    hasPendingAsyncUserInput: false,
    hasActionableProposedPlan: false,
    ...fields,
  }) as unknown as SessionShell;

const callerWith = (records: {
  readonly runtimeRequests: ReadonlyArray<unknown>;
  readonly turnItems: ReadonlyArray<unknown>;
  readonly runs?: ReadonlyArray<unknown>;
}) => {
  const reads: Array<unknown> = [];
  const caller = {
    threads: {
      ensureLegacyTranscript: () => Effect.void,
      getThreadRecords: (_threadId: unknown, _fields: unknown, filter: unknown) => {
        reads.push(filter);
        return Effect.succeed({ runs: [], ...records });
      },
    },
  } as unknown as Caller;
  return { caller, reads };
};

describe("loadPendingDetail", () => {
  it.effect("reads a Codex async question that the shell only flags", () =>
    Effect.gen(function* () {
      const { caller, reads } = callerWith({
        runtimeRequests: [
          runtimeRequest({ id: ASYNC_ID, responseCapability: { type: "message" } }),
          // Answered already: not open.
          runtimeRequest({
            id: "runtime-request:old:11111111-2222-3333-4444-555555555555",
            status: "resolved",
            responseCapability: { type: "message" },
          }),
        ],
        turnItems: [
          questionItem(
            ASYNC_ID,
            "TEC-1582: Which DAILY refresh trigger must I implement?",
            "message",
          ),
          questionItem(
            "runtime-request:old:11111111-2222-3333-4444-555555555555",
            "Old",
            "message",
          ),
        ],
      });
      const detail = yield* loadPendingDetail(caller, shell({ hasPendingAsyncUserInput: true }), {
        includePlan: false,
      });
      expect(reads).toEqual([{ turnItemTypes: ["user_input_request"] }]);
      expect(detail.question).toBeNull();
      expect(detail.asyncQuestions).toEqual([
        {
          requestId: ASYNC_ID,
          questions: [expect.objectContaining({ question: expect.stringContaining("DAILY") })],
          textOnly: true,
          async: true,
          askedAt: ASKED,
        },
      ]);
    }),
  );

  it.effect("keeps a blocking question apart from a non-blocking one", () =>
    Effect.gen(function* () {
      const { caller } = callerWith({
        runtimeRequests: [
          runtimeRequest({
            id: BLOCKING_ID,
            responseCapability: { type: "live", providerSessionId: "provider-session-1" },
          }),
          runtimeRequest({ id: ASYNC_ID, responseCapability: { type: "message" } }),
        ],
        turnItems: [
          questionItem(BLOCKING_ID, "Blocking?"),
          questionItem(ASYNC_ID, "Later?", "message"),
        ],
      });
      const detail = yield* loadPendingDetail(
        caller,
        shell({
          hasPendingAsyncUserInput: true,
          pendingRuntimeRequest: {
            id: BLOCKING_ID,
            kind: "user_input",
            createdAt: DateTime.makeUnsafe(ASKED),
          },
        }),
        { includePlan: false },
      );
      expect(detail.question).toMatchObject({
        requestId: BLOCKING_ID,
        async: false,
        textOnly: false,
      });
      expect(detail.asyncQuestions.map((question) => question.requestId)).toEqual([ASYNC_ID]);
    }),
  );

  it.effect("lets a question whose run failed be dismissed and answered by message", () =>
    Effect.gen(function* () {
      const { caller, reads } = callerWith({
        runtimeRequests: [
          runtimeRequest({
            id: BLOCKING_ID,
            responseCapability: { type: "live", providerSessionId: "provider-session-1" },
          }),
        ],
        turnItems: [questionItem(BLOCKING_ID, "Blocking?")],
        runs: [{ id: "run-1", status: "failed" }],
      });
      const detail = yield* loadPendingDetail(
        caller,
        shell({
          pendingRuntimeRequest: {
            id: BLOCKING_ID,
            kind: "user_input",
            createdAt: DateTime.makeUnsafe(ASKED),
          },
        }),
        { includePlan: false },
      );
      expect(reads).toContainEqual({ runIds: ["run-1"] });
      expect(detail.question).toMatchObject({
        requestId: BLOCKING_ID,
        async: true,
        textOnly: true,
      });
    }),
  );

  it.effect("keeps an approval's details while a non-blocking question is open", () =>
    Effect.gen(function* () {
      const approvalId =
        "runtime-request:codex:native-request:9:aaaaaaaa-1111-2222-3333-444444444444";
      const { caller, reads } = callerWith({
        runtimeRequests: [
          runtimeRequest({
            id: approvalId,
            kind: "command",
            responseCapability: { type: "live", providerSessionId: "provider-session-1" },
          }),
          runtimeRequest({ id: ASYNC_ID, responseCapability: { type: "message" } }),
        ],
        turnItems: [
          {
            id: `turn-item:${approvalId}`,
            type: "approval_request",
            status: "waiting",
            requestId: approvalId,
            requestKind: "command",
            title: "Run the migration",
            prompt: "It changes the schema.",
            runId: "run-1",
            updatedAt: DateTime.makeUnsafe(ASKED),
            options: [{ decision: "accept", label: "Yes" }],
          },
          questionItem(ASYNC_ID, "Later?", "message"),
        ],
      });
      const detail = yield* loadPendingDetail(
        caller,
        shell({
          hasPendingAsyncUserInput: true,
          pendingRuntimeRequest: {
            id: approvalId,
            kind: "command",
            createdAt: DateTime.makeUnsafe(ASKED),
          },
        }),
        { includePlan: false },
      );
      expect(reads[0]).toEqual({ turnItemTypes: ["user_input_request", "approval_request"] });
      expect(detail.approval).toMatchObject({
        title: "Run the migration",
        options: [{ decision: "accept", label: "Yes" }],
      });
      expect(detail.asyncQuestions.map((question) => question.requestId)).toEqual([ASYNC_ID]);
    }),
  );

  it.effect("names a secret request, which the shell stands in as a question", () =>
    Effect.gen(function* () {
      const secretId = "turn-item:provider:claudeAgent:native-item:secret-1";
      const { caller } = callerWith({
        runtimeRequests: [],
        turnItems: [
          {
            id: secretId,
            type: "secret_request",
            status: "waiting",
            label: "GitHub token",
            reason: "To open the pull request.",
            secretStatus: "pending",
            updatedAt: DateTime.makeUnsafe(ASKED),
          },
        ],
      });
      const detail = yield* loadPendingDetail(
        caller,
        shell({
          pendingRuntimeRequest: {
            id: secretId,
            kind: "user_input",
            createdAt: DateTime.makeUnsafe(ASKED),
          },
        }),
        { includePlan: false },
      );
      expect(detail.question).toBeNull();
      expect(detail.secret).toEqual({ label: "GitHub token", reason: "To open the pull request." });
    }),
  );

  it.effect("reads nothing when nothing waits", () =>
    Effect.gen(function* () {
      const { caller, reads } = callerWith({ runtimeRequests: [], turnItems: [] });
      const detail = yield* loadPendingDetail(caller, shell({}), { includePlan: false });
      expect(reads).toEqual([]);
      expect(detail.asyncQuestions).toEqual([]);
    }),
  );
});

describe("matchesRequest", () => {
  it("accepts a request id in full or in the short form t3_inbox shows", () => {
    expect(requestRef(ASYNC_ID)).toBe("9e9c4c3e");
    expect(matchesRequest(ASYNC_ID, ASYNC_ID)).toBe(true);
    expect(matchesRequest(ASYNC_ID, " 9E9C4C3E ")).toBe(true);
    expect(matchesRequest(ASYNC_ID, "2b982706")).toBe(false);
  });
});
