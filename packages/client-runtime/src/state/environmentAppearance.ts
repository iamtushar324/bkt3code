/**
 * T3-CUSTOM(expbkt3): per-environment identity — nickname, icon and colour —
 * shared by web and mobile.
 *
 * Once a client is attached to more than one environment, every list that mixes
 * their data reads as duplicates: the same repository name appears twice with
 * nothing to say which machine each row came from. This module owns the pure
 * part of the identity we attach to an environment: the icon and colour
 * catalogues, the derived fallback, and the sanitizer for stored values.
 * Rendering (Lucide on web, SF Symbols on mobile) stays with each client.
 *
 * Two decisions worth keeping:
 *
 * - **Appearance belongs to the host.** An override lives in that host's server
 *   settings (`environmentAppearance`), so everyone connected to it sees the
 *   same name, icon and colour, on every device. Clients read it from the
 *   environment's `serverConfig.settings` and never store their own copy.
 * - **Every environment gets a distinct look before anyone configures one.**
 *   The fallback is derived from the environment id with FNV-1a, so the second
 *   machine you attach is immediately distinguishable, and the same machine
 *   derives the same look on the phone and in the browser.
 *
 * @module state/environmentAppearance
 */
import {
  ENVIRONMENT_NICKNAME_MAX_LENGTH,
  type EnvironmentAppearanceSetting,
} from "@t3tools/contracts";

export interface EnvironmentAppearance {
  readonly nickname?: string;
  readonly iconId?: string;
  readonly colorId?: string;
}

export interface EnvironmentIconDescriptor {
  readonly id: string;
  readonly label: string;
}

export interface EnvironmentColorOption {
  readonly id: string;
  readonly label: string;
  /** Foreground for the glyph and the accent dot. */
  readonly value: string;
}

/** Ids are the stored value; keep them stable, append new ones at the end. */
export const ENVIRONMENT_ICON_DESCRIPTORS: ReadonlyArray<EnvironmentIconDescriptor> = [
  { id: "server", label: "Server" },
  { id: "laptop", label: "Laptop" },
  { id: "cloud", label: "Cloud" },
  { id: "home", label: "Home" },
  { id: "cpu", label: "CPU" },
  { id: "container", label: "Container" },
  { id: "database", label: "Database" },
  { id: "flask", label: "Lab" },
  { id: "rocket", label: "Rocket" },
  { id: "globe", label: "Globe" },
  { id: "terminal", label: "Terminal" },
  { id: "code", label: "Code" },
  { id: "wrench", label: "Tools" },
  { id: "zap", label: "Zap" },
  { id: "box", label: "Box" },
];

/**
 * Hues spaced far enough apart to stay separable at badge size, and mid-lightness
 * so the same value carries on both light and dark surfaces without a second set.
 */
export const ENVIRONMENT_COLOR_OPTIONS: ReadonlyArray<EnvironmentColorOption> = [
  { id: "blue", label: "Blue", value: "#3b82f6" },
  { id: "violet", label: "Violet", value: "#8b5cf6" },
  { id: "pink", label: "Pink", value: "#ec4899" },
  { id: "red", label: "Red", value: "#ef4444" },
  { id: "orange", label: "Orange", value: "#f97316" },
  { id: "amber", label: "Amber", value: "#f59e0b" },
  { id: "lime", label: "Lime", value: "#84cc16" },
  { id: "emerald", label: "Emerald", value: "#10b981" },
  { id: "teal", label: "Teal", value: "#14b8a6" },
  { id: "cyan", label: "Cyan", value: "#06b6d4" },
  { id: "indigo", label: "Indigo", value: "#6366f1" },
  { id: "slate", label: "Slate", value: "#94a3b8" },
];

export interface ResolvedEnvironmentIdentity {
  readonly name: string;
  readonly iconId: string;
  readonly colorId: string;
  readonly color: string;
  /** True when the operator picked this, rather than it being derived from the id. */
  readonly customized: boolean;
  /** True when an icon or colour was picked, not only a nickname. */
  readonly glyphCustomized: boolean;
  /** The name shown when no nickname is set. */
  readonly defaultName: string;
  /** True when the uncustomised look is a preset (see `defaults`), not derived from the id. */
  readonly presetDefault: boolean;
}

/** What an environment looks like before anyone customises it. */
export interface EnvironmentAppearanceDefaults {
  readonly name: string;
  readonly iconId: string;
  readonly colorId: string;
}

/**
 * The computer the client runs on: a plain "local" in blue with a laptop, so it
 * reads as "here" next to remote hosts, whose looks are derived from their ids.
 */
export const LOCAL_ENVIRONMENT_APPEARANCE_DEFAULTS: EnvironmentAppearanceDefaults = {
  name: "local",
  iconId: "laptop",
  colorId: "blue",
};

/** FNV-1a: stable across reloads and machines, which a string hash must be here. */
function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export function defaultEnvironmentColorId(environmentId: string): string {
  const option =
    ENVIRONMENT_COLOR_OPTIONS[hashString(environmentId) % ENVIRONMENT_COLOR_OPTIONS.length];
  return option?.id ?? "slate";
}

