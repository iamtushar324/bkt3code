import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { makeClerkIdentityVerifier, type ClerkTokenVerification } from "./ClerkIdentityVerifier.ts";

const verifiedClaims = {
  sub: "user_clerk_alice",
  name: "Alice Example",
  email: "alice@example.com",
  picture: "https://images.example.com/alice.png",
};

it.effect("returns only normalized identity claims from a verified Clerk token", () =>
  Effect.gen(function* () {
    const verification: ClerkTokenVerification = () => Effect.succeed(verifiedClaims);
    const verifier = makeClerkIdentityVerifier(verification);

    const identity = yield* verifier.verify("signed-token-secret");

    expect(identity).toEqual({
      userId: "user_clerk_alice",
      displayName: "Alice Example",
      primaryEmail: "alice@example.com",
      avatarUrl: "https://images.example.com/alice.png",
    });
  }),
);

it.effect("rejects missing subjects and does not place token material in the error", () =>
  Effect.gen(function* () {
    const token = "signed-token-secret";
    const verification: ClerkTokenVerification = () => Effect.succeed({ email: "a@example.com" });
    const verifier = makeClerkIdentityVerifier(verification);

    const error = yield* Effect.flip(verifier.verify(token));

    expect(error.reason).toBe("identity-invalid");
    expect(error.message).not.toContain(token);
    expect(String(error)).not.toContain(token);
  }),
);
