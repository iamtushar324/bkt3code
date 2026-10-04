/** T3-CUSTOM(expbkt3): native webhook tools retain verified external-user and read-only boundaries. */
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  UserId,
  type SessionWebhookView,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { Tool } from "effect/unstable/ai";
import {
  McpInvocationContext,
  type McpCapability,
  type McpInvocationScope,
} from "../mcp/McpInvocationContext.ts";
import { SessionWebhookService } from "./SessionWebhookService.ts";
import { SessionWebhookHandlersLive, SessionWebhookToolkit } from "./mcp.ts";

const owner = UserId.make("webhook-tool-owner");
const currentSession = ThreadId.make("webhook-current-session");
const alternativeSession = ThreadId.make("webhook-alternative-session");
const webhookId = `swh_${"a".repeat(32)}`;
const scope = (
  principal: McpInvocationScope["principal"] = "provider-session",
  capabilities: ReadonlyArray<McpCapability> = ["t3.read", "t3.control"],
): McpInvocationScope => ({
  principal,
  actorUserId: principal === "external-operator" ? null : owner,
  environmentId: EnvironmentId.make("webhook-tool-environment"),
  threadId:
    principal === "provider-session" ? currentSession : ThreadId.make(`external-user:${owner}`),
  providerSessionId: "webhook-tool-provider-session",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(capabilities),
  issuedAt: 1,
});
const fixture = (threadId = currentSession) =>
  ({
    id: webhookId,
    threadId,
    instanceId: "toolyard-instance",
    callbackRef: "cb_opaque",
    status: "active",
    revision: 1,
    createdAt: "2026-10-04T00:00:00Z",
    updatedAt: "2026-10-04T00:00:00Z",
    terminalReason: null,
    deliveries: [],
    deliveryHistory: [],
    deliveryHistoryError: null,
  }) satisfies SessionWebhookView;
const harness = Effect.gen(function* () {
  const operations: Array<{
    operation: string;
    owner: UserId;
    destination?: ThreadId;
    id?: string;
    revision?: number;
    allowedThreadId?: ThreadId;
  }> = [];
  const dependencies = Layer.mock(SessionWebhookService)({
    create: (userId, threadId) =>
      Effect.sync(() => {
        operations.push({ operation: "create", owner: userId, destination: threadId });
        return fixture(threadId);
      }),
    inspect: (userId, id, allowedThreadId) =>
      Effect.sync(() => {
        operations.push({
          operation: "inspect",
          owner: userId,
          id,
          ...(allowedThreadId === undefined ? {} : { allowedThreadId }),
        });
        return fixture();
      }),
    update: (userId, id, action, revision, allowedThreadId) =>
      Effect.sync(() => {
        operations.push({
          operation: action,
          owner: userId,
          id,
          revision,
          ...(allowedThreadId === undefined ? {} : { allowedThreadId }),
        });
        return fixture();
      }),
  });
  const toolkit = yield* SessionWebhookToolkit.pipe(
    Effect.provide(SessionWebhookHandlersLive.pipe(Layer.provide(dependencies))),
  );
  const call = <Name extends keyof typeof SessionWebhookToolkit.tools>(
    name: Name,
    input: Parameters<typeof toolkit.handle<Name>>[1],
    invocation = scope(),
  ) =>
    toolkit.handle(name, input).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.map((chunks) => chunks.at(-1)!.result),
      Effect.provideService(McpInvocationContext, invocation),
      Effect.provide(dependencies),
    );
  return { operations, call };
});
const writes = [
  "t3_session_webhook_disable",
  "t3_session_webhook_rotate",
  "t3_session_webhook_remove",
] as const;

it.effect(
  "provider creation defaults to the requesting session and permits an explicit service-checked destination",
  () =>
    Effect.gen(function* () {
      const h = yield* harness;
      expect(yield* h.call("t3_session_webhook_create", {})).toMatchObject({
        threadId: currentSession,
      });
      expect(
        yield* h.call(
          "t3_session_webhook_create",
          { sessionId: alternativeSession },
          scope("provider-session", ["t3.read", "t3.control", "t3.session.create"]),
        ),
      ).toMatchObject({ threadId: alternativeSession });
      expect(h.operations).toEqual([
        { operation: "create", owner, destination: currentSession },
        { operation: "create", owner, destination: alternativeSession },
      ]);
    }),
);

it.effect(
  "a thread-bound provider accepts its own explicit destination and denies another session",
  () =>
    Effect.gen(function* () {
      const h = yield* harness;
      expect(
        yield* h.call("t3_session_webhook_create", { sessionId: currentSession }),
      ).toMatchObject({ threadId: currentSession });
      expect(
        yield* h.call("t3_session_webhook_create", { sessionId: alternativeSession }),
      ).toMatchObject({
        code: "invalid_request",
        message: "An in-session agent may only control its own T3 session.",
      });
      expect(h.operations).toEqual([{ operation: "create", owner, destination: currentSession }]);
    }),
);

