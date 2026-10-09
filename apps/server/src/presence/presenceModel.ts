/**
 * T3-CUSTOM(expbkt3): pure presence rules.
 *
 * Turns what the clients reported (upstream's activity leases, plus the history
 * the tracker keeps after a lease expires) and the durable facts the server
 * already stores (auth-session last-seen, last message in the thread) into one
 * answer an agent can act on before it stops: who is relevant to this session,
 * whether each of them is looking at it right now, and which of three ways to
 * ask in chat fits.
 *
 * Presence never recommends a Mattermost message. Whoever is or is not at the
 * keyboard, the question goes in the session chat and the session stays open:
 * people read T3 on their phones. When an agent may post to Mattermost is set
 * by the global agent instructions, not by presence.
 *
 * Nothing here touches a service, so every branch is unit-tested in
 * `presenceModel.test.ts`.
 */
import type { ClientKind } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

/** Clients report about this often; a report may be up to this stale and still be "live". */
export const PRESENCE_HEARTBEAT_INTERVAL_MS = 25_000;
/** How long a client report stays authoritative without a newer one. */
export const PRESENCE_LEASE_TTL_MS = 45_000;
/**
 * Right after a restart no client has reported yet, and for the first
 * heartbeat interval or two the live picture is incomplete rather than empty.
 */
export const PRESENCE_WARMUP_MS = 2 * PRESENCE_HEARTBEAT_INTERVAL_MS;
/**
 * Durable evidence younger than this (a message, an auth-session reconnect)
 * means the person was here a moment ago, so a missing live client is not
 * yet a sign that they are away.
 */
export const PRESENCE_RECENT_EVIDENCE_MS = 2 * 60_000;
/**
 * A focused window left alone is not a person reading it. "Viewing" and
 * "active" both need an input event within this window; after it the client
 * is idle, even with the session open and the window focused.
 */
export const PRESENCE_INTERACTION_WINDOW_MS = 3 * 60_000;

export type PresenceState =
  | "viewing-this-session"
  | "active-elsewhere"
  | "idle"
  | "background"
  | "away"
  | "unknown";

export type PresenceRole = "owner" | "member" | "last-sender" | "viewer";

/**
 * Every action means "ask in the session chat"; they differ in what the
 * agent can expect. Readers treat `ask-in-chat` as "the human has this
 * session open now", so it is kept for `viewing-this-session` only.
 *
 * `ask-in-chat`: someone has this session open now and sees the question.
 * `ask-in-chat-and-wait`: nobody is reading this session now (elsewhere, idle,
 * in the background or away); ask, keep the session open, and let them answer
 * when they come back.
 * `wait-for-reply`: the picture is not settled yet (the person was here
 * moments ago, or the server just restarted); ask and keep the session open.
 *
 * `suggestedFollowUpSeconds` is information only: agents do not poll on it.
 */
export type PresenceAction = "ask-in-chat" | "ask-in-chat-and-wait" | "wait-for-reply";

/** One client as the tracker last saw it. Times are epoch milliseconds. */
export interface PresenceClientInput {
  readonly clientId: string;
  readonly clientKind: ClientKind;
  readonly visible: boolean;
  readonly focused: boolean;
  readonly recentlyInteracted: boolean;
  readonly appState: "active" | "inactive" | "background" | "unknown" | null;
  readonly lowPowerMode: string | null;
  readonly batteryState: string | null;
  readonly networkType: string | null;
  /** Threads the client had open when it last reported. */
  readonly viewingThreadIds: ReadonlyArray<string>;
  readonly lastReportAtMs: number;
  readonly leaseExpiresAtMs: number;
  readonly lastInteractionAtMs: number | null;
  readonly lastFocusedAtMs: number | null;
  /** Newest report that carried the asked thread in scope, if any. */
  readonly lastViewedThisSessionAtMs: number | null;
}

export interface PresencePersonInput {
  /** `null` groups clients whose auth session carries no user identity. */
  readonly userId: string | null;
  readonly email: string | null;
  readonly name: string | null;
  readonly roles: ReadonlyArray<PresenceRole>;
  readonly clients: ReadonlyArray<PresenceClientInput>;
  /** Auth-session reconnect time from the sessions table (Settings → Connections "Last seen"). */
  readonly authSessionLastConnectedAtMs: number | null;
  /** Whether any of the person's auth sessions currently holds a WebSocket. */
  readonly authSessionConnected: boolean;
  /** Environment-user directory `lastSeenAt`. */
  readonly directoryLastSeenAtMs: number | null;
  /** The person's newest user message in the asked thread. */
  readonly lastMessageInSessionAtMs: number | null;
}

