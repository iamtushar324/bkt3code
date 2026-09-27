#!/usr/bin/env node

/**
 * Prints the next build version for one of the fork's desktop apps, and nothing
 * else, so CI can capture it:
 *
 *   version=$(node scripts/resolve-bk-desktop-version.ts --channel staging)
 *
 * Exists because the build and the publish step both need the *same* version,
 * and `build-bk-desktop-dmg.ts` resolving one internally would leave the
 * publisher guessing. Delegates to that script's `resolveBuildVersion` so the
 * counter rules — per channel, per base version, per UTC day — live in exactly
 * one place.
 */

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Command, Flag } from "effect/unstable/cli";

import { InvalidBkManagedChannelError, resolveBuildVersion } from "./build-bk-desktop-dmg.ts";
import { isBkManagedChannel } from "./lib/bk-managed-environment.ts";

const command = Command.make(
  "resolve-bk-desktop-version",
  {
    channel: Flag.string("channel").pipe(
      Flag.withDescription("Which fork app to stamp a version for: staging or production."),
    ),
  },
  ({ channel }) =>
    Effect.gen(function* () {
      const requestedChannel = channel.trim().toLowerCase();
      if (!isBkManagedChannel(requestedChannel)) {
        return yield* new InvalidBkManagedChannelError({ channel: requestedChannel });
      }
      const version = yield* resolveBuildVersion(Option.none(), requestedChannel);
      yield* Console.log(version);
    }),
).pipe(Command.withDescription("Print the next BK desktop build version for a channel."));

if (import.meta.main) {
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.scoped,
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
