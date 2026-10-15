import type { PendingThreadRequests } from "@t3tools/client-runtime/state/thread-requests";
import type { OrchestrationV2ThreadProjection, RuntimeRequestId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { releaseEndedRunUserInputs } from "./orphanedUserInputs";

type Projection = Pick<OrchestrationV2ThreadProjection, "runs" | "turnItems">;

const pending = (requestId: string): PendingThreadRequests => ({
  approvals: [],
  userInputs: [
    {
      requestId: requestId as RuntimeRequestId,
      createdAt: "2026-10-15T15:28:34.029Z",
      questions: [],
      responseCapability: "live",
      dismissible: false,
    },
  ],
});

const projection = (runStatus: string): Projection =>
  ({
    runs: [{ id: "run:9", status: runStatus }],
    turnItems: [{ type: "user_input_request", requestId: "request", runId: "run:9" }],
  }) as unknown as Projection;

describe("releaseEndedRunUserInputs", () => {
  it("makes a question whose run failed answerable by message and dismissible", () => {
    const [input] = releaseEndedRunUserInputs(pending("request"), projection("failed")).userInputs;
    expect(input).toMatchObject({
      responseCapability: "message",
      responseMode: "message",
      dismissible: true,
    });
  });

  it("leaves a question alone while its run is still going or has completed", () => {
    const requests = pending("request");
    expect(releaseEndedRunUserInputs(requests, projection("running"))).toBe(requests);
    expect(releaseEndedRunUserInputs(requests, projection("completed"))).toBe(requests);
  });

  it("leaves a question from another run alone", () => {
    const requests = pending("other");
    expect(releaseEndedRunUserInputs(requests, projection("failed"))).toBe(requests);
  });
});
