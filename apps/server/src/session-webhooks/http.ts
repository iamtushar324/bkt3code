/** T3-CUSTOM(expbkt3): unauthenticated transport, authenticated by Standard Webhooks signatures. */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as ByteSize from "effect/ByteSize";
import * as Layer from "effect/Layer";
import {
  HttpIncomingMessage,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import { SessionWebhookError } from "@t3tools/contracts";
import { SessionWebhookService } from "./SessionWebhookService.ts";
import { MAX_CALLBACK_BYTES } from "./protocol.ts";
const isSessionWebhookError = Schema.is(SessionWebhookError);
export const sessionWebhookRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const service = yield* SessionWebhookService;
    const receive = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const declaredLength = request.headers["content-length"];
      if (
        declaredLength &&
        (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_CALLBACK_BYTES)
      )
        return HttpServerResponse.jsonUnsafe({ error: "callback-too-large" }, { status: 413 });
      if (request.headers["content-type"]?.split(";")[0]?.trim() !== "application/json")
        return HttpServerResponse.jsonUnsafe({ error: "json-required" }, { status: 415 });
      const params = yield* HttpRouter.params;
      const body = yield* request.text.pipe(
        Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.bytes(MAX_CALLBACK_BYTES)),
      );
      if (Buffer.byteLength(body) > MAX_CALLBACK_BYTES)
        return HttpServerResponse.jsonUnsafe({ error: "callback-too-large" }, { status: 413 });
      return HttpServerResponse.jsonUnsafe(
        yield* service.receive(params.webhookId ?? "", body, {
          id: request.headers["webhook-id"],
          timestamp: request.headers["webhook-timestamp"],
          signature: request.headers["webhook-signature"],
        }),
        { status: 202, headers: { "cache-control": "no-store" } },
      );
    }).pipe(
      Effect.catch((error) =>
        isSessionWebhookError(error)
          ? Effect.succeed(
              HttpServerResponse.jsonUnsafe({ error: error.detail }, { status: error.status }),
            )
          : Effect.succeed(
              HttpServerResponse.jsonUnsafe(
                { error: "callback-storage-unavailable" },
                { status: 503 },
              ),
            ),
      ),
    );
    return HttpRouter.add("POST", "/api/session-webhooks/:webhookId", receive);
  }),
);
