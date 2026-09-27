/**
 * T3-CUSTOM(expbkt3): coverage for agent-rendered UI surfaces.
 *
 * The validation here is the security boundary an agent's input crosses, so the
 * tests pin the rejections as tightly as the happy path: an agent that can
 * choose the framed URL scheme, or push an unbounded document into the database,
 * is a different feature from the one we shipped.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { AGENT_UI_MAX_HTML_CHARS, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { MigrationsLive } from "../persistence/Migrations.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as AgentUiRenders from "../persistence/AgentUiRenders.ts";
import * as AgentUiServiceModule from "./AgentUiService.ts";
import { AgentUiService } from "./AgentUiService.ts";

const threadId = ThreadId.make("thread-agent-ui");
const otherThreadId = ThreadId.make("thread-agent-ui-other");

const layer = AgentUiServiceModule.layer.pipe(
  Layer.provide(AgentUiRenders.layer),
  Layer.provide(MigrationsLive),
  Layer.provide(SqlitePersistenceMemory),
  Layer.provide(NodeServices.layer),
);

const withService = <A, E>(
  body: (service: AgentUiService["Service"]) => Effect.Effect<A, E, never>,
) =>
  Effect.gen(function* () {
    const service = yield* AgentUiService;
    return yield* body(service);
  }).pipe(Effect.provide(layer));

describe("AgentUiService", () => {
  it.effect("stores an inline document and reads it back by handle", () =>
    withService((service) =>
      Effect.gen(function* () {
        const handle = yield* service.show({
          threadId,
          title: "  Latency  ",
          html: "<p>hello</p>",
        });
        expect(handle.kind).toBe("html");
        expect(handle.renderId.startsWith("aui_")).toBe(true);

        const render = yield* service.getRender({ threadId, renderId: handle.renderId });
        expect(render?.html).toBe("<p>hello</p>");
        expect(render?.title).toBe("Latency");
        expect(render?.url).toBeNull();
      }),
    ),
  );

  it.effect("scopes a render to its own thread", () =>
    withService((service) =>
      Effect.gen(function* () {
        const handle = yield* service.show({ threadId, title: "Chart", html: "<b>x</b>" });
        const leaked = yield* service.getRender({
          threadId: otherThreadId,
          renderId: handle.renderId,
        });
        expect(leaked).toBeNull();
      }),
    ),
  );

  it.effect("clamps the height into the embeddable range", () =>
    withService((service) =>
      Effect.gen(function* () {
        const tall = yield* service.show({ threadId, title: "t", html: "<p/>", height: 5_000 });
        const short = yield* service.show({ threadId, title: "t", html: "<p/>", height: 1 });
        const absent = yield* service.show({ threadId, title: "t", html: "<p/>" });
        expect(tall.height).toBe(900);
        expect(short.height).toBe(120);
        expect(absent.height).toBe(360);
      }),
    ),
  );

  it.effect("accepts an https URL and rejects every other scheme", () =>
    withService((service) =>
      Effect.gen(function* () {
        const ok = yield* service.show({ threadId, title: "Docs", url: "https://example.com/a" });
        expect(ok.kind).toBe("url");

        for (const url of [
          "http://example.com",
          "javascript:alert(1)",
          "file:///etc/passwd",
          "data:text/html,<script>alert(1)</script>",
          "not a url",
        ]) {
          const failure = yield* service.show({ threadId, title: "x", url }).pipe(Effect.flip);
          expect(failure.message).toContain("https://");
        }
      }),
    ),
  );

  it.effect("preserves distinct fragments for same-origin URL renders", () =>
    withService((service) =>
      Effect.gen(function* () {
        const firstUrl = "https://fixture.example.test/board?mode=collab#room=alpha,safe-key-a";
        const secondUrl = "https://fixture.example.test/board#room=beta,safe-key-b";
        const first = yield* service.show({ threadId, title: "First", url: firstUrl });
        const second = yield* service.show({ threadId, title: "Second", url: secondUrl });

        expect(first.renderId).not.toBe(second.renderId);
        expect((yield* service.getRender({ threadId, renderId: first.renderId }))?.url).toBe(
          firstUrl,
        );
        expect((yield* service.getRender({ threadId, renderId: second.renderId }))?.url).toBe(
          secondUrl,
        );
      }),
    ),
  );

  it.effect("requires exactly one of html or url", () =>
    withService((service) =>
      Effect.gen(function* () {
        const neither = yield* service.show({ threadId, title: "x" }).pipe(Effect.flip);
        expect(neither.message).toContain("Provide either");

        const both = yield* service
          .show({ threadId, title: "x", html: "<p/>", url: "https://example.com" })
          .pipe(Effect.flip);
        expect(both.message).toContain("only one");
      }),
    ),
  );

  it.effect("refuses a document past the size cap", () =>
    withService((service) =>
      Effect.gen(function* () {
        const failure = yield* service
          .show({ threadId, title: "x", html: "a".repeat(AGENT_UI_MAX_HTML_CHARS + 1) })
          .pipe(Effect.flip);
        expect(failure.message).toContain("the limit is");
      }),
    ),
  );

  it.effect("returns null for a render that was never stored", () =>
    withService((service) =>
      Effect.gen(function* () {
        const missing = yield* service.getRender({ threadId, renderId: "aui_nope" });
        expect(missing).toBeNull();
      }),
    ),
  );
});
