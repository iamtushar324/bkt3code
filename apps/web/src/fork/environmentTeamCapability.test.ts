/**
 * T3-CUSTOM(expbkt3): member surfaces are scoped to their own environment.
 *
 * The bug these guard against: a managed desktop paired to a central team server
 * *and* running its bundled local backend showed a working member picker on the
 * local backend's threads, listing the central server's roster. Ticking a
 * teammate wrote a user id the local backend has never heard of.
 */
import type { EnvironmentId, ServerAuthDescriptor, ServerConfig } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  filterTeamCapableEnvironments,
  serverAuthDescriptorSupportsTeam,
  serverConfigSupportsTeam,
  shouldRenderMemberSurface,
} from "./environmentTeamCapability";

/**
 * What a team-mode server advertises: an ordinary bootstrap method list plus a
 * `clerk` descriptor. Deliberately no fork-only bootstrap method — that union is
 * closed in stock clients, and widening it made our config undecodable for them.
 */
const teamDescriptor: ServerAuthDescriptor = {
  policy: "remote-reachable",
  bootstrapMethods: ["one-time-token"],
  sessionMethods: ["browser-session-cookie", "bearer-access-token", "dpop-access-token"],
  sessionCookieName: "t3code_session",
  clerk: { publishableKey: "pk_test_x", organizationId: "org_1" },
};

/** What the desktop's bundled local backend advertises: neither. */
const localBackendDescriptor: ServerAuthDescriptor = {
  policy: "desktop-managed-local",
  bootstrapMethods: ["desktop-bootstrap", "one-time-token"],
  sessionMethods: ["browser-session-cookie", "bearer-access-token"],
  sessionCookieName: "t3code_session",
};

const configWith = (auth: ServerAuthDescriptor): ServerConfig => ({ auth }) as ServerConfig;

describe("reading team capability off a server auth descriptor", () => {
  it("is true for a team-mode server", () => {
    expect(serverAuthDescriptorSupportsTeam(teamDescriptor)).toBe(true);
  });

  it("is false for the bundled local backend", () => {
    expect(serverAuthDescriptorSupportsTeam(localBackendDescriptor)).toBe(false);
  });

  it("reads the clerk descriptor, not the bootstrap method list", () => {
    // Dropping the descriptor makes it not-team even though nothing else changed:
    // team mode must never be inferred from a bootstrap method again.
    const { clerk: _clerk, ...withoutClerk } = teamDescriptor;
    expect(serverAuthDescriptorSupportsTeam(withoutClerk)).toBe(false);

    // Conversely the descriptor alone is enough, whatever the method list says.
    expect(
      serverAuthDescriptorSupportsTeam({
        ...localBackendDescriptor,
        clerk: { publishableKey: "pk_test_x", organizationId: null },
      }),
    ).toBe(true);
  });

  it("reads absent config as not-team, which is the safe direction", () => {
    expect(serverAuthDescriptorSupportsTeam(null)).toBe(false);
    expect(serverAuthDescriptorSupportsTeam(undefined)).toBe(false);
    expect(serverConfigSupportsTeam(null)).toBe(false);
    expect(serverConfigSupportsTeam(configWith(teamDescriptor))).toBe(true);
  });
});

describe("whether a member surface renders", () => {
  const OPERATOR = "user_1";

  it("renders on a team environment with an operator, exactly as before", () => {
    expect(
      shouldRenderMemberSurface({ currentUserId: OPERATOR, environmentSupportsTeam: true }),
    ).toBe(true);
  });

  it("renders nothing on a non-team environment even with a non-null identity", () => {
    // The regression: identity is global and non-null because the desktop paired
    // with the central server, but this thread belongs to the local backend.
    expect(
      shouldRenderMemberSurface({ currentUserId: OPERATOR, environmentSupportsTeam: false }),
    ).toBe(false);
  });

  it("renders nothing without an identity, as today", () => {
    expect(shouldRenderMemberSurface({ currentUserId: null, environmentSupportsTeam: true })).toBe(
      false,
    );
    expect(shouldRenderMemberSurface({ currentUserId: null, environmentSupportsTeam: false })).toBe(
      false,
    );
  });
});

describe("listing projects across environments", () => {
  const TEAM = "env-team" as EnvironmentId;
  const LOCAL = "env-local" as EnvironmentId;
  const configs = new Map<EnvironmentId, ServerConfig>([
    [TEAM, configWith(teamDescriptor)],
    [LOCAL, configWith(localBackendDescriptor)],
  ]);

  it("keeps only projects whose own environment can store members", () => {
    const projects = [
      { id: "a", environmentId: TEAM },
      { id: "b", environmentId: LOCAL },
      { id: "c", environmentId: "env-unknown" as EnvironmentId },
    ];
    expect(
      filterTeamCapableEnvironments(projects, configs, (project) => project.environmentId).map(
        (project) => project.id,
      ),
    ).toEqual(["a"]);
  });
});
