/**
 * T3-CUSTOM(expbkt3): the DPoP authorization a managed primary connection uses.
 *
 * `PrimaryEnvironmentAuth.dpopAuthorization` is the seam the connection resolver
 * reads to decide whether the primary environment is bearer-authenticated (every
 * ordinary build) or bound to this device's key (a managed BK build). It hands
 * the runtime an access token plus a callback, never the key itself — the
 * non-extractable `CryptoKey` stays behind `fork/managedPrimaryDpop`.
 *
 * The websocket ticket is issued here rather than in the resolver so the
 * resolver keeps its existing service requirements. It costs nothing: the
 * primary HTTP layer already signs a DPoP proof for every request it sends, so
 * asking it for a ticket is an ordinary authenticated call.
 *
 * `Option.none()` until the operator has paired, which leaves the connection
 * waiting on the auth gate instead of failing.
 *
 * @module fork/managedPrimaryConnection
 */
import { ConnectionBlockedError } from "@t3tools/client-runtime/connection";
import type { PrimaryDpopAuthorization } from "@t3tools/client-runtime/platform";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { PrimaryEnvironmentHttpClient } from "../environments/primary/httpClient";
import { runPrimaryHttp } from "../lib/runtime";
import { isBkManagedPrimary } from "./managedEnvironment";
import { readManagedPrimaryCredential } from "./managedPrimaryCredential";

/** `wsBaseUrl` plus the issued ticket, matching the remote/relay socket URL shape. */
export function managedPrimarySocketUrl(wsBaseUrl: string, ticket: string): string {
  const url = new URL(wsBaseUrl);
  if (url.pathname === "" || url.pathname === "/") {
    url.pathname = "/ws";
  }
  url.searchParams.set("wsTicket", ticket);
  return url.toString();
}

async function issueManagedPrimaryWebSocketTicket(): Promise<string> {
  const issued = await runPrimaryHttp(
    PrimaryEnvironmentHttpClient.pipe(
      Effect.flatMap((client) => client.auth.webSocketTicket({ headers: {} })),
    ),
  );
  return issued.ticket;
}

export function makeManagedPrimaryDpopAuthorization(
  accessToken: string,
  expiresAtEpochMs: number,
): PrimaryDpopAuthorization {
  return {
    accessToken,
    expiresAtEpochMs,
    resolveSocketUrl: (input: { readonly wsBaseUrl: string }) =>
      Effect.tryPromise({
        try: issueManagedPrimaryWebSocketTicket,
        catch: (cause): ConnectionBlockedError =>
          new ConnectionBlockedError({
            reason: "authentication",
            detail: `Could not issue a websocket ticket for the managed environment: ${String(cause)}`,
          }),
      }).pipe(Effect.map((ticket) => managedPrimarySocketUrl(input.wsBaseUrl, ticket))),
  };
}

export const readManagedPrimaryDpopAuthorization: Effect.Effect<
  Option.Option<PrimaryDpopAuthorization>,
  never
> = Effect.suspend(() => {
  if (!isBkManagedPrimary()) {
    return Effect.succeed(Option.none());
  }
  return Effect.promise(readManagedPrimaryCredential).pipe(
    Effect.map((credential) =>
      credential === null
        ? Option.none()
        : Option.some(
            makeManagedPrimaryDpopAuthorization(
              credential.accessToken,
              credential.expiresAtEpochMs,
            ),
          ),
    ),
  );
});
