// T3-CUSTOM(expbkt3): merge rule for the shared custom-group registry (XFN-59).
//
// `ServerSettings.threadCustomGroups` is keyed by
// `normalizeThreadCustomGroup(label)`, so "Sprint 42" and "sprint 42" are one
// group. A settings patch upserts or removes entries one by one, and the
// server re-derives every key from the label, whatever key a client sent, so
// case-insensitive uniqueness holds even against a careless or older client.
import {
  isReservedThreadCustomGroup,
  normalizeThreadCustomGroup,
  type ThreadCustomGroupRegistry,
  type ThreadCustomGroupRegistryPatch,
} from "@t3tools/contracts";

/**
 * Apply a registry patch entry by entry, in patch order.
 *
 * - A definition replaces the entry under the key of its own label (the patch
 *   key is ignored), so a definition without `colorId` clears the colour.
 * - `null` removes the entry under the normalized patch key.
 * - Entries the patch omits are untouched.
 *
 * Existing entries are re-keyed first, so a stored key that is not the
 * normalized label cannot survive as a duplicate group. A definition named
 * like the built-in "Ungrouped" section is dropped: no sidebar draws it.
 */
export function mergeThreadCustomGroupRegistry(
  current: ThreadCustomGroupRegistry,
  patch: ThreadCustomGroupRegistryPatch,
): ThreadCustomGroupRegistry {
  const next = new Map<string, ThreadCustomGroupRegistry[string]>();
  for (const definition of Object.values(current)) {
    if (isReservedThreadCustomGroup(definition.label)) continue;
    next.set(normalizeThreadCustomGroup(definition.label), definition);
  }
  for (const [key, definition] of Object.entries(patch)) {
    if (definition === null) {
      next.delete(normalizeThreadCustomGroup(key));
    } else if (!isReservedThreadCustomGroup(definition.label)) {
      next.set(normalizeThreadCustomGroup(definition.label), definition);
    }
  }
  return Object.fromEntries(next);
}

// T3-CUSTOM(expbkt3): BEGIN — the default group follows its registry entry.
/**
 * Where `defaultThreadCustomGroup` must point after a registry patch, or
 * `undefined` to leave it as it is. A patch that removes the default group
 * and adds exactly one other group is a rename (the sidebar and the MCP
 * rename both send that shape), so the default follows the new label. Any
 * other removal clears the default, so new sessions never land in a group
 * that no longer exists.
 */
export function followDefaultThreadCustomGroup(
  defaultLabel: string | null,
  patch: ThreadCustomGroupRegistryPatch,
): string | null | undefined {
  if (defaultLabel === null) return undefined;
  const key = normalizeThreadCustomGroup(defaultLabel);
  const removed = Object.entries(patch).some(
    ([patchKey, definition]) => definition === null && normalizeThreadCustomGroup(patchKey) === key,
  );
  if (!removed) return undefined;
  const added = Object.values(patch).filter(
    (definition) =>
      definition !== null &&
      normalizeThreadCustomGroup(definition.label) !== key &&
      !isReservedThreadCustomGroup(definition.label),
  );
  return added.length === 1 ? (added[0]?.label ?? null) : null;
}
// T3-CUSTOM(expbkt3): END
