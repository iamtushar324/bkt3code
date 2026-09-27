import { EnvironmentUserId, EnvironmentUserManagementError } from "@t3tools/contracts";
import { verifyClerkIdentityJwt } from "@t3tools/shared/clerkIdentity";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { buildTimeClerkPublishableKey } from "../cloud/publicConfig.ts";

export const CLERK_IDENTITY_AUDIENCE = "t3-code-relay";

export interface VerifiedClerkIdentity {
  readonly userId: EnvironmentUserId;
  readonly displayName: string | null;
  readonly primaryEmail: string | null;
  readonly avatarUrl: string | null;
}

export type ClerkTokenVerification = (token: string) => Effect.Effect<unknown, Error>;

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readClaim(claims: unknown, ...names: ReadonlyArray<string>): unknown {
  if (typeof claims !== "object" || claims === null || Array.isArray(claims)) return undefined;
  const record = claims as Record<string, unknown>;
  for (const name of names) {
    if (Object.hasOwn(record, name)) return record[name];
  }
  return undefined;
}

const identityError = (reason: "identity-not-configured" | "identity-invalid", detail: string) =>
  new EnvironmentUserManagementError({
    operation: "verify-identity",
    reason,
    detail,
  });

export function makeClerkIdentityVerifier(verifyToken: ClerkTokenVerification) {
  const verify = Effect.fn("ClerkIdentityVerifier.verify")(function* (token: string) {
    const claims = yield* verifyToken(token).pipe(
      Effect.mapError(() =>
        identityError("identity-invalid", "The Clerk session is invalid or expired."),
      ),
    );
    const subject = optionalString(readClaim(claims, "sub"));
    if (!subject) {
      return yield* identityError(
        "identity-invalid",
        "The verified Clerk session has no user subject.",
      );
    }
    return {
      userId: EnvironmentUserId.make(subject),
      displayName: optionalString(readClaim(claims, "name", "full_name")),
      primaryEmail: optionalString(readClaim(claims, "email", "primary_email")),
      avatarUrl: optionalString(readClaim(claims, "picture", "avatar", "avatar_url")),
    } satisfies VerifiedClerkIdentity;
  });
  return { verify } as const;
}

export class ClerkIdentityVerifier extends Context.Service<
  ClerkIdentityVerifier,
  ReturnType<typeof makeClerkIdentityVerifier>
>()("t3/auth/ClerkIdentityVerifier") {}

export const layer = Layer.effect(
  ClerkIdentityVerifier,
  Effect.sync(() => {
    const publishableKey =
      process.env.T3CODE_CLERK_PUBLISHABLE_KEY?.trim() || buildTimeClerkPublishableKey.trim();
    if (!publishableKey) {
      return makeClerkIdentityVerifier(() =>
        Effect.fail(
          identityError(
            "identity-not-configured",
            "Clerk identity verification is not configured on this environment.",
          ),
        ),
      );
    }
    const audience = process.env.T3CODE_CLERK_JWT_AUDIENCE?.trim() || CLERK_IDENTITY_AUDIENCE;
    return makeClerkIdentityVerifier((token) =>
      verifyClerkIdentityJwt({ token, publishableKey, audience }),
    );
  }),
);
