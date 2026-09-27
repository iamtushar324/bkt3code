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