export interface PresenceSessionInput {
  readonly sessionId: string;
  readonly title: string | null;
  readonly status: string;
  readonly isRunning: boolean;
  readonly needsHumanAttention: boolean;
  readonly humanAttentionReasons: ReadonlyArray<string>;
  readonly archived: boolean;
}

export interface PresenceReportInput {
  readonly nowMs: number;
  /** When the first client report arrived; `null` until one has. */
  readonly trackingSinceMs: number | null;
  readonly session: PresenceSessionInput;
  readonly people: ReadonlyArray<PresencePersonInput>;
  /** Extra caveats the caller already knows (for example "thread has no owner"). */
  readonly caveats?: ReadonlyArray<string>;
}

export interface PresenceClientReport {
  readonly clientId: string;
  readonly clientKind: ClientKind;
  readonly live: boolean;
  readonly visible: boolean;
  readonly focused: boolean;
  readonly recentlyInteracted: boolean;
  readonly appState: PresenceClientInput["appState"];
  /** From the last report; `live` says whether that report still counts. */
  readonly viewingThisSession: boolean;
  /** Some other session was open instead. Which one is never reported. */
  readonly viewingAnotherSession: boolean;
  readonly lastReportAt: string;
  readonly secondsSinceReport: number;
  readonly leaseExpiresAt: string;
  readonly lowPowerMode: string | null;
  readonly batteryState: string | null;
  readonly networkType: string | null;
}

export interface PresencePersonReport {
  readonly userId: string | null;
  readonly email: string | null;
  readonly name: string | null;
  readonly roles: ReadonlyArray<PresenceRole>;
  readonly state: PresenceState;
  readonly stateReason: string;
  readonly viewingThisSession: boolean;
  readonly lastViewedThisSessionAt: string | null;
  readonly lastInteractionAt: string | null;
  readonly secondsSinceInteraction: number | null;
  readonly lastSeenAt: string | null;
  readonly secondsSinceSeen: number | null;
  readonly lastMessageInSessionAt: string | null;
  readonly secondsSinceLastMessageInSession: number | null;
  readonly connected: boolean;
  readonly clients: ReadonlyArray<PresenceClientReport>;
}

export interface PresenceRecommendation {
  readonly action: PresenceAction;
  readonly reason: string;
  /** Information only: agents do not poll on it. */
  readonly suggestedFollowUpSeconds: number;
}

export interface PresenceReport {
  readonly now: string;
  readonly trackingSince: string | null;
  readonly heartbeatIntervalMs: number;
  readonly leaseTtlMs: number;
  readonly session: PresenceSessionInput;
  readonly people: ReadonlyArray<PresencePersonReport>;
  readonly attended: boolean;
  readonly recommendation: PresenceRecommendation;
  readonly caveats: ReadonlyArray<string>;
}

const STATE_RANK: Record<PresenceState, number> = {
  "viewing-this-session": 0,
  "active-elsewhere": 1,
  idle: 2,
  background: 3,
  away: 4,
  unknown: 5,
};

const iso = (ms: number): string => DateTime.formatIso(DateTime.makeUnsafe(ms));
const isoOrNull = (ms: number | null): string | null => (ms === null ? null : iso(ms));
const secondsSince = (nowMs: number, ms: number | null): number | null =>
  ms === null ? null : Math.max(0, Math.round((nowMs - ms) / 1000));
const maxMs = (...values: ReadonlyArray<number | null>): number | null =>
  values.reduce<number | null>(
    (best, value) => (value === null ? best : best === null ? value : Math.max(best, value)),
    null,
  );

export const describeClientKind = (kind: ClientKind): string => {
  switch (kind) {
    case "desktop-renderer":
      return "desktop app";
    case "web":
      return "browser";
    case "mobile":
      return "mobile app";
    case "unknown":
      return "client";
  }
};

const describeAgo = (nowMs: number, ms: number | null): string => {
  const seconds = secondsSince(nowMs, ms);
  if (seconds === null) return "never";
  if (seconds < 60) return `${seconds} s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} h ago`;
  return `${Math.round(seconds / 86_400)} d ago`;
};

