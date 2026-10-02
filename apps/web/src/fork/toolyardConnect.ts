/**
 * T3-CUSTOM(expbkt3): toolyardConnect - what the client knows about the
 * built-in toolyard integration.
 *
 * The server owns the connection (it exchanges the Clerk token and keeps the
 * toolyard token); the client only decides *when* to ask for one and how to
 * word the answer. Both decisions live here, free of React, so they are
 * testable without rendering.
 *
 * @module fork/toolyardConnect
 */
import {
  type PersonalMcpIntegration,
  type PersonalMcpProfile,
  TOOLYARD_MCP_INTEGRATION_ID,
} from "@t3tools/contracts";

/** The built-in toolyard integration of a profile; the server always presents one. */
export function toolyardIntegrationOf(
  profile: PersonalMcpProfile | null | undefined,
): PersonalMcpIntegration | null {
  return (
    profile?.integrations.find((integration) => integration.id === TOOLYARD_MCP_INTEGRATION_ID) ??
    null
  );
}

/**
 * Whether this app load should connect toolyard on the user's behalf: only a
 * signed-in operator (there is no Clerk token otherwise), only once the
 * profile has loaded and shows no toolyard credential, and at most once per
 * app load. A failed attempt waits for the next load rather than retrying.
 */
export function shouldAutoConnectToolyard(input: {
  readonly signedIn: boolean;
  readonly profile: PersonalMcpProfile | null | undefined;
  readonly attempted: boolean;
}): boolean {
  if (!input.signedIn || input.attempted) return false;
  const toolyard = toolyardIntegrationOf(input.profile);
  return toolyard !== null && !toolyard.credentialConfigured;
}

export type ToolyardAutoConnectOutcome =
  /** Nothing to do: signed out, profile not loaded, already connected, or already tried. */
  | "skipped"
  /** A run for this user is still in flight. */
  | "busy"
  /** No Clerk token was available; the attempt is not used up. */
  | "no-token"
  /** The server was asked to connect; this load will not ask again for this user. */
  | "attempted";

export interface ToolyardAutoConnectRun {
  readonly signedIn: boolean;
  /** The signed-in operator; the once-per-load attempt is tracked per user. */
  readonly userId: string | null;
  readonly profile: PersonalMcpProfile | null | undefined;
  readonly readToken: () => Promise<string | null>;
  readonly connect: (clerkToken: string) => Promise<unknown>;
}

export interface ToolyardAutoConnectRunner {
  readonly run: (input: ToolyardAutoConnectRun) => Promise<ToolyardAutoConnectOutcome>;
  readonly reset: () => void;
}

/**
 * The once-per-app-load auto-connect, as state plus one `run` to call whenever
 * its inputs change. The attempt is used up only once a Clerk token was
 * actually in hand (a missing token leaves it for the next change), it is
 * tracked per signed-in user so a different account signing in without a
 * reload gets its own, and overlapping runs collapse into one — every
 * successful connect rotates the token, so two in flight would be one too
 * many.
 */
export function createToolyardAutoConnectRunner(): ToolyardAutoConnectRunner {
  let attemptedFor: string | null = null;
  let inFlight = false;
  return {
    run: async (input) => {
      if (inFlight) return "busy";
      const attempted = input.userId !== null && attemptedFor === input.userId;
      if (
        !shouldAutoConnectToolyard({ signedIn: input.signedIn, profile: input.profile, attempted })
      ) {
        return "skipped";
      }
      inFlight = true;
      try {
        const token = await input.readToken();
        if (token === null) return "no-token";
        attemptedFor = input.userId;
        await input.connect(token);
        return "attempted";
      } finally {
        inFlight = false;
      }
    },
    reset: () => {
      attemptedFor = null;
      inFlight = false;
    },
  };
}

/**
 * Plain-language reading of a `personalMcp.connectToolyard` error code. toolyard
 * may add codes; anything unknown reads as "could not connect" with the code
 * for the person who goes asking.
 */
export function toolyardConnectErrorMessage(code: string | undefined): string {
  switch (code) {
    case "not_org_member":
      return "Your account isn't in the Beknown org.";
    case "user_disabled":
      return "Your toolyard account is disabled.";
    case "agent_disabled":
      return "Your T3 Code agent is disabled in toolyard.";
    case "invalid_token":
      return "Your sign-in could not be verified. Sign out and back in, then reconnect.";
    case "not_signed_in":
      return "Sign in with your Beknown account to connect toolyard.";
    case "identity_mismatch":
      return "Your sign-in doesn't match this T3 session. Sign out and back in, then reconnect.";
    case "connect_disabled":
      return "toolyard is not accepting T3 Code connections right now.";
    case "rate_limited":
      return "Too many connection attempts. Try again in a minute.";
    case "clerk_unavailable":
      return "toolyard could not reach the sign-in service. Try again shortly.";
    case "unreachable":
    case "timeout":
      return "toolyard did not answer. Try again shortly.";
    case "store_failed":
      return "T3 could not save the toolyard connection. Try again.";
    case "no_clerk_token":
      return "This app can't sign in to toolyard by itself. Open the web app once to connect.";
    case undefined:
      return "toolyard could not be connected.";
    default:
      return `toolyard could not be connected (${code}).`;
  }
}

/** What the toolyard settings card offers besides its status line. */
export type ToolyardCardAction =
  /** Connect again from this client (it can mint a Clerk token). */
  | { readonly kind: "reconnect" }
  /** Send the person to the web app, the only place a connect can happen. */
  | { readonly kind: "open-web"; readonly url: string }
  | { readonly kind: "none" };

export interface ToolyardCardView {
  readonly status: string;
  readonly action: ToolyardCardAction;
}

/**
 * The toolyard card, decided from server-side state and what this client can
 * do. Connecting needs a Clerk session token, which only a client with a Clerk
 * publishable key can mint — the web app. A keyless client (the managed BK
 * desktop) therefore never offers Reconnect: it shows the connection the server
 * holds and, when there is none, points at the web app's origin. The relative
 * time is injected so the view is a pure function.
 */
export function resolveToolyardCardView(input: {
  readonly toolyard: PersonalMcpIntegration | null;
  /** Whether this client can mint a Clerk token (`hasClerkPublicConfig()`). */
  readonly canSignIn: boolean;
  /** The web app this environment is served from; where a keyless client sends the person. */
  readonly webAppUrl: string | null;
  readonly formatConnectedAt: (isoDate: string) => string;
}): ToolyardCardView {
  const { toolyard } = input;
  if (toolyard === null) return { status: "Loading…", action: { kind: "none" } };
  if (toolyard.credentialConfigured) {
    const status = [
      `Connected automatically${toolyard.connectedEmail ? ` as ${toolyard.connectedEmail}` : ""}`,
      toolyard.connectedAt
        ? `last connected ${input.formatConnectedAt(toolyard.connectedAt)}`
        : null,
    ]
      .filter(Boolean)
      .join(" · ");
    return { status, action: input.canSignIn ? { kind: "reconnect" } : { kind: "none" } };
  }
  if (input.canSignIn) return { status: "Not connected", action: { kind: "reconnect" } };
  const webOrigin = toWebOrigin(input.webAppUrl);
  return {
    status: "Not connected · connect once from the web app",
    action: webOrigin === null ? { kind: "none" } : { kind: "open-web", url: webOrigin },
  };
}

/** The https origin of a web app URL, or null for anything that is not one. */
function toWebOrigin(url: string | null): string | null {
  if (url === null) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" ? parsed.origin : null;
  } catch {
    return null;
  }
}
