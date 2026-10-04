/** T3-CUSTOM(expbkt3): Current upstream inspection is actor-scoped and leaves live credentials intact. */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  UserId,
  type PersonalMcpProfile,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { HttpServer } from "effect/unstable/http";
import * as NetAddress from "effect/unstable/net/NetAddress";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";
import { upstreamConfigurationKey } from "./McpUpstreamConfiguration.ts";

it.effect(
  "detects newly eligible and changed upstream scope without rotating the provider credential",
  () =>
    Effect.gen(function* () {
      const actor = UserId.make("user_member");
      const providerInstanceId = ProviderInstanceId.make("codex");
      const profile: PersonalMcpProfile = {
        userId: actor,
        externalAccessEnabled: false,
        externalTokenConfigured: false,
        externalTokenPrefix: "",
        updatedAt: "2026-10-04T00:00:00Z",
        integrations: [],
      };
      let integrations = profile.integrations;
      const registry = yield* McpSessionRegistry.__testing
        .make({
          now: () => 1_000,
          loadPersonalProfile: (userId) =>
            Effect.succeed(userId === actor ? { ...profile, integrations } : undefined),
        })
        .pipe(
          Effect.provideService(
            HttpServer.HttpServer,
            HttpServer.HttpServer.of({
              address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 43123),
              serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
            }),
          ),
          Effect.provideService(
            ServerEnvironment.ServerEnvironment,
            ServerEnvironment.ServerEnvironment.of({
              getEnvironmentId: Effect.succeed(EnvironmentId.make("environment")),
              getDescriptor: Effect.die("unused"),
            }),
          ),
          Effect.provide(NodeServices.layer),
        );
      const issued = yield* registry.issue({
        actorUserId: actor,
        providerInstanceId,
        threadId: ThreadId.make("thread"),
      });
      const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
      integrations = [
        {
          id: "toolyard",
          name: "toolyard",
          url: "https://toolyard.example/mcp",
          enabled: true,
          authMode: "bearer",
          customHeaderName: "",
          credentialConfigured: true,
          providerInstanceIds: [],
          allowedTools: ["inbox.status"],
        },
      ];
      const request = { actorUserId: actor, providerInstanceId };
      const enabled = yield* registry.inspectUpstreamServers!(request);
      expect(enabled.map((server) => server.id)).toEqual(["toolyard", "bifrost"]);
      expect(upstreamConfigurationKey(enabled)).not.toBe(
        upstreamConfigurationKey(issued.config.upstreamServers),
      );
      expect(yield* registry.resolve(token)).toBeDefined();
      expect(
        (yield* registry.inspectUpstreamServers!({
          ...request,
          actorUserId: UserId.make("other-member"),
        })).map((server) => server.id),
      ).toEqual(["bifrost"]);
      integrations = [
        {
          ...integrations[0]!,
          url: "https://replacement.example/mcp",
          allowedTools: ["inbox.status", "inbox.request"],
        },
      ];
      const unavailable = yield* registry.inspectUpstreamServers!(request);
      integrations = [{ ...integrations[0]!, configurationKey: "instance:connected" }];
      const changed = yield* registry.inspectUpstreamServers!(request);
      expect(changed[0]?.endpoint).toBe(unavailable[0]?.endpoint);
      expect(upstreamConfigurationKey(changed)).not.toBe(upstreamConfigurationKey(unavailable));
      expect(changed[0]?.endpoint).toBe(enabled[0]?.endpoint);
      expect(upstreamConfigurationKey(changed)).not.toBe(upstreamConfigurationKey(enabled));
      expect(yield* registry.resolve(token)).toBeDefined();
      expect(issued.config.upstreamServers.map((server) => server.id)).toEqual(["bifrost"]);
    }),
);