export function defaultEnvironmentIconId(environmentId: string): string {
  // Offset the hash so an id does not land on the same index in both catalogs,
  // which would correlate icon and colour across every environment.
  const option =
    ENVIRONMENT_ICON_DESCRIPTORS[
      hashString(`${environmentId}:icon`) % ENVIRONMENT_ICON_DESCRIPTORS.length
    ];
  return option?.id ?? "server";
}

export function findEnvironmentIconDescriptor(iconId: string): EnvironmentIconDescriptor {
  return (
    ENVIRONMENT_ICON_DESCRIPTORS.find((option) => option.id === iconId) ??
    ENVIRONMENT_ICON_DESCRIPTORS[0]!
  );
}

export function findEnvironmentColorOption(colorId: string): EnvironmentColorOption {
  return (
    ENVIRONMENT_COLOR_OPTIONS.find((option) => option.id === colorId) ??
    ENVIRONMENT_COLOR_OPTIONS[ENVIRONMENT_COLOR_OPTIONS.length - 1]!
  );
}

/**
 * The override a host publishes in its server settings, or undefined when it
 * has none (or the client has not received its settings yet).
 */
export function environmentAppearanceFromSettings(
  settings:
    | { readonly environmentAppearance?: EnvironmentAppearanceSetting | null | undefined }
    | null
    | undefined,
): EnvironmentAppearance | undefined {
  return settings?.environmentAppearance ?? undefined;
}

/**
 * Combine the host's override with the environment's own label and a derived
 * fallback. `label` is the connection's label, which the user may already have
 * edited in Connections; the nickname takes precedence over it.
 */
export function resolveEnvironmentIdentity(input: {
  readonly environmentId: string;
  readonly label: string;
  readonly appearance?: EnvironmentAppearance | null | undefined;
  /** Replaces the id-derived look; each stored field still wins over it. */
  readonly defaults?: EnvironmentAppearanceDefaults | undefined;
}): ResolvedEnvironmentIdentity {
  const stored = input.appearance ?? undefined;
  const nickname = stored?.nickname?.trim();
  const defaults = input.defaults;
  const icon = findEnvironmentIconDescriptor(
    stored?.iconId ?? defaults?.iconId ?? defaultEnvironmentIconId(input.environmentId),
  );
  const color = findEnvironmentColorOption(
    stored?.colorId ?? defaults?.colorId ?? defaultEnvironmentColorId(input.environmentId),
  );
  const defaultName = defaults?.name ?? input.label;

  return {
    defaultName,
    presetDefault: defaults !== undefined,
    name: nickname && nickname.length > 0 ? nickname : defaultName,
    iconId: icon.id,
    colorId: color.id,
    color: color.value,
    customized:
      stored !== undefined &&
      ((nickname !== undefined && nickname.length > 0) ||
        stored.iconId !== undefined ||
        stored.colorId !== undefined),
    glyphCustomized:
      stored !== undefined && (stored.iconId !== undefined || stored.colorId !== undefined),
  };
}

export function sanitizeEnvironmentAppearance(value: unknown): EnvironmentAppearance | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const nickname = typeof record.nickname === "string" ? record.nickname.trim() : undefined;
  const iconId =
    typeof record.iconId === "string" &&
    ENVIRONMENT_ICON_DESCRIPTORS.some((option) => option.id === record.iconId)
      ? record.iconId
      : undefined;
  const colorId =
    typeof record.colorId === "string" &&
    ENVIRONMENT_COLOR_OPTIONS.some((option) => option.id === record.colorId)
      ? record.colorId
      : undefined;
  if (!nickname && !iconId && !colorId) return null;
  return {
    ...(nickname ? { nickname } : {}),
    ...(iconId ? { iconId } : {}),
    ...(colorId ? { colorId } : {}),
  };
}

/** A whole stored map, dropping entries that sanitize to nothing. */
export function sanitizeEnvironmentAppearanceMap(
  value: unknown,
): Readonly<Record<string, EnvironmentAppearance>> {
  if (typeof value !== "object" || value === null) return {};
  const result: Record<string, EnvironmentAppearance> = {};
  for (const [environmentId, entry] of Object.entries(value as Record<string, unknown>)) {
    const sanitized = sanitizeEnvironmentAppearance(entry);
    if (sanitized !== null) result[environmentId] = sanitized;
  }
  return result;
}

/**
 * The value an editor writes to the host's `environmentAppearance` setting.
 * Unknown ids and a blank nickname are dropped, and an appearance with nothing
 * left is null, which resets the host to its derived look.
 */
export function environmentAppearanceSettingValue(
  next: EnvironmentAppearance,
): EnvironmentAppearanceSetting | null {
  const sanitized = sanitizeEnvironmentAppearance(next);
  if (sanitized === null) return null;
  const nickname = sanitized.nickname?.slice(0, ENVIRONMENT_NICKNAME_MAX_LENGTH).trim();
  if (!nickname && !sanitized.iconId && !sanitized.colorId) return null;
  return {
    ...(nickname ? { nickname } : {}),
    ...(sanitized.iconId ? { iconId: sanitized.iconId } : {}),
    ...(sanitized.colorId ? { colorId: sanitized.colorId } : {}),
  };
}
