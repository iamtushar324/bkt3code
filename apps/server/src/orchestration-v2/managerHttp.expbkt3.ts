/** T3-CUSTOM(expbkt3): only a user's explicit personal MCP grant authenticates this bridge surface. */
import { CommandId, ThreadId } from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { McpSessionRegistry } from "../mcp/McpSessionRegistry.ts";
import { parseEventFeedQuery } from "./eventFeedHttp.expbkt3.ts";
import * as Manager from "./ManagerService.expbkt3.ts";

const decodeThreadId = Schema.decodeUnknownEffect(ThreadId);
const decodeCommandId = Schema.decodeUnknownEffect(CommandId);
const decodePrompt = Schema.decodeUnknownEffect(Manager.ManagerPrompt);
const decodeBootstrap = Schema.decodeUnknownEffect(Manager.ManagerBootstrap);
const isManagerError = Schema.is(Manager.ManagerError);
const json = HttpServerResponse.jsonUnsafe;
const invalid = () => new Manager.ManagerError({ status: 400, detail: "invalid-request" });
export const managerRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const service = yield* Manager.ManagerService;
    const registry = yield* McpSessionRegistry;
    const authenticate = Effect.fn("manager.authenticate")(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const authorization = request.headers.authorization ?? "";
      const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
      const principal = yield* registry.resolve(token);
      if (principal?.principal !== "external-user" || principal.actorUserId === null)
        return yield* new Manager.ManagerError({ status: 401, detail: "grant-revoked" });
      return {
        userId: principal.actorUserId,
        grantHash: NodeCrypto.createHash("sha256").update(token).digest("hex"),
      };
    });
    const params = Effect.gen(function* () {
      const url = HttpServerRequest.toURL(yield* HttpServerRequest.HttpServerRequest);
      return Option.isSome(url) ? url.value.searchParams : new URLSearchParams();
    });
    const handle = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.map(json),
        Effect.catch((error) =>
          isManagerError(error)
            ? Effect.succeed(json({ error: error.detail }, { status: error.status }))
            : Effect.logWarning("Manager request failed", { error }).pipe(
                Effect.as(json({ error: "internal-error" }, { status: 500 })),
              ),
        ),
      );
    const sessions = handle(
      Effect.gen(function* () {
        const actor = yield* authenticate();
        const result = yield* service.sessions(actor);
        yield* authenticate();
        return result;
      }),
    );
    const feed = handle(
      Effect.gen(function* () {
        const actor = yield* authenticate();
        const query = parseEventFeedQuery(yield* params);
        if (typeof query === "string") return yield* invalid();
        const result = yield* service.feed(actor, query);
        yield* authenticate();
        return result;
      }),
    );
    const receipt = handle(
      Effect.gen(function* () {
        const actor = yield* authenticate();
        const query = yield* params;
        const sessionId = yield* decodeThreadId(query.get("sessionId")).pipe(
          Effect.mapError(invalid),
        );
        const commandId = yield* decodeCommandId(query.get("commandId")).pipe(
          Effect.mapError(invalid),
        );
        return yield* service.receipt(actor, sessionId, commandId);
      }),
    );
    const prompt = handle(
      Effect.gen(function* () {
        const actor = yield* authenticate();
        const request = yield* HttpServerRequest.HttpServerRequest;
        const input = yield* request.json.pipe(
          Effect.flatMap(decodePrompt),
          Effect.mapError(invalid),
        );
        return yield* service.prompt(actor, input);
      }),
    );
    const bootstrap = handle(
      Effect.gen(function* () {
        const actor = yield* authenticate();
        const request = yield* HttpServerRequest.HttpServerRequest;
        const input = yield* request.json.pipe(
          Effect.flatMap(decodeBootstrap),
          Effect.mapError(invalid),
        );
        return yield* service.bootstrap(actor, input);
      }),
    );
    return Layer.mergeAll(
      HttpRouter.add("GET", "/api/manager/sessions", sessions),
      HttpRouter.add("GET", "/api/manager/events", feed),
      HttpRouter.add("GET", "/api/manager/receipt", receipt),
      HttpRouter.add("POST", "/api/manager/prompt", prompt),
      HttpRouter.add("POST", "/api/manager/bootstrap", bootstrap),
    );
  }),
).pipe(Layer.provide(Manager.layer));