export const isClientLive = (client: PresenceClientInput, nowMs: number): boolean =>
  client.leaseExpiresAtMs > nowMs;

export const clientViewsSession = (client: PresenceClientInput, sessionId: string): boolean =>
  client.viewingThreadIds.includes(sessionId);

const isForeground = (client: PresenceClientInput): boolean =>
  client.visible && client.appState !== "background" && client.appState !== "inactive";

/** An input event within the interaction window, by the report flag or the tracker's history. */
export const interactedRecently = (client: PresenceClientInput, nowMs: number): boolean =>
  client.lastInteractionAtMs === null
    ? client.recentlyInteracted
    : nowMs - client.lastInteractionAtMs <= PRESENCE_INTERACTION_WINDOW_MS;

/**
 * The state one client contributes. `null` when the client's lease has
 * expired: an expired lease says nothing about now, only about the past.
 */
export function classifyClient(
  client: PresenceClientInput,
  sessionId: string,
  nowMs: number,
): PresenceState | null {
  if (!isClientLive(client, nowMs)) return null;
  if (!isForeground(client)) return "background";
  const interacted = interactedRecently(client, nowMs);
  const viewing = clientViewsSession(client, sessionId);
  if (viewing && interacted) return "viewing-this-session";
  if (!viewing && client.focused && interacted) return "active-elsewhere";
  return "idle";
}

const bestState = (states: ReadonlyArray<PresenceState>): PresenceState | null =>
  states.length === 0
    ? null
    : states.reduce((best, state) => (STATE_RANK[state] < STATE_RANK[best] ? state : best));

const describeClient = (
  client: PresenceClientInput,
  state: PresenceState,
  sessionId: string,
  nowMs: number,
): string => {
  const kind = describeClientKind(client.clientKind);
  const interaction =
    client.lastInteractionAtMs === null
      ? client.recentlyInteracted
        ? "interacting"
        : "no input seen"
      : interactedRecently(client, nowMs)
        ? `interacted ${describeAgo(nowMs, client.lastInteractionAtMs)}`
        : `no input for ${describeAgo(nowMs, client.lastInteractionAtMs).replace(/ ago$/, "")}`;
  switch (state) {
    case "viewing-this-session":
      return `${client.focused ? "focused" : "visible"} ${kind}, this session open, ${interaction}`;
    case "active-elsewhere":
      return `focused ${kind} in ${client.viewingThreadIds.length > 0 ? "another session" : "another view"}, ${interaction}`;
    case "idle": {
      const where = clientViewsSession(client, sessionId)
        ? "this session open"
        : client.viewingThreadIds.length > 0
          ? "another session open"
          : "no session open";
      return `${kind} visible${client.focused ? "" : ", not focused"}, ${where}, ${interaction}`;
    }
    case "background":
      return `${kind} connected but ${client.appState === "background" || client.appState === "inactive" ? "in the background" : "hidden"}, last reported ${describeAgo(nowMs, client.lastReportAtMs)}`;
    case "away":
    case "unknown":
      return `${kind} last reported ${describeAgo(nowMs, client.lastReportAtMs)}`;
  }
};

