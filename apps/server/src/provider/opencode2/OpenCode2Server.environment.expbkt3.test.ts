/** T3-CUSTOM(expbkt3): provider daemons must never share different thread credentials. */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as OpenCodeRuntime from "../opencodeRuntime.ts";
import * as OpenCode2Client from "./OpenCode2Client.ts";
import * as OpenCode2Server from "./OpenCode2Server.ts";

const clientLayer = OpenCode2Client.layer.pipe(
  Layer.provide(
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response('{"version":"2.0.18","pid":1,"urls":[],"paths":{"tmp":"/tmp"}}', {
              headers: { "content-type": "application/json" },
            }),
          ),
        ),
      ),
    ),
  ),
);

it.effect("reuses one thread daemon and separates users, threads, and rotated credentials", () =>
  Effect.gen(function* () {
    const starts: Array<NodeJS.ProcessEnv> = [];
    let closes = 0;
    const runtimeLayer = Layer.mock(OpenCodeRuntime.OpenCodeRuntime)({
      createOpenCodeSdkClient: () => {
        throw new Error("The OpenCode2 daemon must not use the legacy SDK client.");
      },
      startOpenCodeServerProcess: (input) =>
        Effect.gen(function* () {
          starts.push({ ...input.environment });
          const url = `http://127.0.0.1:${40_000 + starts.length}`;
          const version = input.verify === undefined ? "2.0.18" : yield* input.verify(url);
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              closes += 1;
            }),
          );
          return { url, version, isRunning: Effect.succeed(true), exitCode: Effect.never };
        }),
    });
    yield* Effect.scoped(
      Effect.gen(function* () {
        const server = yield* OpenCode2Server.make({
          binaryPath: "opencode",
          serverUrl: "",
          serverPassword: "",
          directory: "/project",
          environment: { PATH: "/bin", GH_TOKEN: "ambient" },
        });
        const firstEnvironment = { T3_OPENCODE_THREAD_ID: "thread-a", GH_TOKEN: "user-a" };
        const first = yield* server.withConnection(
          (connection) => Effect.succeed(connection.url),
          firstEnvironment,
        );
        const repeated = yield* server.withConnection(
          (connection) => Effect.succeed(connection.url),
          { GH_TOKEN: "user-a", T3_OPENCODE_THREAD_ID: "thread-a" },
        );
        const second = yield* server.withConnection(
          (connection) => Effect.succeed(connection.url),
          { T3_OPENCODE_THREAD_ID: "thread-b", GH_TOKEN: "user-b" },
        );
        const rotated = yield* server.withConnection(
          (connection) => Effect.succeed(connection.url),
          { T3_OPENCODE_THREAD_ID: "thread-a", GH_TOKEN: "user-a-rotated" },
        );
        const inventory = yield* server.withConnection((connection) =>
          Effect.succeed(connection.url),
        );
        expect(repeated).toBe(first);
        expect(new Set([first, second, rotated, inventory]).size).toBe(4);
        expect(starts.map((environment) => environment.GH_TOKEN)).toEqual([
          "user-a",
          "user-b",
          "user-a-rotated",
          "ambient",
        ]);
        expect(starts.every((environment) => environment.PATH === "/bin")).toBe(true);
        expect(new Set(starts.map((environment) => environment.OPENCODE_PASSWORD)).size).toBe(4);
      }),
    ).pipe(Effect.provide(Layer.mergeAll(runtimeLayer, clientLayer, NodeServices.layer)));
    expect(closes).toBe(4);
  }),
);

it.effect("uses an external server without forwarding thread credentials", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* OpenCode2Server.make({
        binaryPath: "opencode",
        serverUrl: "http://127.0.0.1:4096",
        serverPassword: "configured",
        directory: "/project",
        environment: {},
      });
      const connection = yield* server.withConnection((current) => Effect.succeed(current), {
        GH_TOKEN: "personal",
        T3_OPENCODE_THREAD_ID: "thread-a",
      });
      expect(connection.external).toBe(true);
      expect(connection.url).toBe("http://127.0.0.1:4096");
    }),
  ).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(OpenCodeRuntime.OpenCodeRuntime)({
          createOpenCodeSdkClient: () => {
            throw new Error("An external OpenCode2 server must not use the legacy SDK client.");
          },
        }),
        clientLayer,
        NodeServices.layer,
      ),
    ),
  ),
);
