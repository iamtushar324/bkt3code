/**
 * T3-CUSTOM(expbkt3): BK_T3_PRESENCE_URL is derived from the MCP endpoint the
 * session was issued for, and rides every adapter's device-environment seam.
 */
import { describe, expect, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";

import { withAgentDeviceEnvironment } from "../mcp/McpProviderSession.ts";
import {
  PRESENCE_URL_KEY,
  presenceUrlForSession,
  withPresenceEnvironment,
} from "./presenceEnvironment.expbkt3.ts";

const threadId = ThreadId.make("thread-abc/1");

describe("presenceUrlForSession", () => {
  it("swaps /mcp for /api/presence and encodes the session id", () => {
    expect(presenceUrlForSession("http://10.31.39.131:18083/mcp", threadId)).toBe(
      "http://10.31.39.131:18083/api/presence?sessionId=thread-abc%2F1",
    );
    expect(presenceUrlForSession("http://127.0.0.1:3000/mcp/", threadId)).toBe(
      "http://127.0.0.1:3000/api/presence?sessionId=thread-abc%2F1",
    );
  });
});

describe("withPresenceEnvironment", () => {
  it("adds the variable only when the session has an endpoint and a thread", () => {
    const base = { PATH: "/bin" };
    expect(withPresenceEnvironment(base, undefined)).toBe(base);
    expect(withPresenceEnvironment(base, { endpoint: "http://h/mcp" })).toBe(base);
    expect(withPresenceEnvironment(base, { endpoint: "http://h/mcp", threadId })).toEqual({
      PATH: "/bin",
      [PRESENCE_URL_KEY]: "http://h/api/presence?sessionId=thread-abc%2F1",
    });
  });

  it("is applied by withAgentDeviceEnvironment with and without device variables", () => {
    const session = { endpoint: "http://h:1/mcp", threadId };
    expect(withAgentDeviceEnvironment({ HOME: "/home" }, session)).toEqual({
      HOME: "/home",
      [PRESENCE_URL_KEY]: "http://h:1/api/presence?sessionId=thread-abc%2F1",
    });
    expect(
      withAgentDeviceEnvironment(
        { HOME: "/home", PATH: "/bin" },
        { ...session, agentDeviceEnvironment: { PATH: "/shims", AGENT_DEVICE_URL: "x" } },
      ),
    ).toEqual({
      HOME: "/home",
      PATH: "/shims:/bin",
      AGENT_DEVICE_URL: "x",
      [PRESENCE_URL_KEY]: "http://h:1/api/presence?sessionId=thread-abc%2F1",
    });
    expect(withAgentDeviceEnvironment({ HOME: "/home" }, undefined)).toEqual({ HOME: "/home" });
  });
});
