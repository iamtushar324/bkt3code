import { remoteHttpClientLayer } from "@t3tools/client-runtime/rpc";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";

import { readDesktopPrimaryBearerToken } from "./desktopAuth";
import { resolvePrimaryEnvironmentHttpUrl } from "./target";
// T3-CUSTOM(expbkt3): BEGIN - a managed BK build authorizes with a DPoP-bound token.
import { isBkManagedPrimary } from "../../fork/managedEnvironment";
import { authorizeManagedPrimaryRequest } from "../../fork/managedPrimaryHttp";
// T3-CUSTOM(expbkt3): END

function isSameOriginBrowserPrimary(): boolean {
  if (
    typeof window === "undefined" ||
    window.desktopBridge !== undefined ||
    !window.location.origin.startsWith("http")
  ) {
    return false;
  }

  return new URL(resolvePrimaryEnvironmentHttpUrl("/")).origin === window.location.origin;
}

function withPrimaryBearerToken(client: HttpClient.HttpClient): HttpClient.HttpClient {
  // T3-CUSTOM(expbkt3): BEGIN - a managed BK build's primary token is bound to this
  // device's key, so every request carries a freshly signed proof over its own method
  // and URL. A static bearer header cannot express that.
  if (isBkManagedPrimary()) {
    return client.pipe(
      HttpClient.mapRequestEffect((request) =>
        Effect.promise(() => authorizeManagedPrimaryRequest(request)),
      ),
    );
  }
  // T3-CUSTOM(expbkt3): END
  return client.pipe(
    HttpClient.mapRequestEffect((request) =>
      Effect.promise(readDesktopPrimaryBearerToken).pipe(
        Effect.map((bearerToken) =>
          bearerToken ? HttpClientRequest.bearerToken(request, bearerToken) : request,
        ),
      ),
    ),
  );
}

export function makePrimaryEnvironmentHttpLayer() {
  return Layer.unwrap(
    Effect.sync(() => {
      const baseLayer = remoteHttpClientLayer(globalThis.fetch);
      if (isSameOriginBrowserPrimary()) {
        return Layer.merge(
          baseLayer,
          Layer.succeed(FetchHttpClient.RequestInit, { credentials: "include" }),
        );
      }

      const bearerClientLayer = Layer.effect(
        HttpClient.HttpClient,
        Effect.map(HttpClient.HttpClient, withPrimaryBearerToken),
      ).pipe(Layer.provide(baseLayer));

      return Layer.merge(
        bearerClientLayer,
        Layer.succeed(FetchHttpClient.RequestInit, { credentials: "omit" }),
      );
    }),
  );
}

export const primaryEnvironmentHttpLayer = makePrimaryEnvironmentHttpLayer();
