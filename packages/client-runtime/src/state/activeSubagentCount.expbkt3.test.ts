// T3-CUSTOM(expbkt3): XFN-59 — the sidebar reads the running provider-native subagent count.
import { EnvironmentId, OrchestrationV2ThreadShellJson } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { presentThreadShell } from "./models.ts";
import { v2ThreadShell } from "./orchestrationV2TestFixtures.ts";

const environmentId = EnvironmentId.make("environment-one");
const encodeShell = Schema.encodeSync(OrchestrationV2ThreadShellJson);
const decodeShell = Schema.decodeUnknownSync(OrchestrationV2ThreadShellJson);

describe("active subagent count on the thread shell", () => {
  it("presents the count the server reports", () => {
    const shell = presentThreadShell(environmentId, { ...v2ThreadShell, activeSubagentCount: 3 });
    expect(shell.activeSubagentCount).toBe(3);
  });

  it("presents 0 when the server omits the field", () => {
    expect(presentThreadShell(environmentId, v2ThreadShell).activeSubagentCount).toBe(0);
  });

  it("carries the count over the wire and decodes payloads without it", () => {
    expect(decodeShell(encodeShell({ ...v2ThreadShell, activeSubagentCount: 2 }))).toMatchObject({
      activeSubagentCount: 2,
    });
    expect(decodeShell(encodeShell(v2ThreadShell)).activeSubagentCount).toBeUndefined();
  });

  it("rejects a negative count", () => {
    const wire = encodeShell(v2ThreadShell);
    expect(() => decodeShell({ ...(wire as object), activeSubagentCount: -1 })).toThrow();
  });
});
