import type { AuthSessionState } from "@t3tools/contracts";
import { UserId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { operatorUserIdFromSessionState } from "./environmentOperatorIdentity";

const OPERATOR_USER_ID = UserId.make("user_2abcDEF");

const descriptor: AuthSessionState["auth"] = {
  policy: "remote-reachable",
  bootstrapMethods: ["one-time-token"],
  sessionMethods: ["bearer-access-token"],
  sessionCookieName: "t3code_session",
};

describe("operatorUserIdFromSessionState", () => {
  it("resolves the operator from a team-mode session", () => {
    expect(
      operatorUserIdFromSessionState({
        authenticated: true,
        auth: descriptor,
        userId: OPERATOR_USER_ID,
      }),
    ).toBe(OPERATOR_USER_ID);
  });

  it("is null for a session with no operator (single-user or local environment)", () => {
    expect(operatorUserIdFromSessionState({ authenticated: true, auth: descriptor })).toBeNull();
  });

  it("is null before the session is authenticated, and while it is still loading", () => {
    expect(
      operatorUserIdFromSessionState({
        authenticated: false,
        auth: descriptor,
        userId: OPERATOR_USER_ID,
      }),
    ).toBeNull();
    expect(operatorUserIdFromSessionState(null)).toBeNull();
  });
});
