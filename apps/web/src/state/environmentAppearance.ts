/**
 * T3-CUSTOM(expbkt3): environmentAppearance - per-environment nickname, icon and colour.
 *
 * Once a client is attached to more than one environment, every list that mixes
 * their data reads as duplicates: the same repository name and the same path
 * appear twice with nothing to say which machine each row came from. This module
 * owns the identity we attach to an environment so those surfaces can tell them
 * apart.
 *
 * Two decisions worth keeping:
 *
 * - **Appearance is client-local.** A known environment is already a browser-local
 *   record (see `connection/catalog.ts`); the server has no concept of "what this
 *   machine is called to me". Storing a nickname server-side would also make it
 *   shared, when the whole point is that each operator labels their own fleet.
 * - **Every environment gets a distinct look before anyone configures one.** The
 *   fallback is derived from the environment id, so the second machine you attach
 *   is immediately distinguishable without a settings trip. Customising only
 *   overrides the derived value.
 *
 * Colours are applied as inline values rather than Tailwind classes on purpose:
 * the palette is chosen at runtime by the user, and class names assembled at
 * runtime are not statically discoverable by the compiler.
 *
 * @module state/environmentAppearance
 */
import {
  BoxIcon,
  CloudIcon,
  CodeIcon,
  ContainerIcon,
  CpuIcon,
  DatabaseIcon,
  FlaskConicalIcon,
  GlobeIcon,
  HouseIcon,
  LaptopIcon,
  type LucideIcon,
  RocketIcon,
  ServerIcon,
  TerminalIcon,
  WrenchIcon,
  ZapIcon,
} from "lucide-react";

import {
  defaultEnvironmentColorId,
  defaultEnvironmentIconId,
  ENVIRONMENT_COLOR_OPTIONS,
  ENVIRONMENT_ICON_DESCRIPTORS,
  resolveEnvironmentIdentity,
  sanitizeEnvironmentAppearance,
  type EnvironmentAppearance,
  type EnvironmentColorOption,
  type ResolvedEnvironmentIdentity,
} from "@t3tools/client-runtime/state/environment-appearance";

// The catalogue, the derived fallback and the sanitizer live in client-runtime so
// the phone and the browser agree on what an environment looks like. This module
// adds the Lucide glyph for each icon id and keeps the web-facing names.
export {
  defaultEnvironmentColorId,
  defaultEnvironmentIconId,
  ENVIRONMENT_COLOR_OPTIONS,
  sanitizeEnvironmentAppearance,
  type EnvironmentAppearance,
  type EnvironmentColorOption,
};

export interface EnvironmentIconOption {
  readonly id: string;
  readonly label: string;
  readonly Icon: LucideIcon;
}

const LUCIDE_ICON_BY_ID: Readonly<Record<string, LucideIcon>> = {
  server: ServerIcon,
  laptop: LaptopIcon,
  cloud: CloudIcon,
  home: HouseIcon,
  cpu: CpuIcon,
  container: ContainerIcon,
  database: DatabaseIcon,
  flask: FlaskConicalIcon,
  rocket: RocketIcon,
  globe: GlobeIcon,
  terminal: TerminalIcon,
  code: CodeIcon,
  wrench: WrenchIcon,
  zap: ZapIcon,
  box: BoxIcon,
};

export const ENVIRONMENT_ICON_OPTIONS: ReadonlyArray<EnvironmentIconOption> =
  ENVIRONMENT_ICON_DESCRIPTORS.map((descriptor) => ({
    ...descriptor,
    Icon: LUCIDE_ICON_BY_ID[descriptor.id] ?? ServerIcon,
  }));

export interface ResolvedEnvironmentAppearance extends ResolvedEnvironmentIdentity {
  readonly Icon: LucideIcon;
}

/**
 * Combine the stored overrides with the environment's own label and a derived
 * fallback. `label` is the connection's label, which the user may already have
 * edited in Connections; the nickname takes precedence over it.
 */
export function resolveEnvironmentAppearance(input: {
  readonly environmentId: string;
  readonly label: string;
  readonly appearance?: EnvironmentAppearance | undefined;
}): ResolvedEnvironmentAppearance {
  const identity = resolveEnvironmentIdentity(input);
  return { ...identity, Icon: LUCIDE_ICON_BY_ID[identity.iconId] ?? ServerIcon };
}

/** A translucent fill derived from the accent, so one palette drives both. */
export function environmentAccentSurface(color: string): string {
  return `color-mix(in srgb, ${color} 16%, transparent)`;
}

export function environmentAccentBorder(color: string): string {
  return `color-mix(in srgb, ${color} 40%, transparent)`;
}
