/** T3-CUSTOM(expbkt3): Standard-scope access does not admit an anonymous Toolyard configuration. */
import { PersonalMcpSettingsError, WS_FORK_METHODS } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { makeForkWsHandlers, type ForkWsHandlerDeps } from "../wsForkHandlers.ts";

const isPersonalMcpSettingsError = Schema.is(PersonalMcpSettingsError);

it.effect("rejects anonymous Toolyard configuration before accessing the integration", () =>
  Effect.gen(function* () {
    const dependencies = {
      actorUserId: null,
      observeRpcEffect: (_method, effect) => effect,
    } satisfies Partial<ForkWsHandlerDeps>;
    const handlers = makeForkWsHandlers(dependencies as ForkWsHandlerDeps);
    const result = yield* handlers[WS_FORK_METHODS.toolyardIntegrationConfigure]({
      expectedRevision: 0,
      baseUrl: "https://toolyard.example",
      origin: "https://t3.example",
      enabled: true,
    }).pipe(Effect.flip);
    expect(isPersonalMcpSettingsError(result)).toBe(true);
    expect(result.message).toBe("verified_identity_required");
  }),
);
