/**
 * T3-CUSTOM(expbkt3): is *this* environment a team environment?
 *
 * Member tagging and project access are team-mode features, but the client
 * decided whether to show them from one app-wide signal: a non-null
 * `useCurrentUserId()`. That was accurate while the only team environment a
 * client could have was the one it signed into.
 *
 * It stopped being accurate once a managed BK desktop could point its *primary*
 * environment at a central team server while the bundled local backend stayed
 * connected alongside it. Opening a thread on the local backend then showed a
 * fully working member picker listing the central server's roster, and ticking
 * a teammate wrote a user id the local backend has never heard of. It looked
 * like it worked and could not.
 *
 * The environment's own server config already answers the question. A team-mode
 * server advertises a `clerk` descriptor; a single-user backend does not. So the
 * gate is per-environment and needs no new wire format — `ServerConfig.auth` is
 * already streamed per environment and cached by `state/server`.
 *
 * @module fork/environmentTeamCapability
 */
import type { EnvironmentId, ServerAuthDescriptor, ServerConfig } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";

import { serverEnvironment } from "../state/server";

/**
 * Whether a server auth descriptor describes a team-mode environment.
 *
 * The `clerk` descriptor is the only signal. An earlier version also accepted a
 * fork-only `clerk-session` entry in `bootstrapMethods`; that entry is gone,
 * because adding it to a closed literal union stock clients decode made the
 * whole server config undecodable for them.
 *
 * Absent config reads as "not team", so the surfaces stay hidden until the
 * environment has actually told us what it is — the safe direction, since the
 * failure this prevents is writing member ids to a server that cannot store
 * them.
 */
export function serverAuthDescriptorSupportsTeam(
  auth: ServerAuthDescriptor | null | undefined,
): boolean {
  if (!auth) {
    return false;
  }
  return auth.clerk !== undefined;
}

/** Whether a cached server config belongs to a team-mode environment. */
export function serverConfigSupportsTeam(config: ServerConfig | null | undefined): boolean {
  return serverAuthDescriptorSupportsTeam(config?.auth);
}

/**
 * The subset of environments that support team features.
 *
 * For surfaces that list across environments — project access, say — so a
 * "Manage" affordance never appears for an environment whose dialog would then
 * refuse to render.
 */
export function filterTeamCapableEnvironments<T>(
  items: ReadonlyArray<T>,
  serverConfigs: ReadonlyMap<EnvironmentId, ServerConfig>,
  environmentIdOf: (item: T) => EnvironmentId,
): ReadonlyArray<T> {
  return items.filter((item) => serverConfigSupportsTeam(serverConfigs.get(environmentIdOf(item))));
}

/**
 * Whether the given environment supports team features.
 *
 * Gate every surface that reads or writes *that environment's* members on this
 * rather than on global identity. `useCurrentUserId()` still answers "who am I",
 * which is a different question and stays global.
 */
/**
 * Both conditions a member/assignment surface needs: an operator to act as, and
 * an environment that can actually store what they do.
 *
 * Extracted so the rule is asserted directly. The components it guards pull in
 * routing, the atom registry and several async atoms, so a rendered-tree test
 * would assert mostly harness.
 */
export function shouldRenderMemberSurface(input: {
  readonly currentUserId: unknown;
  readonly environmentSupportsTeam: boolean;
}): boolean {
  return input.currentUserId !== null && input.environmentSupportsTeam;
}

/**
 * Whether the given environment supports team features.
 *
 * Gate every surface that reads or writes *that environment's* members on this
 * rather than on global identity. `useCurrentUserId()` still answers "who am I",
 * which is a different question and stays global.
 */
export function useEnvironmentSupportsTeam(environmentId: EnvironmentId | null): boolean {
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  return serverConfigSupportsTeam(config);
}
