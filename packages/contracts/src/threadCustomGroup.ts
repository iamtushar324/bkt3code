// T3-CUSTOM(expbkt3): per-thread custom group.
//
// A thread may carry one shared, durable label that files it under a section
// of the sidebar's "Custom" grouping mode. Unlike the device-local groups that
// mode started with, the label lives on the thread itself, so every client and
// every agent (through the `t3_update_session` / `t3_create_session` MCP
// tools) sees the same placement. Null or absent means "ungrouped".
//
// Labels keep the case the user typed but compare case-insensitively: "Sprint
// 42" and "sprint 42" are the same group, and the sidebar shows whichever
// spelling it meets first.
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const THREAD_CUSTOM_GROUP_MAX_LENGTH = 48;

export const ThreadCustomGroup = TrimmedNonEmptyString.check(
  Schema.isMaxLength(THREAD_CUSTOM_GROUP_MAX_LENGTH),
);
export type ThreadCustomGroup = typeof ThreadCustomGroup.Type;

/**
 * The comparison key for a custom group label: trimmed, single-spaced and
 * lower-cased. Two labels with the same key are the same group.
 */
export function normalizeThreadCustomGroup(label: string): string {
  return label.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * The key of the sidebar's built-in section for sessions with no group. No
 * custom group may take it: a group under this key would never be drawn.
 */
export const THREAD_CUSTOM_GROUP_RESERVED_KEY = "ungrouped";

export function isReservedThreadCustomGroup(label: string): boolean {
  return normalizeThreadCustomGroup(label) === THREAD_CUSTOM_GROUP_RESERVED_KEY;
}

// T3-CUSTOM(expbkt3): BEGIN — the shared registry of custom groups (XFN-59).
//
// A group used to exist only while some thread carried its label, plus
// device-local empty placeholders. The registry lives in the host's server
// settings (`threadCustomGroups`), so every user, client and agent of the host
// sees the same groups, including empty ones, and the same colour for each.
// It is keyed by `normalizeThreadCustomGroup(label)`. A thread label with no
// registry entry still forms a group, drawn with the default look.

/** Colours a custom group may use: the environment badge's palette. */
export const THREAD_CUSTOM_GROUP_COLOR_IDS = [
  "blue",
  "violet",
  "pink",
  "red",
  "orange",
  "amber",
  "lime",
  "emerald",
  "teal",
  "cyan",
  "indigo",
  "slate",
] as const;
export type ThreadCustomGroupColorId = (typeof THREAD_CUSTOM_GROUP_COLOR_IDS)[number];

export function isThreadCustomGroupColorId(value: string): value is ThreadCustomGroupColorId {
  return (THREAD_CUSTOM_GROUP_COLOR_IDS as ReadonlyArray<string>).includes(value);
}

/**
 * A stored colour id. Kept a plain bounded string, not the literal union, so a
 * colour added by a newer client still decodes on an older one, which then
 * draws the default look. Writers validate with `isThreadCustomGroupColorId`.
 */
export const ThreadCustomGroupColor = TrimmedNonEmptyString.check(Schema.isMaxLength(32));
export type ThreadCustomGroupColor = typeof ThreadCustomGroupColor.Type;

export const ThreadCustomGroupDefinition = Schema.Struct({
  /** The label as the user typed it; threads carry the same label. */
  label: ThreadCustomGroup,
  colorId: Schema.optionalKey(ThreadCustomGroupColor),
});
export type ThreadCustomGroupDefinition = typeof ThreadCustomGroupDefinition.Type;

/** Keyed by `normalizeThreadCustomGroup(definition.label)`. */
export const ThreadCustomGroupRegistry = Schema.Record(Schema.String, ThreadCustomGroupDefinition);
export type ThreadCustomGroupRegistry = typeof ThreadCustomGroupRegistry.Type;

/** A patch entry: a definition upserts the key, `null` removes it. */
export const ThreadCustomGroupRegistryPatch = Schema.Record(
  Schema.String,
  Schema.NullOr(ThreadCustomGroupDefinition),
);
export type ThreadCustomGroupRegistryPatch = typeof ThreadCustomGroupRegistryPatch.Type;
// T3-CUSTOM(expbkt3): END
