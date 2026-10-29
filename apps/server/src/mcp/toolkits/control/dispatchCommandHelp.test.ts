// T3-CUSTOM(expbkt3): TEC-1819 — a wrong t3_dispatch_command input gets an
// error that says exactly what to send.
import { describe, expect, it } from "@effect/vitest";

import {
  closestNames,
  commandShape,
  describeCommandDecodeFailure,
  orchestrationCommandMembers,
} from "./dispatchCommandHelp.ts";

const FALLBACK = "union decode failed";

describe("dispatchCommandHelp", () => {
  it("knows the command types of both nested unions", () => {
    const types = orchestrationCommandMembers();
    expect(types.has("thread.archive")).toBe(true);
    expect(types.has("thread.unarchive")).toBe(true);
    expect(types.has("project.create")).toBe(true);
    expect(types.has("thread.turn.start")).toBe(true);
    expect(types.size).toBeGreaterThan(30);
  });

  it("gives thread.archive's required fields and a minimal example", () => {
    const shape = commandShape("thread.archive");
    expect(shape?.requiredFields).toEqual(["type", "commandId", "threadId"]);
    expect(shape?.example).toEqual({
      type: "thread.archive",
      commandId: "mcp:<unique-id>",
      threadId: "<threadId>",
    });
  });

  it("names the fields and t3_session_action for an archive without threadId", () => {
    const message = describeCommandDecodeFailure(
      { type: "thread.archive", commandId: "mcp:1" },
      FALLBACK,
    );
    expect(message).toContain("Invalid thread.archive command.");
    expect(message).toContain("Required fields: type, commandId, threadId.");
    expect(message).toContain('"threadId":"<threadId>"');
    expect(message).toContain("Use t3_session_action action=archive instead");
    // The issue is about this one command, not a list of every type.
    expect(message).not.toContain("Valid types:");
  });

  it("suggests the closest type for an unknown one and lists the valid types once", () => {
    const message = describeCommandDecodeFailure(
      { type: "thread.archived", commandId: "mcp:1", threadId: "t" },
      FALLBACK,
    );
    expect(message).toContain(
      'Unknown command type "thread.archived". Did you mean "thread.archive"?',
    );
    expect(message).toContain("t3_session_action action=archive");
    expect(message.match(/Valid types:/g)).toHaveLength(1);
    expect(message).toContain("thread.unarchive");
  });

  it("asks for a type when it is missing, and for an object when the command is not one", () => {
    expect(describeCommandDecodeFailure({ threadId: "t" }, FALLBACK)).toContain(
      "command.type is missing",
    );
    expect(describeCommandDecodeFailure("thread.archive", FALLBACK)).toContain(
      "command must be a JSON object",
    );
  });

  it("ranks the closest names first", () => {
    const names = ["thread.archive", "thread.unarchive", "project.create"];
    expect(closestNames("thread.unarchve", names)[0]).toBe("thread.unarchive");
  });
});
