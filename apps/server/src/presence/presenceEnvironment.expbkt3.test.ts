/**
 * T3-CUSTOM(expbkt3): BK_T3_PRESENCE_URL is derived from the MCP endpoint the
 * session was issued for; the adapters spread it beside the bearer.
 */
import { describe, expect, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";

import {
  PRESENCE_URL_KEY,
  presenceEnvironmentFor,
  presenceUrlForSession,
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

describe("presenceEnvironmentFor", () => {
  it("yields exactly the one variable for a session config", () => {
    expect(presenceEnvironmentFor({ endpoint: "http://h:1/mcp", threadId })).toEqual({
      [PRESENCE_URL_KEY]: "http://h:1/api/presence?sessionId=thread-abc%2F1",
    });
  });
});