/** Derives one person's state and the sentence that explains it. */
export function derivePersonPresence(
  person: PresencePersonInput,
  sessionId: string,
  nowMs: number,
): PresencePersonReport {
  const classified = person.clients.map((client) => ({
    client,
    state: classifyClient(client, sessionId, nowMs),
  }));
  const liveStates = classified.flatMap(({ state }) => (state === null ? [] : [state]));
  const lastReportAtMs = maxMs(...person.clients.map((client) => client.lastReportAtMs));
  const lastInteractionAtMs = maxMs(...person.clients.map((client) => client.lastInteractionAtMs));
  const lastViewedThisSessionAtMs = maxMs(
    ...person.clients.map((client) => client.lastViewedThisSessionAtMs),
  );
  const lastSeenAtMs = maxMs(
    lastReportAtMs,
    person.authSessionLastConnectedAtMs,
    person.directoryLastSeenAtMs,
    person.lastMessageInSessionAtMs,
  );

  let state: PresenceState;
  let stateReason: string;
  const live = bestState(liveStates);
  if (live !== null) {
    state = live;
    const witness = classified.find((entry) => entry.state === live);
    stateReason = witness ? describeClient(witness.client, live, sessionId, nowMs) : live;
  } else if (lastSeenAtMs === null) {
    state = "unknown";
    stateReason =
      person.userId === null
        ? "no client without an identity has reported"
        : "never observed: no client report, no login, no message";
  } else {
    state = "away";
    const parts: Array<string> = [];
    if (lastReportAtMs !== null) {
      parts.push(`no live client, last report ${describeAgo(nowMs, lastReportAtMs)}`);
    } else if (person.authSessionConnected) {
      parts.push("a login holds a connection but has not sent an activity report yet");
    } else {
      parts.push("no client report since tracking started");
    }
    if (lastInteractionAtMs !== null) {
      parts.push(`last input ${describeAgo(nowMs, lastInteractionAtMs)}`);
    }
    if (person.authSessionLastConnectedAtMs !== null) {
      parts.push(`login last seen ${describeAgo(nowMs, person.authSessionLastConnectedAtMs)}`);
    }
    if (person.lastMessageInSessionAtMs !== null) {
      parts.push(`last message here ${describeAgo(nowMs, person.lastMessageInSessionAtMs)}`);
    }
    stateReason = parts.join("; ");
  }

  // Open and in the foreground counts as viewing even without recent input;
  // the state says whether anyone is actually reading it.
  const viewingThisSession = person.clients.some(
    (client) =>
      isClientLive(client, nowMs) && isForeground(client) && clientViewsSession(client, sessionId),
  );
  return {
    userId: person.userId,
    email: person.email,
    name: person.name,
    roles: person.roles,
    state,
    stateReason,
    viewingThisSession,
    lastViewedThisSessionAt: isoOrNull(lastViewedThisSessionAtMs),
    lastInteractionAt: isoOrNull(lastInteractionAtMs),
    secondsSinceInteraction: secondsSince(nowMs, lastInteractionAtMs),
    lastSeenAt: isoOrNull(lastSeenAtMs),
    secondsSinceSeen: secondsSince(nowMs, lastSeenAtMs),
    lastMessageInSessionAt: isoOrNull(person.lastMessageInSessionAtMs),
    secondsSinceLastMessageInSession: secondsSince(nowMs, person.lastMessageInSessionAtMs),
    connected: person.authSessionConnected || liveStates.length > 0,
    clients: classified
      .map(({ client, state: clientState }) => ({
        clientId: client.clientId,
        clientKind: client.clientKind,
        live: clientState !== null,
        visible: client.visible,
        focused: client.focused,
        recentlyInteracted: client.recentlyInteracted,
        appState: client.appState,
        viewingThisSession: clientViewsSession(client, sessionId),
        viewingAnotherSession:
          !clientViewsSession(client, sessionId) && client.viewingThreadIds.length > 0,
        lastReportAt: iso(client.lastReportAtMs),
        secondsSinceReport: secondsSince(nowMs, client.lastReportAtMs) ?? 0,
        leaseExpiresAt: iso(client.leaseExpiresAtMs),
        lowPowerMode: client.lowPowerMode,
        batteryState: client.batteryState,
        networkType: client.networkType,
      }))
      .toSorted((left, right) => right.lastReportAt.localeCompare(left.lastReportAt)),
  };
}

const personLabel = (person: PresencePersonReport): string =>
  person.name ?? person.email ?? person.userId ?? "an unidentified client";

/** Picks the action for the best-placed relevant person. */
export const isWarmingUp = (nowMs: number, trackingSinceMs: number | null): boolean =>
  trackingSinceMs === null || nowMs - trackingSinceMs < PRESENCE_WARMUP_MS;

const describeWarmup = (nowMs: number, trackingSinceMs: number | null): string =>
  trackingSinceMs === null
    ? "no client has reported since the server started"
    : `tracking started ${describeAgo(nowMs, trackingSinceMs)}`;

