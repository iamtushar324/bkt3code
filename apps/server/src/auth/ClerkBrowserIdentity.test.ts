import { EnvironmentUserId, UserId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { resolveClerkBrowserIdentity } from "./ClerkBrowserIdentity.ts";
import { ClerkDirectory, type ClerkDirectoryShape } from "./ClerkDirectory.ts";

it.effect("resolves direct Clerk session tokens through the org directory", () =>
  Effect.gen(function* () {
    const userId = UserId.make("user_clerk_alice");
    const directory: ClerkDirectoryShape = {
      enabled: true,
      descriptor: null,
      verifySessionToken: (token) => {
        expect(token).toBe("direct-browser-session-token");
        return Effect.succeed({ userId, subject: `clerk:${userId}` });
      },
      listOrgMembers: () =>
        Effect.succeed([
          {
            id: userId,
            name: "Alice Example",
            email: "alice@example.com",
            imageUrl: "https://img.example/alice.png",
            isAdmin: true,
          },
        ]),
      isOrgAdmin: () => Effect.succeed(true),
      findUserIdByEmail: () => Effect.succeed(userId),
    };

    const result = yield* resolveClerkBrowserIdentity("direct-browser-session-token").pipe(
      Effect.provideService(ClerkDirectory, directory),
    );

    expect(result).toEqual({
      identity: {
        userId: EnvironmentUserId.make("user_clerk_alice"),
        displayName: "Alice Example",
        primaryEmail: "alice@example.com",
        avatarUrl: "https://img.example/alice.png",
      },
      subject: "clerk:user_clerk_alice",
      administrativeGrant: true,
    });
  }),
);
