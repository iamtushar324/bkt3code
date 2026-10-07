/**
 * T3-CUSTOM(expbkt3): the switcher is called with an argv array, decoded
 * tolerantly, and an old binary without the new flags reads as unavailable.
 */
// @effect-diagnostics nodeBuiltinImport:off - expected paths are computed independently.
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import type { ServerSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { type ProcessRunInput, type ProcessRunOutput, ProcessRunner } from "../processRunner.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  ClaudeAutoswitchClient,
  layer as clientLayer,
  resolveAutoswitchPath,
} from "./ClaudeAutoswitchClient.ts";

const homeSwitcher = NodePath.join(NodeOS.homedir(), ".local", "bin", "claude-autoswitch");

function output(overrides: Partial<ProcessRunOutput>): ProcessRunOutput {
  return {
    stdout: "",
    stderr: "",
    code: 0 as ProcessRunOutput["code"],
    timedOut: false,
    stdoutTruncated: false,
    stderrTruncated: false,
    stdoutInvalidUtf8: false,
    stderrInvalidUtf8: false,
    ...overrides,
  };
}

function harness(respond: (input: ProcessRunInput) => ProcessRunOutput, autoswitchPath = "") {
  const calls: Array<ProcessRunInput> = [];
  const settings = {
    experimental: { claudeAccountProfiles: { enabled: true, autoswitchPath, shortLabels: {} } },
  } as unknown as ServerSettings;
  const layer = clientLayer.pipe(
    Layer.provide(
      Layer.mock(ProcessRunner)({
        run: (input) =>
          Effect.sync(() => {
            calls.push(input);
            return respond(input);
          }),
      }),
    ),
    Layer.provide(Layer.mock(ServerSettingsService)({ getSettings: Effect.succeed(settings) })),
  );
  return { layer, calls };
}

describe("resolveAutoswitchPath", () => {
  it("defaults to the switcher under the server user's home", () => {
    assert.equal(resolveAutoswitchPath(undefined), homeSwitcher);
    assert.equal(resolveAutoswitchPath("  "), homeSwitcher);
  });

  it("expands a leading ~ in the setting and lets the env override win", () => {
    assert.equal(
      resolveAutoswitchPath("~/tools/claude-autoswitch"),
      NodePath.join(NodeOS.homedir(), "tools", "claude-autoswitch"),
    );
    assert.equal(resolveAutoswitchPath("/opt/claude-autoswitch"), "/opt/claude-autoswitch");
    const previous = process.env.T3_CLAUDE_AUTOSWITCH_BIN;
    process.env.T3_CLAUDE_AUTOSWITCH_BIN = "~/fake-switcher";
    try {
      assert.equal(
        resolveAutoswitchPath("/opt/claude-autoswitch"),
        NodePath.join(NodeOS.homedir(), "fake-switcher"),
      );
    } finally {
      if (previous === undefined) delete process.env.T3_CLAUDE_AUTOSWITCH_BIN;
      else process.env.T3_CLAUDE_AUTOSWITCH_BIN = previous;
    }
  });
});