export function recommend(
  people: ReadonlyArray<PresencePersonReport>,
  nowMs: number,
  trackingSinceMs: number | null,
): PresenceRecommendation {
  const ranked = people.toSorted((left, right) => STATE_RANK[left.state] - STATE_RANK[right.state]);
  const best = ranked[0];
  const warmingUp = isWarmingUp(nowMs, trackingSinceMs);
  if (best === undefined) {
    return {
      action: warmingUp ? "wait-for-reply" : "ask-in-chat-and-wait",
      reason: warmingUp
        ? `nobody is linked to this session and ${describeWarmup(nowMs, trackingSinceMs)}; ask in chat and keep the session open`
        : "nobody is linked to this session and no client has reported for this session; ask in chat and keep the session open",
      suggestedFollowUpSeconds: warmingUp ? 60 : 1800,
    };
  }
  const label = personLabel(best);
  switch (best.state) {
    case "viewing-this-session":
      return {
        action: "ask-in-chat",
        reason: `${label} has this session open now (${best.stateReason}); a chat question will be seen`,
        suggestedFollowUpSeconds: 120,
      };
    case "active-elsewhere":
      return {
        action: "ask-in-chat-and-wait",
        reason: `${label} is active but in another session (${best.stateReason}); ask in chat and keep the session open`,
        suggestedFollowUpSeconds: 300,
      };
    case "idle":
      return {
        action: "ask-in-chat-and-wait",
        reason: `${label} has T3 open but has not touched it lately (${best.stateReason}); ask in chat and keep the session open`,
        suggestedFollowUpSeconds: 600,
      };
    case "background":
      return {
        action: "ask-in-chat-and-wait",
        reason: `${label} is connected but T3 is in the background (${best.stateReason}); ask in chat and keep the session open`,
        suggestedFollowUpSeconds: 900,
      };
    case "away":
    case "unknown": {
      const recentEvidence =
        best.secondsSinceSeen !== null &&
        best.secondsSinceSeen * 1000 < PRESENCE_RECENT_EVIDENCE_MS;
      if (recentEvidence || warmingUp) {
        return {
          action: "wait-for-reply",
          reason: warmingUp
            ? `${describeWarmup(nowMs, trackingSinceMs)}, so a missing client is not evidence of absence; ask in chat and keep the session open`
            : `${label} was seen ${describeAgo(nowMs, nowMs - (best.secondsSinceSeen ?? 0) * 1000)} but has no live client; ask in chat and keep the session open, they may answer soon`,
          suggestedFollowUpSeconds: 60,
        };
      }
      return {
        action: "ask-in-chat-and-wait",
        reason: `${label} has no live client (${best.stateReason}); ask in chat and keep the session open, they read it when they come back`,
        suggestedFollowUpSeconds: 1800,
      };
    }
  }
}

/** Builds the whole answer; the service only gathers inputs. */
export function buildPresenceReport(input: PresenceReportInput): PresenceReport {
  const { nowMs, trackingSinceMs, session } = input;
  const people = input.people
    .map((person) => derivePersonPresence(person, session.sessionId, nowMs))
    .toSorted((left, right) => STATE_RANK[left.state] - STATE_RANK[right.state]);
  const attended = people.some(
    (person) => person.state === "viewing-this-session" || person.state === "active-elsewhere",
  );
  const caveats: Array<string> = [...(input.caveats ?? [])];
  if (isWarmingUp(nowMs, trackingSinceMs)) {
    caveats.push(
      `${describeWarmup(nowMs, trackingSinceMs)} (server restart); clients report every ${PRESENCE_HEARTBEAT_INTERVAL_MS / 1000} s, so the live picture may be incomplete`,
    );
  }
  const unidentified = people.find((person) => person.userId === null);
  if (unidentified && unidentified.clients.some((client) => client.live)) {
    caveats.push(
      `${unidentified.clients.filter((client) => client.live).length} live client(s) carry no user identity and are grouped under userId null`,
    );
  }
  if (
    people.some((person) =>
      person.clients.some((client) => client.clientKind === "mobile" && !client.live),
    )
  ) {
    caveats.push(
      "a mobile client stops reporting as soon as the app leaves the foreground, so its absence does not mean the phone is unreachable",
    );
  }
  if (session.archived) {
    caveats.push("this session is archived");
  }
  return {
    now: iso(nowMs),
    trackingSince: isoOrNull(trackingSinceMs),
    heartbeatIntervalMs: PRESENCE_HEARTBEAT_INTERVAL_MS,
    leaseTtlMs: PRESENCE_LEASE_TTL_MS,
    session,
    people,
    attended,
    recommendation: recommend(people, nowMs, trackingSinceMs),
    caveats,
  };
}
