/**
 * T3-CUSTOM(expbkt3): authorizing primary HTTP requests in a managed BK build.
 *
 * A bearer token is a static header. A DPoP-bound token is not: the server pins
 * the session to a key thumbprint and requires a proof signed over *this*
 * request's method and URL, with the access token hashed into it. So the
 * managed primary cannot reuse upstream's `HttpClientRequest.bearerToken` path
 * and signs per request instead.
 *
 * Mirrors what `client-runtime`'s `buildEnvironmentAuthHeaders` already does for
 * relay connections — same headers, same shape — but reads its token and key
 * from the fork's managed-primary store rather than the relay token store.
 *
 * With no token yet, the request goes out unauthenticated on purpose: the
 * server answers 401, and the auth gate shows the pairing prompt.
 *
 * @module fork/managedPrimaryHttp
 */
import { HttpClientRequest } from "effect/unstable/http";

import { resolvePrimaryEnvironmentHttpUrl } from "../environments/primary/target";
import { readManagedPrimaryAccessToken } from "./managedPrimaryCredential";
import { createManagedPrimaryDpopProof } from "./managedPrimaryDpop";

/**
 * The absolute URL a DPoP proof must be bound to.
 *
 * `HttpClientRequest.url` may be relative to the client's base URL, and the
 * server verifies `htu` against the URL it actually received, so a relative
 * value would fail verification rather than merely look untidy.
 */
export function resolveManagedPrimaryProofUrl(requestUrl: string): string {
  const baseUrl = resolvePrimaryEnvironmentHttpUrl("/");
  try {
    return new URL(requestUrl, baseUrl).toString();
  } catch {
    return requestUrl;
  }
}

/** Attach `Authorization: DPoP <token>` plus a freshly signed proof. */
export async function authorizeManagedPrimaryRequest(
  request: HttpClientRequest.HttpClientRequest,
): Promise<HttpClientRequest.HttpClientRequest> {
  const accessToken = await readManagedPrimaryAccessToken();
  if (accessToken === null) {
    return request;
  }
  const proof = await createManagedPrimaryDpopProof({
    method: request.method,
    url: resolveManagedPrimaryProofUrl(request.url),
    accessToken,
  });
  if (proof === null) {
    return request;
  }
  return HttpClientRequest.setHeaders(request, {
    authorization: `DPoP ${accessToken}`,
    dpop: proof,
  });
}
