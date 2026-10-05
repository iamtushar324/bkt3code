/** T3-CUSTOM(expbkt3): Toolyard settings show server state, with finished requests kept as history. */
import { describe, expect, it } from "vite-plus/test";
import type { ToolyardIntegrationStatus } from "@t3tools/contracts";
import {
  shortToolyardId,
  toolyardConnectionPresentation,
  toolyardMethodLabel,
} from "./toolyardConnectionPresentation.ts";

const status = (overrides: Partial<ToolyardIntegrationStatus> = {}): ToolyardIntegrationStatus => ({
  revision: 2,
  revocationPending: 0,
  enabled: true,
  removed: false,
  baseUrl: "https://toolyard.test",
  instanceId: "instance",
  origin: "https://stage.test",
  administrator: false,
  mode: "host",
  hostName: "mbp.local",
  connection: "not_connected",
  email: null,
  expiresAt: null,
  ...overrides,
});
const request = (state: "pending" | "rejected" | "expired" | "cancelled" | "approved") => ({
  requestId: "request-1",
  authorizationUrl: "https://toolyard.test/connections/authorize",
  expiresAt: "2099-01-01T00:00:00Z",
  status: state,
  lastError: null,
});

describe("toolyardConnectionPresentation", () => {
  it("shows an approved request on a connected account as history, not as pending work", () => {
    const view = toolyardConnectionPresentation(
      status({
        connection: "connected",
        email: "dev@beknown.work",
        pendingConnection: request("approved"),
      }),
    );
    expect(view).toMatchObject({
      phase: "connected",
      label: "Connected",
      tone: "success",
      connected: true,
      pending: false,
      account: "dev@beknown.work",
      host: "mbp.local",
      method: "Account consent",
      requestOutcome: "Approved",
    });
    expect(view.description).toContain("dev@beknown.work");
  });

  it("keeps a new pending request visible beside an existing connection", () => {
    const view = toolyardConnectionPresentation(
      status({ connection: "connected", pendingConnection: request("pending") }),
    );
    expect(view).toMatchObject({ phase: "connected", connected: true, pending: true });
    expect(view.requestOutcome).toBeNull();
  });

  it("reports a missing account email instead of inventing one", () => {
    expect(toolyardConnectionPresentation(status({ connection: "connected" })).description).toBe(
      "Connected. Toolyard did not report an account email.",
    );
  });

  it.each([
    [{ pendingConnection: request("pending") }, "pending", "Awaiting your decision", "info"],
    [{ pendingConnection: request("rejected") }, "request_ended", "Request rejected", "warning"],
    [{ pendingConnection: request("expired") }, "request_ended", "Request expired", "warning"],
    [
      { pendingConnection: request("cancelled") },
      "request_ended",
      "Request cancelled",
      "secondary",
    ],
    [{ connection: "revoked" }, "revoked", "Access revoked", "error"],
    [{ connection: "unavailable" }, "unavailable", "Status unavailable", "warning"],
    [{ connection: "disabled" }, "disabled", "Integration disabled", "secondary"],
    [{ enabled: false, connection: "connected" }, "disabled", "Integration disabled", "secondary"],
    [{ removed: true, connection: "connected" }, "removed", "Instance removed", "secondary"],
    [{ baseUrl: null, enabled: false }, "not_configured", "Not set up", "secondary"],
    [{}, "not_connected", "Not connected", "secondary"],
  ] as const)("maps %o to %s", (overrides, phase, label, tone) => {
    const view = toolyardConnectionPresentation(status(overrides));
    expect(view).toMatchObject({ phase, label, tone, connected: false });
  });

  it("never presents an outage as revoked access", () => {
    const view = toolyardConnectionPresentation(status({ connection: "unavailable" }));
    expect(view.label).not.toContain("revoked");
    expect(view.description).toContain("does not mean your access was revoked");
  });

  it("gives an honest fallback before the server answers", () => {
    expect(toolyardConnectionPresentation(null)).toMatchObject({
      phase: "unknown",
      label: "Status not loaded",
      connected: false,
      pending: false,
      account: null,
      method: null,
    });
  });
});

describe("Toolyard labels", () => {
  it("names each connection method and abbreviates only long identifiers", () => {
    expect(toolyardMethodLabel("team")).toBe("Team connection");
    expect(toolyardMethodLabel("api-key")).toBe("API key connection");
    expect(toolyardMethodLabel(undefined)).toBeNull();
    expect(shortToolyardId("agent_0123456789abcdef")).toBe("agent_01…");
    expect(shortToolyardId("agent_1")).toBe("agent_1");
  });
});
