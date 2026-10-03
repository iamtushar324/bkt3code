// T3-CUSTOM(expbkt3): the fork sidebar must respect upstream's command-only completion policy.
import {
  EnvironmentId,
  RunId,
  type OrchestrationV2PendingBackgroundTask,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { presentThreadShell } from "./models.ts";
import { v2ThreadShell } from "./orchestrationV2TestFixtures.ts";
import { resolvePhaseSidebarPhase, summarizeSidebarSessions } from "./phaseSidebar.ts";

describe("native background work in the phase sidebar", () => {
  it.each([
    { kinds: ["command"], phase: "ready", running: 0 },
    { kinds: ["monitor"], phase: "implementing", running: 1 },
    { kinds: ["subagent"], phase: "implementing", running: 1 },
    { kinds: ["background_task"], phase: "implementing", running: 1 },
    { kinds: ["command", "subagent"], phase: "implementing", running: 1 },
  ] as const)("puts completed $kinds work in $phase", ({ kinds, phase, running }) => {
    const pendingBackgroundTasks: ReadonlyArray<OrchestrationV2PendingBackgroundTask> = kinds.map(
      (kind, index) => ({ taskId: `task-${index}`, kind }),
    );
    const shell = presentThreadShell(EnvironmentId.make("environment-one"), {
      ...v2ThreadShell,
      latestRunId: RunId.make("completed-run"),
      activeRunId: null,
      status: "completed",
      pendingBackgroundTasks,
    });

    expect(resolvePhaseSidebarPhase(shell)).toBe(phase);
    expect(
      summarizeSidebarSessions([shell], {
        now: "2026-10-03T00:00:00.000Z",
        snoozeSupported: () => true,
      }).running,
    ).toBe(running);
    expect(shell.pendingBackgroundTasks).toEqual(pendingBackgroundTasks);
  });

  it("keeps a foreground run active while its command remains open", () => {
    const runId = RunId.make("active-run");
    const shell = presentThreadShell(EnvironmentId.make("environment-one"), {
      ...v2ThreadShell,
      latestRunId: runId,
      activeRunId: runId,
      status: "running",
      pendingBackgroundTasks: [{ taskId: "dev-server", kind: "command" }],
    });

    expect(resolvePhaseSidebarPhase(shell)).toBe("implementing");
    expect(shell.runtime?.status).toBe("running");
  });
});
