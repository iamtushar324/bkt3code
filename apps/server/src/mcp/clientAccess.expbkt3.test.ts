/** T3-CUSTOM(expbkt3): Settings credentials and OAuth sign-ins share upstream's client model. */
import { describe, expect, it } from "@effect/vitest";
import { UserId } from "@t3tools/contracts";

import {
  clientAccessFromCapabilities,
  oauthClientForkFields,
  settingsCredentialClientScope,
} from "./clientAccess.expbkt3.ts";

describe("clientAccessFromCapabilities", () => {
  it("is read-only only when every fork capability reads", () => {
    expect(clientAccessFromCapabilities(["t3.read"])).toBe("read-only");
    expect(clientAccessFromCapabilities([])).toBe("read-only");
    expect(clientAccessFromCapabilities(["t3.read", "t3.control"])).toBe("full-access");
    expect(clientAccessFromCapabilities(["pull-requests", "t3.read"])).toBe("full-access");
  });
});

describe("settingsCredentialClientScope", () => {
  it("adds upstream's client capabilities and keeps the fork's", () => {
    const scope = settingsCredentialClientScope({
      principal: "external-operator",
      actorUserId: null,
      sessionId: "external-operator",
      label: "External MCP operator",
      forkCapabilities: ["pull-requests", "t3.read", "t3.control", "t3.plan"],
    });
    expect(scope.client).toEqual({
      sessionId: "external-operator",
      label: "External MCP operator",
      access: "full-access",
    });
    expect([...scope.capabilities].toSorted()).toEqual(
      ["orchestration", "pull-requests", "t3.control", "t3.plan", "t3.read", "worktree"].toSorted(),
    );
  });
});

describe("oauthClientForkFields", () => {
  it("binds an approval that names a team user to that user", () => {
    const userId = UserId.make("user_clerk_alice");
    expect(oauthClientForkFields({ access: "auto", userId })).toMatchObject({
      principal: "external-user",
      actorUserId: userId,
    });
  });

  it("leaves an unbound approval without a team boundary, as upstream", () => {
    expect(oauthClientForkFields({ access: "full-access", userId: null })).toMatchObject({
      principal: "external-operator",
      actorUserId: null,
    });
  });

  it("gives a read-only client only the fork's read capability", () => {
    expect(oauthClientForkFields({ access: "read-only", userId: null }).forkCapabilities).toEqual([
      "t3.read",
    ]);
  });
});
