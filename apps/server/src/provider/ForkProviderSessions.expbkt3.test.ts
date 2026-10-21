// T3-CUSTOM(expbkt3): account policies list live sessions without reading the full shell.
import { assert, it } from "@effect/vitest";
import {
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ThreadProjection,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ProviderSessionManagerV2 } from "../orchestration-v2/ProviderSessionManager.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { ForkProviderSessions, layer } from "./ForkProviderSessions.expbkt3.ts";

const instanceId = ProviderInstanceId.make("claudeAgent");
const shared = ProviderSessionId.make("session-shared");
const solo = ProviderSessionId.make("session-solo");
const stopped = ProviderSessionId.make("session-stopped");
const first = ThreadId.make("thread-first");
const second = ThreadId.make("thread-second");
const archived = ThreadId.make("thread-archived");
const deleted = ThreadId.make("thread-deleted");
const missing = ThreadId.make("thread-missing");
const createdAt = DateTime.makeUnsafe("2026-10-21T10:00:00Z");
const updatedAt = DateTime.makeUnsafe("2026-10-21T10:05:00Z");

function providerSession(
  id: ProviderSessionId,
  overrides: Partial<OrchestrationV2ProviderSession> = {},
): OrchestrationV2ProviderSession {
  return {
    id,
    driver: ProviderDriverKind.make("claudeAgent"),
    providerInstanceId: instanceId,
    status: "ready",
    cwd: "/repo",
    model: "claude-opus-5-5",
    capabilities: {},
    createdAt,
    updatedAt,
    lastError: null,
    ...overrides,
  } as unknown as OrchestrationV2ProviderSession;
}

function records(
  threadId: ThreadId,
  providerSessions: ReadonlyArray<OrchestrationV2ProviderSession>,
  thread: {
    readonly runtimeMode?: string;
    readonly archived?: boolean;
    readonly deleted?: boolean;
  },
): OrchestrationV2ThreadProjection {
  return {
    thread: {
      id: threadId,
      runtimeMode: thread.runtimeMode ?? "full-access",
      archivedAt: thread.archived === true ? updatedAt : null,
      deletedAt: thread.deleted === true ? updatedAt : null,
    },
    providerSessions,
  } as unknown as OrchestrationV2ThreadProjection;
}

/**
 * Two live sessions: one shared by two threads, one serving an archived
 * thread, a deleted thread and a thread with no projection.
 */
function fixture() {
  const byThread = new Map<ThreadId, OrchestrationV2ThreadProjection>([
    [
      first,
      records(
        first,
        // A session the thread used before; it is no longer live.
        [
          providerSession(stopped, { status: "stopped" }),
          providerSession(shared, { status: "waiting" }),
        ],
        {},
      ),
    ],
    [
      second,
      records(
        second,
        [
          providerSession(shared, {
            status: "starting",
            model: null,
            driver: ProviderDriverKind.make("claude"),
          }),
        ],
        { runtimeMode: "approval-required" },
      ),
    ],
    [archived, records(archived, [providerSession(solo)], { archived: true })],
    [deleted, records(deleted, [providerSession(solo)], { deleted: true })],
  ]);
  const reads = { shell: 0, threads: [] as Array<ThreadId> };
  const testLayer = layer.pipe(
    Layer.provide(
      // `get` stays unimplemented: listing sessions must not count as activity on them.
      Layer.mock(ProviderSessionManagerV2)({
        listLive: () =>
          Effect.succeed([
            { providerSessionId: shared, threadIds: [first, second] },
            { providerSessionId: solo, threadIds: [archived, deleted, missing] },
          ]),
      }),
    ),
    Layer.provide(
      Layer.mock(ProjectionStore.ProjectionStoreV2)({
        getShellSnapshot: () =>
          Effect.sync(() => {
            reads.shell += 1;
          }).pipe(Effect.andThen(Effect.die("the full shell must not be read"))),
        getThreadRecords: (threadId) => {
          reads.threads.push(threadId);
          const found = byThread.get(threadId);
          return found === undefined
            ? Effect.fail(new ProjectionStore.ProjectionStoreThreadNotFoundError({ threadId }))
            : Effect.succeed(found);
        },
      }),
    ),
  );
  return { layer: testLayer, reads };
}

it.effect("lists the live sessions from the threads they serve, without the full shell", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const providers = yield* ForkProviderSessions;
    const sessions = yield* providers.listSessions();

    assert.deepEqual(sessions, [
      {
        threadId: first,
        provider: ProviderDriverKind.make("claudeAgent"),
        providerInstanceId: instanceId,
        status: "running",
        runtimeMode: "full-access",
        cwd: "/repo",
        model: "claude-opus-5-5",
        createdAt: "2026-10-21T10:00:00.000Z",
        updatedAt: "2026-10-21T10:05:00.000Z",
      },
      {
        threadId: second,
        provider: ProviderDriverKind.make("claudeAgent"),
        providerInstanceId: instanceId,
        status: "connecting",
        runtimeMode: "approval-required",
        cwd: "/repo",
        createdAt: "2026-10-21T10:00:00.000Z",
        updatedAt: "2026-10-21T10:05:00.000Z",
      },
      {
        threadId: archived,
        provider: ProviderDriverKind.make("claudeAgent"),
        providerInstanceId: instanceId,
        status: "ready",
        runtimeMode: "full-access",
        cwd: "/repo",
        model: "claude-opus-5-5",
        createdAt: "2026-10-21T10:00:00.000Z",
        updatedAt: "2026-10-21T10:05:00.000Z",
      },
    ]);
    assert.equal(f.reads.shell, 0);
    // Only the threads a live session serves, each once.
    assert.deepEqual(f.reads.threads, [first, second, archived, deleted, missing]);
  }).pipe(Effect.provide(f.layer));
});
