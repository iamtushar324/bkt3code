/**
 * T3-CUSTOM(expbkt3): small helpers several agent tool handlers share: stable
 * ids for retries, the origin session links use, and people's names.
 */
import {
  CommandId,
  type OrchestrationUser,
  type ProviderInteractionMode,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { ClerkDirectory } from "../../../auth/ClerkDirectory.ts";
import { ServerSettingsService } from "../../../serverSettings.ts";
import type * as McpInvocationContext from "../../McpInvocationContext.ts";

export const result = (markdown: string, data: unknown) => ({ markdown, data });

/** 64-bit FNV-1a of `text`, seeded, as 16 hex digits. */
export const fnv64 = (text: string, seed: bigint) => {
  let hash = 0xcbf29ce484222325n ^ seed;
  for (const unit of new TextEncoder().encode(text)) {
    hash ^= BigInt(unit);
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  // FNV-1a mixes the last characters weakly into the high bits; finish with
  // MurmurHash3's fmix64 so ids of similar texts differ from the first digit.
  hash ^= hash >> 33n;
  hash = (hash * 0xff51afd7ed558ccdn) & 0xffffffffffffffffn;
  hash ^= hash >> 33n;
  hash = (hash * 0xc4ceb9fe1a85ec53n) & 0xffffffffffffffffn;
  hash ^= hash >> 33n;
  return hash.toString(16).padStart(16, "0");
};

/**
 * A UUID-shaped id that is the same for the same text, so a session started
 * with a clientRequestId is found again on retry and still has a short id.
 */
export const stableUuid = (text: string) => {
  const hex = `${fnv64(text, 0n)}${fnv64(text, 0x9e3779b97f4a7c15n)}`;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

/**
 * The origin session links use: the one the request reached, else the
 * server's configured public MCP URL. An agent inside a session reaches the
 * server on loopback, which is no link for a person.
 */
export const linkOrigin = Effect.fn("agentToolkit.linkOrigin")(function* (
  scope: McpInvocationContext.McpInvocationScope,
) {
  if (scope.requestOrigin !== undefined) return scope.requestOrigin;
  const settings = yield* Effect.serviceOption(ServerSettingsService);
  if (Option.isNone(settings)) return undefined;
  const publicUrl = yield* settings.value.getSettings.pipe(
    Effect.map((current) => current.experimental.externalMcp.publicUrl),
    Effect.orElseSucceed(() => ""),
  );
  if (publicUrl.length === 0) return undefined;
  try {
    return new URL(publicUrl).origin;
  } catch {
    return undefined;
  }
});

export const loadPeople = Effect.fn("agentToolkit.loadPeople")(function* () {
  const directory = yield* ClerkDirectory;
  const members = yield* directory
    .listOrgMembers()
    .pipe(Effect.orElseSucceed((): ReadonlyArray<OrchestrationUser> => []));
  return new Map(members.map((member): [string, OrchestrationUser] => [member.id, member]));
});

export const personName = (
  people: ReadonlyMap<string, OrchestrationUser>,
  userId: string | null,
) => {
  if (userId === null) return null;
  const person = people.get(userId);
  return person?.name ?? person?.email ?? userId;
};

/** A command id for a write: stable for a clientRequestId, so a retry does nothing new. */
export const commandIdFor = Effect.fn("agentToolkit.commandIdFor")(function* (
  scope: McpInvocationContext.McpInvocationScope,
  operation: string,
  target: string,
  clientRequestId: string | undefined,
) {
  // The target is part of the id, so one clientRequestId reused for another
  // session or request is a new command, not a conflict.
  if (clientRequestId !== undefined && clientRequestId.trim().length > 0) {
    return CommandId.make(
      `mcp:agent:${operation}:${stableUuid(`${scope.requestNamespace}\u0000${target}\u0000${clientRequestId.trim()}`)}`,
    );
  }
  const crypto = yield* Crypto.Crypto;
  return CommandId.make(
    `mcp:agent:${operation}:${yield* crypto.randomUUIDv4().pipe(Effect.orDie)}`,
  );
});

/** The interaction mode a `mode: "build" | "plan"` parameter asks for. */
export const interactionModeFor = (
  mode: "build" | "plan" | undefined,
): ProviderInteractionMode | undefined =>
  mode === "plan" ? "plan" : mode === "build" ? "default" : undefined;
