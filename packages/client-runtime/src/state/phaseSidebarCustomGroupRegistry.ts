// T3-CUSTOM(expbkt3): the shared custom-group registry, as the sidebar reads
// and writes it (XFN-59).
//
// Each host keeps its custom groups — names and colours, including groups with
// no session yet — in its own `threadCustomGroups` server setting, so every
// user, client and agent of that host sees the same groups. A client attached
// to several hosts merges their registries into one view here; the primary
// (or focused) host wins when two hosts disagree about the same group.
//
// Writes are planned here too, as pure functions, so web and mobile send the
// same patches: a create goes to one "home" host, and a rename, recolour or
// delete goes to every host whose registry holds the group. The server merges
// a patch per entry and re-keys it, so a patch only names the groups it
// changes.
//
// What stays on the device is unchanged: the manual section order and which
// sections are collapsed (see phaseSidebarGrouping.ts).
//
// HERMES: this also runs under React Native. Sort a copy with `.sort()`,
// never `.toSorted()`.
import {
  isThreadCustomGroupColorId,
  normalizeThreadCustomGroup,
  THREAD_CUSTOM_GROUP_COLOR_IDS,
  THREAD_CUSTOM_GROUP_MAX_LENGTH,
  type ThreadCustomGroupColorId,
  type ThreadCustomGroupDefinition,
  type ThreadCustomGroupRegistry,
  type ThreadCustomGroupRegistryPatch,
} from "@t3tools/contracts";

import { ENVIRONMENT_COLOR_OPTIONS } from "./environmentAppearance.ts";
import { PHASE_SIDEBAR_UNGROUPED_ID } from "./phaseSidebar.ts";

// ---------------------------------------------------------------------------
// Colours
// ---------------------------------------------------------------------------

export interface PhaseSidebarCustomGroupColorOption {
  readonly id: ThreadCustomGroupColorId;
  readonly label: string;
  /** The hex value, the same one the environment badge uses for this id. */
  readonly value: string;
}

/** The colours a group may use, in palette order. */
export const PHASE_SIDEBAR_CUSTOM_GROUP_COLOR_OPTIONS: ReadonlyArray<PhaseSidebarCustomGroupColorOption> =
  THREAD_CUSTOM_GROUP_COLOR_IDS.flatMap((id) => {
    const option = ENVIRONMENT_COLOR_OPTIONS.find((candidate) => candidate.id === id);
    return option === undefined ? [] : [{ id, label: option.label, value: option.value }];
  });

/** The hex value for a stored colour id; null for no colour or an id this client does not know. */
export function phaseSidebarCustomGroupColorValue(
  colorId: string | null | undefined,
): string | null {
  if (colorId === null || colorId === undefined) return null;
  return (
    PHASE_SIDEBAR_CUSTOM_GROUP_COLOR_OPTIONS.find((option) => option.id === colorId)?.value ?? null
  );
}

// ---------------------------------------------------------------------------
// Reading — merge every host's registry into one view
// ---------------------------------------------------------------------------

export interface PhaseSidebarCustomGroupRegistryEntry {
  /** The comparison key, which is also the custom section's id. */
  readonly id: string;
  readonly label: string;
  /** Null when the group has no colour, or one this client does not know. */
  readonly colorId: ThreadCustomGroupColorId | null;
  /** The resolved hex value of `colorId`. */
  readonly color: string | null;
  /** Every host whose registry holds this group, the winning host first. */
  readonly environmentIds: ReadonlyArray<string>;
}

/** Keyed by the group id. */
export type PhaseSidebarCustomGroupRegistry = ReadonlyMap<
  string,
  PhaseSidebarCustomGroupRegistryEntry
>;

export const EMPTY_PHASE_SIDEBAR_CUSTOM_GROUP_REGISTRY: PhaseSidebarCustomGroupRegistry = new Map();

/** The part of a host's server config this module reads. `ServerConfig` satisfies it. */
export interface PhaseSidebarCustomGroupRegistryConfig {
  readonly environment: {
    readonly capabilities: { readonly threadCustomGroupRegistry?: boolean | undefined };
  };
  readonly settings?:
    | { readonly threadCustomGroups?: ThreadCustomGroupRegistry | undefined }
    | undefined;
}

/** Whether a host keeps the shared registry. Older hosts fall back to device-local groups. */
export function phaseSidebarCustomGroupRegistrySupported(
  config: PhaseSidebarCustomGroupRegistryConfig | null | undefined,
): boolean {
  return config?.environment.capabilities.threadCustomGroupRegistry === true;
}

/** The hosts, among `serverConfigs`, that keep the shared registry, in map order. */
export function phaseSidebarCustomGroupRegistryEnvironmentIds(
  serverConfigs: ReadonlyMap<string, PhaseSidebarCustomGroupRegistryConfig | null | undefined>,
): ReadonlyArray<string> {
  const ids: string[] = [];
  for (const [environmentId, config] of serverConfigs) {
    if (phaseSidebarCustomGroupRegistrySupported(config)) ids.push(environmentId);
  }
  return ids;
}

