// T3-CUSTOM(expbkt3): merge rule for the shared custom-group registry (XFN-59).
//
// `ServerSettings.threadCustomGroups` is keyed by
// `normalizeThreadCustomGroup(label)`, so "Sprint 42" and "sprint 42" are one
// group. A settings patch upserts or removes entries one by one, and the
// server re-derives every key from the label, whatever key a client sent, so
// case-insensitive uniqueness holds even against a careless or older client.
import {
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
 * normalized label cannot survive as a duplicate group.
 */
export function mergeThreadCustomGroupRegistry(
  current: ThreadCustomGroupRegistry,
  patch: ThreadCustomGroupRegistryPatch,
): ThreadCustomGroupRegistry {
  const next = new Map<string, ThreadCustomGroupRegistry[string]>();
  for (const definition of Object.values(current)) {
    next.set(normalizeThreadCustomGroup(definition.label), definition);
  }
  for (const [key, definition] of Object.entries(patch)) {
    if (definition === null) {
      next.delete(normalizeThreadCustomGroup(key));
    } else {
      next.set(normalizeThreadCustomGroup(definition.label), definition);
    }
  }
  return Object.fromEntries(next);
}
