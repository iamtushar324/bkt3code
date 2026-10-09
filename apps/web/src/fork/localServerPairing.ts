// T3-CUSTOM(expbkt3): pairing links on the managed desktop's bundled local backend.
/**
 * Upstream's pairing helpers (`environments/primary/auth.ts`) always talk to the
 * primary environment, which in a managed BK build is the central server. These
 * two calls target the bundled backend instead, through the renderer's existing
 * bearer connection to it.
 *
 * They deliberately reuse that connection's credential. Exchanging the desktop
 * bootstrap token again would make the server replace the renderer's own
 * session on the backend (`replaceActiveForSubjectAndMethod`) and drop it.
 *
 * @module fork/localServerPairing
 */
import { environmentEndpointUrl } from "@t3tools/client-runtime/environment";
import {
  executeEnvironmentHttpRequest,
  layerRemoteHttpClient,
  makeEnvironmentHttpApiGroupClient,
} from "@t3tools/client-runtime/rpc";
import type {
  AuthGrantScope,
  AuthPairingCredentialResult,
  EnvironmentId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type { HttpClient } from "effect/http";

import { readPreparedConnection } from "../state/session";

const LOCAL_SERVER_REQUEST_TIMEOUT_MS = 10_000;

// The same remote client the app runtime builds (`lib/runtime.ts`); the bearer
// header travels per request, so no cookie or primary-only layer is involved.
const layerHttpClient = layerRemoteHttpClient((input, init) => globalThis.fetch(input, init));

interface LocalServerBearer {
  readonly httpBaseUrl: string;
  readonly authorization: string;
}

function readLocalServerBearer(environmentId: EnvironmentId): LocalServerBearer {
  const prepared = readPreparedConnection(environmentId);
  if (prepared === null) {
    throw new Error("The local server is not connected yet. Wait a moment and try again.");
  }
  const authorization = prepared.httpAuthorization;
  if (authorization?._tag !== "Bearer") {
    throw new Error("The connection to the local server has no bearer credential.");
  }
  return {
    httpBaseUrl: prepared.httpBaseUrl,
    authorization: `Bearer ${authorization.token}`,
  };
}

async function runLocalServerRequest<A, E>(
  request: Effect.Effect<A, E, HttpClient.HttpClient>,
): Promise<A> {
  const exit = await Effect.runPromiseExit(request.pipe(Effect.provide(layerHttpClient)));
  if (Exit.isSuccess(exit)) return exit.value;
  throw Cause.squash(exit.cause);
}

/** Mint a pairing credential on the bundled backend (`POST /api/auth/pairing-token`). */
export async function createLocalServerPairingCredential(
  environmentId: EnvironmentId,
  input: { readonly label: string; readonly scopes: ReadonlyArray<AuthGrantScope> },
): Promise<AuthPairingCredentialResult> {
  const bearer = readLocalServerBearer(environmentId);
  return await runLocalServerRequest(
    Effect.gen(function* () {
      const client = yield* makeEnvironmentHttpApiGroupClient(bearer.httpBaseUrl, "auth");
      return yield* executeEnvironmentHttpRequest(
        environmentEndpointUrl(bearer.httpBaseUrl, "/api/auth/pairing-token"),
        LOCAL_SERVER_REQUEST_TIMEOUT_MS,
        client.pairingCredential({
          headers: { authorization: bearer.authorization },
          payload: { label: input.label, scopes: input.scopes },
        }),
      );
    }),
  );
}

/** Revoke an unused pairing link on the bundled backend; resolves to whether one was found. */
export async function revokeLocalServerPairingLink(
  environmentId: EnvironmentId,
  id: string,
): Promise<boolean> {
  const bearer = readLocalServerBearer(environmentId);
  return await runLocalServerRequest(
    Effect.gen(function* () {
      const client = yield* makeEnvironmentHttpApiGroupClient(bearer.httpBaseUrl, "auth");
      const result = yield* executeEnvironmentHttpRequest(
        environmentEndpointUrl(bearer.httpBaseUrl, "/api/auth/pairing-links/revoke"),
        LOCAL_SERVER_REQUEST_TIMEOUT_MS,
        client.revokePairingLink({
          headers: { authorization: bearer.authorization },
          payload: { id },
        }),
      );
      return result.revoked;
    }),
  );
}
