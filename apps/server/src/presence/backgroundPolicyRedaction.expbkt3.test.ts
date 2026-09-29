/**
 * T3-CUSTOM(expbkt3): the background policy RPCs keep a caller's own thread
 * scopes and drop everyone else's.
 */
import { describe, expect, it } from "@effect/vitest";
import {
  AuthSessionId,
  RpcClientId,
  ThreadId,
  type BackgroundPolicySnapshot,
  type ClientActivityLease,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { redactBackgroundPolicySnapshot } from "./backgroundPolicyRedaction.expbkt3.ts";

const now = DateTime.makeUnsafe("2026-09-29T12:00:00.000Z");
const mine = AuthSessionId.make("auth-mine");
const theirs = AuthSessionId.make("auth-theirs");
const myThread = ThreadId.make("thread-mine");
const theirThread = ThreadId.make("thread-theirs");

/** Walks a value's strings without serialising it, so no thread id can hide in a nested field. */
const mentions = (value: unknown, needle: string): boolean =>
  typeof value === "string"
    ? value.includes(needle)
    : Array.isArray(value)
      ? value.some((entry) => mentions(entry, needle))
      : typeof value === "object" && value !== null
        ? Object.values(value).some((entry) => mentions(entry, needle))
        : false;

const lease = (overrides: Partial<ClientActivityLease>): ClientActivityLease => ({
  sessionId: mine,
  rpcClientId: RpcClientId.make(1),
  clientId: "client",
  clientKind: "web",
  visible: true,
  focused: true,
  recentlyInteracted: true,
  scopes: [],
  updatedAt: now,
  expiresAt: now,
  ...overrides,
});

const snapshot = (leases: ReadonlyArray<ClientActivityLease>): BackgroundPolicySnapshot =>
  ({
    leases,
    activeScopeKeys: [
      "provider-status",
      `thread:${myThread}`,
      `thread:${theirThread}`,
      "vcs-status:/repo",
    ],
    activeForegroundLeaseCount: leases.length,
    shouldRunOpportunisticWork: true,
    updatedAt: now,
  }) as unknown as BackgroundPolicySnapshot;

describe("redactBackgroundPolicySnapshot", () => {
  it("drops other logins' thread scopes from leases and from the aggregate keys", () => {
    const redacted = redactBackgroundPolicySnapshot(
      snapshot([
        lease({ scopes: [{ type: "provider-status" }, { type: "thread", threadId: myThread }] }),
        lease({
          sessionId: theirs,
          scopes: [
            { type: "vcs-status", cwd: "/repo" },
            { type: "thread", threadId: theirThread },
          ],
        }),
      ]),
      mine,
    );
    expect(redacted.leases[0]?.scopes).toEqual([
      { type: "provider-status" },
      { type: "thread", threadId: myThread },
    ]);
    expect(redacted.leases[1]?.scopes).toEqual([{ type: "vcs-status", cwd: "/repo" }]);
    expect(redacted.activeScopeKeys).toEqual([
      "provider-status",
      `thread:${myThread}`,
      "vcs-status:/repo",
    ]);
    expect(mentions(redacted, String(theirThread))).toBe(false);
  });

  it("returns the same object when nothing foreign would be exposed", () => {
    const input = snapshot([
      lease({ scopes: [{ type: "thread", threadId: myThread }] }),
      lease({ sessionId: theirs, scopes: [{ type: "provider-status" }] }),
    ]);
    expect(redactBackgroundPolicySnapshot(input, mine)).toBe(input);
  });
});