describe("ClaudeAutoswitchClient", () => {
  it.effect("asks for a placement with pending counts and avoided accounts as flags", () =>
    Effect.gen(function* () {
      const { layer, calls } = harness(() =>
        output({
          stdout:
            '{"schema":"claude-autoswitch.place/1","status":"placed","chosen":"agent","dir":"/p/agent","reason":"fewest sessions","recovers_at":null,"snapshot":null,"extra":1}',
        }),
      );
      const result = yield* Effect.gen(function* () {
        const client = yield* ClaudeAutoswitchClient;
        return yield* client.place({ pending: { tushar: 2, agent: 0, sam: 1 }, avoid: ["sam"] });
      }).pipe(Effect.provide(layer));

      assert.equal(calls.length, 1);
      assert.equal(calls[0]!.command, homeSwitcher);
      assert.deepEqual(calls[0]!.args, [
        "--place",
        "--json",
        "--pending",
        "tushar=2,sam=1",
        "--avoid",
        "sam",
      ]);
      assert.equal(calls[0]!.timeoutBehavior, "timedOutResult");
      assert.equal(result.kind, "ok");
      if (result.kind === "ok") {
        assert.equal(result.value.status, "placed");
        assert.equal(result.value.chosen, "agent");
      }
    }),
  );

  it.effect("sends pending counts and burn rates to --status and --place when given", () =>
    Effect.gen(function* () {
      const { layer, calls } = harness(() =>
        output({
          stdout:
            '{"schema":"claude-autoswitch.status/1","place_rule":"space-share-v1","place_order":["agent"],"profiles":[{"name":"agent","place_rank":1,"space_to_reset":97.0,"space_per_day":14.1,"five_hour_full_in":null}]}',
        }),
      );
      const result = yield* Effect.gen(function* () {
        const client = yield* ClaudeAutoswitchClient;
        yield* client.place({
          pending: { agent: 1 },
          avoid: [],
          rates: { tushar: 37.46, agent: 0, broken: Number.NaN },
        });
        return yield* client.status({ pending: {}, rates: { tushar: 37.46 } });
      }).pipe(Effect.provide(layer));

      assert.deepEqual(calls[0]!.args, [
        "--place",
        "--json",
        "--pending",
        "agent=1",
        "--rates",
        "tushar=37.5,agent=0",
      ]);
      assert.deepEqual(calls[1]!.args, ["--status", "--json", "--rates", "tushar=37.5"]);
      assert.equal(result.kind, "ok");
      if (result.kind === "ok") {
        assert.equal(result.value.place_rule, "space-share-v1");
        assert.equal(result.value.profiles[0]?.place_rank, 1);
      }
    }),
  );

  it.effect(
    "passes the limit type and profile to --hard-limit and honours the configured path",
    () =>
      Effect.gen(function* () {
        const { layer, calls } = harness(
          () => output({ stdout: '{"status":"no-op","reason":"not_elected"}' }),
          "/opt/bin/claude-autoswitch",
        );
        const result = yield* Effect.gen(function* () {
          const client = yield* ClaudeAutoswitchClient;
          return yield* client.hardLimit({ type: "five_hour", profile: "tushar" });
        }).pipe(Effect.provide(layer));

        assert.equal(calls[0]!.command, "/opt/bin/claude-autoswitch");
        assert.deepEqual(calls[0]!.args, [
          "--hard-limit",
          "five_hour",
          "--profile",
          "tushar",
          "--json",
        ]);
        assert.equal(result.kind, "ok");
        if (result.kind === "ok") assert.equal(result.value.status, "no-op");
      }),
  );

  it.effect("reads an old switcher that prints usage for an unknown flag as unavailable", () =>
    Effect.gen(function* () {
      const { layer } = harness(() =>
        output({
          code: 2 as ProcessRunOutput["code"],
          stderr:
            "usage: claude-autoswitch [--status] [--dry-run]\nerror: unrecognized arguments: --place",
        }),
      );
      const result = yield* Effect.gen(function* () {
        const client = yield* ClaudeAutoswitchClient;
        return yield* client.status();
      }).pipe(Effect.provide(layer));

      assert.equal(result.kind, "unavailable");
    }),
  );

  it.effect("reads a timeout or unreadable output as a failure, not as unavailable", () =>
    Effect.gen(function* () {
      const timedOut = harness(() => output({ timedOut: true }));
      const garbage = harness(() => output({ stdout: "not json" }));
      const read = (layer: typeof timedOut.layer) =>
        Effect.gen(function* () {
          const client = yield* ClaudeAutoswitchClient;
          return yield* client.status();
        }).pipe(Effect.provide(layer));

      assert.equal((yield* read(timedOut.layer)).kind, "failed");
      assert.equal((yield* read(garbage.layer)).kind, "failed");
    }),
  );
});
