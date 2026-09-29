/**
 * T3-CUSTOM(expbkt3): the open thread is retained as a background scope and
 * released again, with reference counting shared with upstream's subscriptions.
 */
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { retainedBackgroundScopes } from "../lib/backgroundActivityReporter";
import { retainThreadPresence } from "./useThreadPresenceScope";

const environmentId = EnvironmentId.make("environment-presence-scope");
const threadId = ThreadId.make("thread-presence-scope");

describe("retainThreadPresence", () => {
  it("retains the thread scope until released", () => {
    const release = retainThreadPresence({ environmentId, threadId });
    expect(retainedBackgroundScopes(environmentId)).toEqual([{ type: "thread", threadId }]);
    release();
    expect(retainedBackgroundScopes(environmentId)).toEqual([]);
  });

  it("reference-counts a thread opened twice and does nothing for no target", () => {
    const first = retainThreadPresence({ environmentId, threadId });
    const second = retainThreadPresence({ environmentId, threadId });
    expect(retainedBackgroundScopes(environmentId)).toEqual([{ type: "thread", threadId }]);
    first();
    expect(retainedBackgroundScopes(environmentId)).toEqual([{ type: "thread", threadId }]);
    second();
    expect(retainedBackgroundScopes(environmentId)).toEqual([]);

    retainThreadPresence(null)();
    expect(retainedBackgroundScopes(environmentId)).toEqual([]);
  });
});
