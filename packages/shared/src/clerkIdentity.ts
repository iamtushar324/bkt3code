import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { clerkFrontendApiUrlFromPublishableKey } from "./relayAuth.ts";

export class ClerkIdentityJwtVerificationError extends Schema.TaggedError<ClerkIdentityJwtVerificationError>()(
  "ClerkIdentityJwtVerificationError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "The Clerk identity token could not be verified.";
  }
}

const jwksByUrl = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function remoteJwks(url: string) {
  const existing = jwksByUrl.get(url);
  if (existing) return existing;
  const created = createRemoteJWKSet(new URL(url));
  jwksByUrl.set(url, created);
  return created;
}

export function verifyClerkIdentityJwt(input: {
  readonly token: string;
  readonly publishableKey: string;
  readonly audience: string;
}): Effect.Effect<JWTPayload, ClerkIdentityJwtVerificationError> {
  return Effect.tryPromise({
    try: async () => {
      const issuer = clerkFrontendApiUrlFromPublishableKey(input.publishableKey);
      const verified = await jwtVerify(input.token, remoteJwks(`${issuer}/.well-known/jwks.json`), {
        algorithms: ["RS256"],
        issuer,
        audience: input.audience,
        clockTolerance: 5,
      });
      return verified.payload;
    },
    catch: (cause) => new ClerkIdentityJwtVerificationError({ cause }),
  });
}
