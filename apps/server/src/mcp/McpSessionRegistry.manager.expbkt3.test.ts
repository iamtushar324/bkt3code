/** T3-CUSTOM(expbkt3): a durable grant is independent from browser login, but never from revocation. */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  AuthSessionId,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  UserId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { HttpServer } from "effect/unstable/http";
import * as NetAddress from "effect/unstable/net/NetAddress";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Registry from "./McpSessionRegistry.ts";
import { McpInvocationContext } from "./McpInvocationContext.ts";
import { resolveMcpSessionTarget } from "./mcpSessionTarget.ts";
import { OrchestrationAccessControl } from "../orchestration-v2/Services/AccessControl.ts";

it.effect("retains explicit background access without a login and revokes on token rotation", () =>
  Effect.gen(function* () {
    let activeGrant = "grant-a";
    let enabled = true;
    const userId = UserId.make("owner");
    const registry = yield* Registry.__testing
      .make({
        now: () => 1000,
        listActiveLogins: () => Effect.succeed([]),
        loadExternalMcpSettings: () => Effect.succeed({ enabled, apiKey: "" }),
        isBackgroundGrantActive: (actor, grant) =>
          Effect.succeed(actor === userId && grant === activeGrant),
      })
      .pipe(
        Effect.provideService(
          HttpServer.HttpServer,
          HttpServer.HttpServer.of({
            address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 43123),
            serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
          }),
        ),
        Effect.provideService(ServerEnvironment.ServerEnvironment, {
          getEnvironmentId: Effect.succeed(EnvironmentId.make("test")),
          getDescriptor: Effect.die("unused"),
        }),
        Effect.provide(NodeServices.layer),
      );
    const issue = (threadId: string, grant?: string) =>
      registry.issue({
        threadId: ThreadId.make(threadId),
        providerInstanceId: ProviderInstanceId.make("codex"),
        actorUserId: userId,
        backgroundGrantHash: grant,
        capabilities: new Set([
          "device",
          "t3.control",
          "t3.session.create",
          "t3.plan",
          "pull-requests",
        ]),
      });
    const normal = yield* issue("normal");
    expect(yield* registry.resolve(normal.config.authorizationHeader.slice(7))).toBeUndefined();
    const background = yield* issue("manager", activeGrant);
    const token = background.config.authorizationHeader.slice(7);
    const scope = yield* registry.resolve(token);
    expect(scope?.actorUserId).toBe(userId);
    expect([...(scope?.capabilities ?? [])].sort()).toEqual(["device", "t3.read"]);
    expect(scope?.capabilities.has("t3.control")).toBe(false);
    expect(scope?.capabilities.has("t3.session.create")).toBe(false);
    expect(scope?.capabilities.has("t3.plan")).toBe(false);
    expect(scope?.capabilities.has("pull-requests")).toBe(false);
    if (!scope) return yield* Effect.die("Expected active background scope");
    const access = OrchestrationAccessControl.of({
      actorFor: () => Option.none(),
      canAccessThread: (actor, thread) => Effect.succeed(actor === userId && thread === "member"),
      canAccessProject: () => Effect.succeed(false),
      canTransferThreadOwnership: () => Effect.succeed(false),
      canTransferProjectOwnership: () => Effect.succeed(false),
    });
    const target = (requested: string, capability: "t3.read" | "t3.control") =>
      resolveMcpSessionTarget({ requested: ThreadId.make(requested), capability }).pipe(
        Effect.provideService(McpInvocationContext, scope),
        Effect.provideService(OrchestrationAccessControl, access),
      );
    expect(yield* target("member", "t3.read")).toBe("member");
    expect((yield* target("project-only", "t3.read").pipe(Effect.flip)).message).toContain(
      "was not found",
    );
    expect((yield* target("member", "t3.control").pipe(Effect.flip)).message).toContain(
      "does not grant t3.control",
    );
    yield* registry.revokeLogin(AuthSessionId.make("browser"));
    expect((yield* registry.resolve(token))?.backgroundGrantHash).toBe(activeGrant);
    activeGrant = "grant-b";
    expect(yield* registry.resolve(token)).toBeUndefined();
    const next = yield* issue("manager", activeGrant);
    enabled = false;
    expect(yield* registry.resolve(next.config.authorizationHeader.slice(7))).toBeUndefined();
    const invalid = yield* issue("manager", "revoked");
    expect(yield* registry.resolve(invalid.config.authorizationHeader.slice(7))).toBeUndefined();
  }),
);
