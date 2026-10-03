import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as McpSessionRegistry from "./McpSessionRegistry.ts";

export const layer = Layer.succeed(
  McpSessionRegistry.McpSessionRegistry,
  McpSessionRegistry.McpSessionRegistry.of({
    issue: ({ threadId, providerInstanceId }) =>
      Effect.succeed({
        expiresAt: Number.MAX_SAFE_INTEGER, // T3-CUSTOM(expbkt3): no login expiry in native fixtures.
        config: {
          // T3-CUSTOM(expbkt3): upstream fixtures use an unrestricted provider actor.
          actorUserId: null,
          upstreamServers: [],
          environmentId: EnvironmentId.make("environment:mcp-test"),
          threadId,
          providerSessionId: `mcp-test:${threadId}`,
          providerInstanceId,
          endpoint: "http://127.0.0.1/mcp",
          authorizationHeader: `Bearer mcp-test:${threadId}`,
          browserToolsAvailable: true,
        },
      }),
    resolve: () => Effect.succeed(undefined),
    touch: () => Effect.void,
    revokeProviderSession: () => Effect.void,
    revokeThread: () => Effect.void,
    revokeLogin: () => Effect.void, // T3-CUSTOM(expbkt3): native fixtures have no login binding.
    revokeAll: Effect.void,
  }),
);
