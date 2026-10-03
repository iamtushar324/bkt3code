// T3-CUSTOM(expbkt3): retained BK behavior at the native V2 boundary.
/** Provider instance slugs are resolved through the native registry, never guessed from a prefix. */
import type { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { ProviderAdapterRegistryV2 } from "./ProviderAdapterRegistry.ts";

export const makeForkProviderNameResolver = Effect.gen(function* () {
  const registry = yield* Effect.serviceOption(ProviderAdapterRegistryV2);
  return (instanceId: ProviderInstanceId) =>
    Option.isSome(registry) && registry.value.getMetadata !== undefined
      ? registry.value.getMetadata(instanceId).pipe(
          Effect.map((metadata) => metadata.driver),
          Effect.orElseSucceed(() => null),
        )
      : Effect.succeed(null);
});