it.effect(
  "verified external-user tools accept native control capabilities without orchestration",
  () =>
    Effect.gen(function* () {
      const h = yield* harness;
      const external = scope("external-user");
      expect(
        yield* h.call("t3_session_webhook_create", { sessionId: alternativeSession }, external),
      ).toMatchObject({ callbackRef: "cb_opaque", threadId: alternativeSession });
      for (const name of writes) {
        expect(yield* h.call(name, { id: webhookId, expectedRevision: 1 }, external)).toMatchObject(
          { id: webhookId },
        );
      }
      expect(h.operations).toEqual([
        { operation: "create", owner, destination: alternativeSession },
        ...["disable", "rotate", "remove"].map((operation) => ({
          operation,
          owner,
          id: webhookId,
          revision: 1,
        })),
      ]);
    }),
);

it.effect("external-user creation requires a real explicit destination", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    expect(yield* h.call("t3_session_webhook_create", {}, scope("external-user"))).toMatchObject({
      code: "invalid_request",
      message: "sessionId is required for an external user webhook destination.",
    });
    expect(h.operations).toEqual([]);
  }),
);

it.effect("read-only credentials cannot create or change webhooks", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    const readOnly = scope("provider-session", ["t3.read"]);
    expect(yield* h.call("t3_session_webhook_create", {}, readOnly)).toMatchObject({
      code: "capability_denied",
    });
    for (const name of writes) {
      expect(yield* h.call(name, { id: webhookId, expectedRevision: 1 }, readOnly)).toMatchObject({
        code: "capability_denied",
      });
    }
    expect(h.operations).toEqual([]);
  }),
);

it.effect("read-only owner credentials can inspect authoritative webhook status", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    expect(
      yield* h.call(
        "t3_session_webhook_inspect",
        { id: webhookId },
        scope("external-user", ["t3.read"]),
      ),
    ).toMatchObject({ id: webhookId, callbackRef: "cb_opaque" });
    expect(h.operations).toEqual([{ operation: "inspect", owner, id: webhookId }]);
  }),
);

it.effect(
  "a thread-bound provider constrains inspection and lifecycle operations to its current session",
  () =>
    Effect.gen(function* () {
      const h = yield* harness;
      yield* h.call("t3_session_webhook_inspect", { id: webhookId });
      for (const name of writes) yield* h.call(name, { id: webhookId, expectedRevision: 1 });
      expect(h.operations).toEqual([
        { operation: "inspect", owner, id: webhookId, allowedThreadId: currentSession },
        ...["disable", "rotate", "remove"].map((operation) => ({
          operation,
          owner,
          id: webhookId,
          revision: 1,
          allowedThreadId: currentSession,
        })),
      ]);
    }),
);

it.effect("a user-wide provider retains service-authorized access to its webhooks", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    const userWide = scope("provider-session", ["t3.read", "t3.control", "t3.session.create"]);
    yield* h.call("t3_session_webhook_inspect", { id: webhookId }, userWide);
    for (const name of writes)
      yield* h.call(name, { id: webhookId, expectedRevision: 1 }, userWide);
    expect(h.operations).toEqual([
      { operation: "inspect", owner, id: webhookId },
      ...["disable", "rotate", "remove"].map((operation) => ({
        operation,
        owner,
        id: webhookId,
        revision: 1,
      })),
    ]);
  }),
);

it.effect("unowned external-operator credentials cannot manage or inspect user webhooks", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    const operator = scope("external-operator");
    expect(
      yield* h.call("t3_session_webhook_create", { sessionId: alternativeSession }, operator),
    ).toMatchObject({ code: "capability_denied" });
    expect(yield* h.call("t3_session_webhook_inspect", { id: webhookId }, operator)).toMatchObject({
      code: "capability_denied",
    });
    for (const name of writes) {
      expect(yield* h.call(name, { id: webhookId, expectedRevision: 1 }, operator)).toMatchObject({
        code: "capability_denied",
      });
    }
    expect(h.operations).toEqual([]);
  }),
);

it("exports the actual webhook tool names and object schemas without signing material", () => {
  expect(Object.keys(SessionWebhookToolkit.tools)).toEqual([
    "t3_session_webhook_create",
    "t3_session_webhook_inspect",
    ...writes,
  ]);
  for (const tool of Object.values(SessionWebhookToolkit.tools)) {
    const schema = Tool.getJsonSchema(tool) as {
      type?: string;
      properties?: Record<string, unknown>;
      required?: string[];
    };
    expect(schema.type).toBe("object");
    expect(Object.keys(schema.properties ?? {})).toEqual(
      tool.name === "t3_session_webhook_create"
        ? ["sessionId"]
        : tool.name === "t3_session_webhook_inspect"
          ? ["id"]
          : ["id", "expectedRevision"],
    );
    expect(schema.required ?? []).toEqual(
      tool.name === "t3_session_webhook_create"
        ? []
        : tool.name === "t3_session_webhook_inspect"
          ? ["id"]
          : ["id", "expectedRevision"],
    );
  }
  expect(SessionWebhookToolkit.tools.t3_session_webhook_create.description).toContain(
    "external user agents must supply sessionId",
  );
});
