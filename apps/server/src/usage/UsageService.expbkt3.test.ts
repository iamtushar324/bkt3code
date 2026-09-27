// @effect-diagnostics nodeBuiltinImport:off - seeds real transcript trees on disk.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@t3tools/contracts";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  listThreadTranscriptFiles,
  THREAD_USAGE_PERSIST_INTERVAL_MS,
} from "./threadTranscriptFiles.expbkt3.ts";
import * as UsageService from "./UsageService.ts";

const claudeLine = (id: number, sessionId: string, outputTokens: number) =>
  `${JSON.stringify({
    type: "assistant",
    timestamp: "2026-08-01T10:00:00Z",
    requestId: `req_${sessionId}_${id}`,
    sessionId,
    message: {
      id: `msg_${sessionId}_${id}`,
      model: "claude-fable-5",
      usage: { input_tokens: 10, output_tokens: outputTokens },
    },
  })}\n`;

/** A Claude home with the thread's session, one subagent, and an unrelated session. */
const seedHome = Effect.gen(function* () {
  const home = yield* Effect.promise(() =>
    NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "usage-thread-expbkt3-")),
  );
  yield* Effect.addFinalizer(() =>
    Effect.promise(() => NodeFSP.rm(home, { recursive: true, force: true })),
  );
  const projects = NodePath.join(home, "claude", "projects");
  const main = NodePath.join(projects, "proj-a", "session-1.jsonl");
  yield* Effect.promise(async () => {
    await NodeFSP.mkdir(NodePath.join(projects, "proj-a", "session-1", "subagents"), {
      recursive: true,
    });
    await NodeFSP.mkdir(NodePath.join(projects, "proj-b"), { recursive: true });
    await NodeFSP.writeFile(main, claudeLine(1, "session-1", 5));
    await NodeFSP.writeFile(
      NodePath.join(projects, "proj-a", "session-1", "subagents", "agent-1.jsonl"),
      claudeLine(2, "session-1", 7),
    );
    await NodeFSP.writeFile(
      NodePath.join(projects, "proj-b", "session-2.jsonl"),
      claudeLine(3, "session-2", 100),
    );
    const codex = NodePath.join(home, "codex", "sessions", "2026", "08", "01");
    await NodeFSP.mkdir(codex, { recursive: true });
    await NodeFSP.writeFile(NodePath.join(codex, "rollout-2026-08-01T10-00-00-thread-a.jsonl"), "");
    await NodeFSP.writeFile(NodePath.join(codex, "rollout-2026-08-01T11-00-00-thread-b.jsonl"), "");
  });
  return { home, projects, main };
});

const serviceLayer = (home: string, prefix: string) =>
  UsageService.layer.pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix })),
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(
      ServerSettings.layerTest({
        providers: {
          claudeAgent: { homePath: NodePath.join(home, "claude") },
          codex: { homePath: NodePath.join(home, "codex") },
        },
      }),
    ),
    Layer.provideMerge(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({}))),
        ),
      ),
    ),
    Layer.provideMerge(
      Layer.succeed(HostProcessEnvironment, { GROK_HOME: NodePath.join(home, "grok") }),
    ),
  );

const scanCacheText = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  return yield* Effect.promise(() =>
    NodeFSP.readFile(NodePath.join(config.stateDir, "usage-scan-cache.json"), "utf8").catch(
      () => null,
    ),
  );
});

const readThread = Effect.gen(function* () {
  const usage = yield* UsageService.UsageService;
  return yield* usage.readThreadUsage({
    threadId: ThreadId.make("thread-1"),
    sessionIds: ["session-1"],
    sinceMs: Date.parse("2026-07-01T00:00:00Z"),
    timeZone: "UTC",
  });
});

describe("listThreadTranscriptFiles", () => {
  it.effect("lists only the thread's own Claude and Codex transcripts", () =>
    Effect.gen(function* () {
      const { home, projects } = yield* seedHome;
      const claude = yield* Effect.promise(() =>
        listThreadTranscriptFiles({
          provider: "claude",
          dir: projects,
          sessionIds: ["session-1"],
          sinceMs: 0,
        }),
      );
      assert.deepStrictEqual(claude.map((file) => NodePath.relative(projects, file.path)).sort(), [
        "proj-a/session-1.jsonl",
        "proj-a/session-1/subagents/agent-1.jsonl",
      ]);
      const codex = yield* Effect.promise(() =>
        listThreadTranscriptFiles({
          provider: "codex",
          dir: NodePath.join(home, "codex", "sessions"),
          sessionIds: ["thread-b"],
          sinceMs: 0,
        }),
      );
      assert.deepStrictEqual(
        codex.map((file) => NodePath.basename(file.path)),
        ["rollout-2026-08-01T11-00-00-thread-b.jsonl"],
      );
      const none = yield* Effect.promise(() =>
        listThreadTranscriptFiles({
          provider: "claude",
          dir: projects,
          sessionIds: [],
          sinceMs: 0,
        }),
      );
      assert.strictEqual(none.length, 0);
    }),
  );
});

describe("UsageService.readThreadUsage (expbkt3)", () => {
  it.effect("counts the thread's session and subagents, and debounces the cache write", () =>
    Effect.gen(function* () {
      const { home, main } = yield* seedHome;
      const scope = yield* Scope.make();
      const context = yield* Layer.buildWithScope(serviceLayer(home, "usage-thread-a-"), scope);
      const withService = <A, E>(
        effect: Effect.Effect<A, E, UsageService.UsageService | ServerConfig.ServerConfig>,
      ) => Effect.provide(effect, context);

      const first = yield* withService(readThread);
      assert.strictEqual(
        first.totals.outputTokens,
        12,
        "session-1 plus its subagent, not session-2",
      );
      const afterFirst = yield* withService(scanCacheText);
      assert.isNotNull(afterFirst);

      // The transcript grows; a second read within the interval does not rewrite the cache.
      yield* Effect.promise(() => NodeFSP.appendFile(main, claudeLine(4, "session-1", 30)));
      const second = yield* withService(readThread);
      assert.strictEqual(second.totals.outputTokens, 42);
      assert.strictEqual(yield* withService(scanCacheText), afterFirst);

      // Once the interval has passed, the next read persists.
      yield* TestClock.adjust(THREAD_USAGE_PERSIST_INTERVAL_MS);
      yield* withService(readThread);
      const afterInterval = yield* withService(scanCacheText);
      assert.notStrictEqual(afterInterval, afterFirst);

      // A change that was not persisted yet is flushed when the service shuts down.
      yield* Effect.promise(() => NodeFSP.appendFile(main, claudeLine(5, "session-1", 1)));
      yield* withService(readThread);
      assert.strictEqual(yield* withService(scanCacheText), afterInterval);
      yield* Scope.close(scope, Exit.void);
      assert.notStrictEqual(yield* withService(scanCacheText), afterInterval);
    }),
  );
});
