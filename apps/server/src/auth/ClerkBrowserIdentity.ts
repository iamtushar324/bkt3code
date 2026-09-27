import { EnvironmentUserId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { ClerkDirectory } from "./ClerkDirectory.ts";
import type { VerifiedClerkIdentity } from "./ClerkIdentityVerifier.ts";

export interface VerifiedClerkBrowserIdentity {
  readonly identity: VerifiedClerkIdentity;
  readonly subject: string;
  readonly administrativeGrant: boolean;
}

/** Resolve a direct Clerk browser-session token into the environment user model. */
export const resolveClerkBrowserIdentity = Effect.fn("ClerkBrowserIdentity.resolve")(function* (
  token: string,
) {
  const directory = yield* ClerkDirectory;
  const verified = yield* directory.verifySessionToken(token);
  const members = yield* directory.listOrgMembers();
  const member = members.find((candidate) => candidate.id === verified.userId);

  return {
    identity: {
      userId: EnvironmentUserId.make(verified.userId),
      displayName: member?.name ?? null,
      primaryEmail: member?.email ?? null,
      avatarUrl: member?.imageUrl ?? null,
    },
    subject: verified.subject,
    administrativeGrant: member?.isAdmin ?? false,
  } satisfies VerifiedClerkBrowserIdentity;
});