function sanitizeLabel(label: string): string {
  return label.replace(/\s+/g, " ").trim().slice(0, THREAD_CUSTOM_GROUP_MAX_LENGTH);
}

/**
 * One view of every host's registry. Entries are re-keyed by their label's
 * comparison key, so a hand-edited settings file cannot split one group in
 * two. On a conflict the preferred host's definition wins whole (label and
 * colour); otherwise the first host in map order wins. Hosts without the
 * capability contribute nothing.
 */
export function buildPhaseSidebarCustomGroupRegistry(
  serverConfigs: ReadonlyMap<string, PhaseSidebarCustomGroupRegistryConfig | null | undefined>,
  preferredEnvironmentId: string | null,
): PhaseSidebarCustomGroupRegistry {
  const sources: Array<readonly [string, ThreadCustomGroupRegistry]> = [];
  for (const [environmentId, config] of serverConfigs) {
    if (!phaseSidebarCustomGroupRegistrySupported(config)) continue;
    sources.push([environmentId, config?.settings?.threadCustomGroups ?? {}]);
  }
  const preferredIndex = sources.findIndex(
    ([environmentId]) => environmentId === preferredEnvironmentId,
  );
  if (preferredIndex > 0) sources.unshift(...sources.splice(preferredIndex, 1));

  const merged = new Map<
    string,
    { label: string; colorId: ThreadCustomGroupColorId | null; environmentIds: string[] }
  >();
  for (const [environmentId, registry] of sources) {
    for (const definition of Object.values(registry)) {
      const label = sanitizeLabel(definition.label);
      if (label.length === 0) continue;
      const id = normalizeThreadCustomGroup(label);
      if (id === PHASE_SIDEBAR_UNGROUPED_ID) continue;
      const existing = merged.get(id);
      if (existing !== undefined) {
        if (!existing.environmentIds.includes(environmentId)) {
          existing.environmentIds.push(environmentId);
        }
        continue;
      }
      const colorId =
        definition.colorId !== undefined && isThreadCustomGroupColorId(definition.colorId)
          ? definition.colorId
          : null;
      merged.set(id, { label, colorId, environmentIds: [environmentId] });
    }
  }
  if (merged.size === 0) return EMPTY_PHASE_SIDEBAR_CUSTOM_GROUP_REGISTRY;
  const result = new Map<string, PhaseSidebarCustomGroupRegistryEntry>();
  for (const [id, entry] of merged) {
    result.set(id, {
      id,
      label: entry.label,
      colorId: entry.colorId,
      color: phaseSidebarCustomGroupColorValue(entry.colorId),
      environmentIds: entry.environmentIds,
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Writing — plan the settings patches, one per host
// ---------------------------------------------------------------------------

export interface PhaseSidebarCustomGroupRegistryWrite {
  readonly environmentId: string;
  readonly patch: ThreadCustomGroupRegistryPatch;
}

export interface PhaseSidebarCustomGroupWritePlan {
  readonly writes: ReadonlyArray<PhaseSidebarCustomGroupRegistryWrite>;
  /** Hosts that hold the group but this session may not write; the change misses them. */
  readonly skippedEnvironmentIds: ReadonlyArray<string>;
}

const EMPTY_PLAN: PhaseSidebarCustomGroupWritePlan = { writes: [], skippedEnvironmentIds: [] };

/** A registry definition; an unknown colour id is dropped, which reads as the default look. */
export function phaseSidebarCustomGroupDefinition(
  label: string,
  colorId: string | null | undefined,
): ThreadCustomGroupDefinition {
  return colorId !== null && colorId !== undefined && isThreadCustomGroupColorId(colorId)
    ? { label, colorId }
    : { label };
}

/**
 * The host a new group is written to: the preferred host (web's primary
 * environment, mobile's focused one) when this session may write it, else the
 * first writable host. Null means no connected host keeps the registry for
 * this session, and the caller falls back to a device-local group.
 */
export function resolvePhaseSidebarCustomGroupHome(
  writableEnvironmentIds: ReadonlyArray<string>,
  preferredEnvironmentId: string | null,
): string | null {
  if (preferredEnvironmentId !== null && writableEnvironmentIds.includes(preferredEnvironmentId)) {
    return preferredEnvironmentId;
  }
  return writableEnvironmentIds[0] ?? null;
}

function planForHolders(
  entry: PhaseSidebarCustomGroupRegistryEntry,
  writableEnvironmentIds: ReadonlyArray<string>,
  patch: ThreadCustomGroupRegistryPatch,
): PhaseSidebarCustomGroupWritePlan {
  const writes: PhaseSidebarCustomGroupRegistryWrite[] = [];
  const skippedEnvironmentIds: string[] = [];
  for (const environmentId of entry.environmentIds) {
    if (writableEnvironmentIds.includes(environmentId)) writes.push({ environmentId, patch });
    else skippedEnvironmentIds.push(environmentId);
  }
  return { writes, skippedEnvironmentIds };
}

/**
 * Registers a group on the home host. `id` is null for a blank label or the
 * reserved "Ungrouped" name. A group the registry already holds needs no write.
 */
export function planPhaseSidebarCustomGroupCreate(input: {
  readonly registry: PhaseSidebarCustomGroupRegistry;
  readonly label: string;
  readonly colorId?: string | null;
  readonly homeEnvironmentId: string | null;
}): PhaseSidebarCustomGroupWritePlan & { readonly id: string | null } {
  const label = sanitizeLabel(input.label);
  if (label.length === 0) return { ...EMPTY_PLAN, id: null };
  const id = normalizeThreadCustomGroup(label);
  if (id === PHASE_SIDEBAR_UNGROUPED_ID) return { ...EMPTY_PLAN, id: null };
  if (input.registry.has(id) || input.homeEnvironmentId === null) return { ...EMPTY_PLAN, id };
  return {
    id,
    writes: [
      {
        environmentId: input.homeEnvironmentId,
        patch: { [id]: phaseSidebarCustomGroupDefinition(label, input.colorId) },
      },
    ],
    skippedEnvironmentIds: [],
  };
}

/**
 * Sets or clears (`colorId` null) a group's colour on every host that holds
 * it. A group that exists only as a thread label is registered on the home
 * host with that colour, which is what makes it shared.
 */
export function planPhaseSidebarCustomGroupRecolor(input: {
  readonly registry: PhaseSidebarCustomGroupRegistry;
  readonly id: string;
  /** The label shown for the group, used when it is not registered yet. */
  readonly label: string;
  readonly colorId: string | null;
  readonly writableEnvironmentIds: ReadonlyArray<string>;
  readonly homeEnvironmentId: string | null;
}): PhaseSidebarCustomGroupWritePlan {
  if (input.id === PHASE_SIDEBAR_UNGROUPED_ID) return EMPTY_PLAN;
  const entry = input.registry.get(input.id);
  if (entry !== undefined) {
    return planForHolders(entry, input.writableEnvironmentIds, {
      [entry.id]: phaseSidebarCustomGroupDefinition(entry.label, input.colorId),
    });
  }
  const label = sanitizeLabel(input.label);
  if (label.length === 0 || input.homeEnvironmentId === null) return EMPTY_PLAN;
  return {
    writes: [
      {
        environmentId: input.homeEnvironmentId,
        patch: { [input.id]: phaseSidebarCustomGroupDefinition(label, input.colorId) },
      },
    ],
    skippedEnvironmentIds: [],
  };
}

/**
 * Renames a registered group on every host that holds it. Renaming onto a
 * group that already exists merges the two and keeps that group's colour when
 * it has one. A group that is only a thread label has nothing to write here:
 * relabelling its sessions is the whole rename.
 */
export function planPhaseSidebarCustomGroupRename(input: {
  readonly registry: PhaseSidebarCustomGroupRegistry;
  readonly id: string;
  readonly label: string;
  readonly writableEnvironmentIds: ReadonlyArray<string>;
}): PhaseSidebarCustomGroupWritePlan & { readonly nextId: string | null } {
  const label = sanitizeLabel(input.label);
  if (label.length === 0) return { ...EMPTY_PLAN, nextId: null };
  const nextId = normalizeThreadCustomGroup(label);
  if (nextId === PHASE_SIDEBAR_UNGROUPED_ID) return { ...EMPTY_PLAN, nextId: null };
  const entry = input.registry.get(input.id);
  if (entry === undefined) return { ...EMPTY_PLAN, nextId };
  const target = nextId === entry.id ? undefined : input.registry.get(nextId);
  const definition = phaseSidebarCustomGroupDefinition(label, target?.colorId ?? entry.colorId);
  const patch: ThreadCustomGroupRegistryPatch =
    nextId === entry.id ? { [nextId]: definition } : { [entry.id]: null, [nextId]: definition };
  return { ...planForHolders(entry, input.writableEnvironmentIds, patch), nextId };
}

/** Removes a registered group from every host that holds it. */
export function planPhaseSidebarCustomGroupDelete(input: {
  readonly registry: PhaseSidebarCustomGroupRegistry;
  readonly id: string;
  readonly writableEnvironmentIds: ReadonlyArray<string>;
}): PhaseSidebarCustomGroupWritePlan {
  const entry = input.registry.get(input.id);
  if (entry === undefined) return EMPTY_PLAN;
  return planForHolders(entry, input.writableEnvironmentIds, { [entry.id]: null });
}
