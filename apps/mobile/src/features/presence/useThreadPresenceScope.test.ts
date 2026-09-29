/**
 * T3-CUSTOM(expbkt3): the open thread is retained as a mobile background scope
 * and released again, sharing the reporter's reference-counted map.
 */
import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { retainedMobileBackgroundScopes } from "../../connection/background-activity-scopes";
import { retainMobileThreadPresence } from "./useThreadPresenceScope";

const environmentId = EnvironmentId.make("environment-mobile-presence");

describe("retainMobileThreadPresence", () => {
  it("retains the thread scope until released, reference-counted", () => {
    const first = retainMobileThreadPresence(environmentId, "thread-a");
    const second = retainMobileThreadPresence(environmentId, "thread-a");
    expect(retainedMobileBackgroundScopes(environmentId)).toEqual([
      { type: "thread", threadId: "thread-a" },
    ]);
    first();
    expect(retainedMobileBackgroundScopes(environmentId)).toHaveLength(1);
    second();
    expect(retainedMobileBackgroundScopes(environmentId)).toEqual([]);
  });

  it("does nothing while either id is unknown", () => {
    retainMobileThreadPresence(null, "thread-a")();
    retainMobileThreadPresence(environmentId, null)();
    retainMobileThreadPresence(environmentId, "")();
    expect(retainedMobileBackgroundScopes(environmentId)).toEqual([]);
  });
});
