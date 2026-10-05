/** T3-CUSTOM(expbkt3): One Toolyard connection summary for web and mobile settings. */
import type { ToolyardIntegrationStatus } from "@t3tools/contracts";

export type ToolyardConnectionTone = "success" | "warning" | "error" | "info" | "secondary";
export type ToolyardConnectionPhase =
  | "unknown"
  | "removed"
  | "not_configured"
  | "disabled"
  | "connected"
  | "pending"
  | "unavailable"
  | "revoked"
  | "request_ended"
  | "not_connected";
type ToolyardConnectionMode = NonNullable<ToolyardIntegrationStatus["mode"]>;
type ToolyardRequestStatus = NonNullable<ToolyardIntegrationStatus["pendingConnection"]>["status"];

export interface ToolyardConnectionPresentation {
  readonly phase: ToolyardConnectionPhase;
  readonly label: string;
  readonly tone: ToolyardConnectionTone;
  readonly description: string;
  /** A consent request awaits the user's decision, even beside an existing connection. */
  readonly pending: boolean;
  readonly connected: boolean;
  /** The account email the server verified, if it reported one. */
  readonly account: string | null;
  readonly host: string | null;
  readonly method: string | null;
  /** The outcome of the last finished consent request. It is history, not current state. */
  readonly requestOutcome: string | null;
}

const methodLabels: Record<ToolyardConnectionMode, string> = {
  team: "Team connection",
  host: "Account consent",
  "api-key": "API key connection",
};
const requestOutcomes: Record<Exclude<ToolyardRequestStatus, "pending">, string> = {
  approved: "Approved",
  rejected: "Rejected",
  expired: "Expired",
  cancelled: "Cancelled",
};

export function toolyardMethodLabel(mode: ToolyardConnectionMode | undefined): string | null {
  return mode ? methodLabels[mode] : null;
}

/** Summaries show a short identifier; details keep the full value for audit and copy. */
export function shortToolyardId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…` : id;
}

/** Derives the visible state only from server status fields. A finished request never outranks the connection. */
export function toolyardConnectionPresentation(
  status: ToolyardIntegrationStatus | null,
): ToolyardConnectionPresentation {
  if (!status)
    return {
      phase: "unknown",
      label: "Status not loaded",
      tone: "secondary",
      description: "T3 has not received the Toolyard status from this server.",
      pending: false,
      connected: false,
      account: null,
      host: null,
      method: null,
      requestOutcome: null,
    };
  const request = status.pendingConnection ?? null;
  const pending = request?.status === "pending";
  const connected = status.connection === "connected" && status.enabled && !status.removed;
  const base = {
    pending,
    connected,
    account: status.email,
    host: status.hostName ?? null,
    method: toolyardMethodLabel(status.mode),
    requestOutcome:
      request && request.status !== "pending" ? requestOutcomes[request.status] : null,
  };
  const summary = (
    phase: ToolyardConnectionPhase,
    label: string,
    tone: ToolyardConnectionTone,
    description: string,
  ): ToolyardConnectionPresentation => ({ ...base, phase, label, tone, description });
  if (status.removed)
    return summary(
      "removed",
      "Instance removed",
      "secondary",
      "An administrator removed this Toolyard instance. T3 will not restore it automatically.",
    );
  if (!status.baseUrl)
    return summary(
      "not_configured",
      "Not set up",
      "secondary",
      "No Toolyard instance is set up on this server.",
    );
  if (!status.enabled)
    return summary(
      "disabled",
      "Integration disabled",
      "secondary",
      "Toolyard is disabled on this server. An administrator can enable it.",
    );
  if (status.connection === "disabled")
    return summary(
      "disabled",
      "Connection disabled",
      "error",
      "The server reports disabled Toolyard access for your account. Contact a Toolyard administrator to check your access. T3 will not reconnect automatically.",
    );
  if (connected)
    return summary(
      "connected",
      "Connected",
      "success",
      status.email
        ? `Connected as ${status.email}.`
        : "Connected. Toolyard did not report an account email.",
    );
  if (pending)
    return summary(
      "pending",
      "Awaiting your decision",
      "info",
      "Approve or reject this host in Toolyard before the request expires.",
    );
  if (status.connection === "unavailable")
    return summary(
      "unavailable",
      "Status unavailable",
      "warning",
      "T3 could not confirm this connection with Toolyard. This does not mean your access was revoked. Retry to check again.",
    );
  if (status.connection === "revoked")
    return summary(
      "revoked",
      "Access revoked",
      "error",
      "Your Toolyard access on this server ended through a disconnect or revocation. T3 will not reconnect automatically.",
    );
  if (request?.status === "rejected")
    return summary(
      "request_ended",
      "Request rejected",
      "warning",
      "Toolyard rejected the last connection request. Start a new request to connect.",
    );
  if (request?.status === "expired")
    return summary(
      "request_ended",
      "Request expired",
      "warning",
      "The last connection request expired before a decision. Start a new request to connect.",
    );
  if (request?.status === "cancelled")
    return summary(
      "request_ended",
      "Request cancelled",
      "secondary",
      "The last connection request was cancelled. Start a new request to connect.",
    );
  return summary(
    "not_connected",
    "Not connected",
    "secondary",
    "Your account has no Toolyard connection on this server.",
  );
}
