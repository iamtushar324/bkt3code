/**
 * T3-CUSTOM(expbkt3): every state and recommendation branch of the presence
 * rules, plus the restart and identity caveats.
 */
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import {
  buildPresenceReport,
  classifyClient,
  derivePersonPresence,
  PRESENCE_INTERACTION_WINDOW_MS,
  PRESENCE_RECENT_EVIDENCE_MS,
  PRESENCE_WARMUP_MS,
  recommend,
  type PresenceClientInput,
  type PresencePersonInput,
  type PresenceSessionInput,
} from "./presenceModel.ts";

const NOW = Date.parse("2026-09-29T12:00:00.000Z");
const MINUTE = 60_000;
const SESSION = "thread-here";
const OTHER = "thread-elsewhere";
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

/** Walks a value's strings without serialising it, so no thread id can hide in a nested field. */
const mentions = (value: unknown, needle: string): boolean =>
  typeof value === "string"
    ? value.includes(needle)
    : Array.isArray(value)
      ? value.some((entry) => mentions(entry, needle))
      : typeof value === "object" && value !== null
        ? Object.values(value).some((entry) => mentions(entry, needle))
        : false;

const session: PresenceSessionInput = {
  sessionId: SESSION,
  title: "Presence",
  status: "running",
  isRunning: true,
  needsHumanAttention: false,
  humanAttentionReasons: [],
  archived: false,
};

function client(overrides: Partial<PresenceClientInput> = {}): PresenceClientInput {
  return {
    clientId: "client-1",
    clientKind: "desktop-renderer",
    visible: true,
    focused: true,
    recentlyInteracted: true,
    appState: "active",
    lowPowerMode: null,
    batteryState: null,
    networkType: null,
    viewingThreadIds: [SESSION],
    lastReportAtMs: NOW - 8_000,
    leaseExpiresAtMs: NOW + 37_000,
    lastInteractionAtMs: NOW - 8_000,
    lastFocusedAtMs: NOW - 8_000,
    lastViewedThisSessionAtMs: NOW - 8_000,
    ...overrides,
  };
}

/** A focused window nobody has touched for longer than the interaction window. */
const stale = { recentlyInteracted: false, lastInteractionAtMs: NOW - 5 * MINUTE } as const;

function person(overrides: Partial<PresencePersonInput> = {}): PresencePersonInput {
  return {
    userId: "user-owner",
    email: "owner@example.com",
    name: "Owner",
    roles: ["owner"],
    clients: [],
    authSessionLastConnectedAtMs: null,
    authSessionConnected: false,
    directoryLastSeenAtMs: null,
    lastMessageInSessionAtMs: null,
    ...overrides,
  };
}

describe("classifyClient", () => {
  it("says nothing about a client whose lease has expired", () => {
    expect(classifyClient(client({ leaseExpiresAtMs: NOW - 1 }), SESSION, NOW)).toBeNull();
  });

  it("is viewing when the session is in scope on a visible client with recent input", () => {
    expect(classifyClient(client(), SESSION, NOW)).toBe("viewing-this-session");
    expect(classifyClient(client({ focused: false }), SESSION, NOW)).toBe("viewing-this-session");
    expect(
      classifyClient(
        client({
          recentlyInteracted: false,
          lastInteractionAtMs: NOW - PRESENCE_INTERACTION_WINDOW_MS,
        }),
        SESSION,
        NOW,
      ),
    ).toBe("viewing-this-session");
  });

  it("drops a focused window to idle once the interaction window has passed", () => {
    expect(classifyClient(client(stale), SESSION, NOW)).toBe("idle");
    expect(
      classifyClient(
        client({
          recentlyInteracted: false,
          lastInteractionAtMs: NOW - PRESENCE_INTERACTION_WINDOW_MS - 1,
        }),
        SESSION,
        NOW,
      ),
    ).toBe("idle");
    expect(classifyClient(client({ ...stale, viewingThreadIds: [OTHER] }), SESSION, NOW)).toBe(
      "idle",
    );
  });

  it("falls back to the report flag when the tracker has no interaction history", () => {
    expect(
      classifyClient(client({ recentlyInteracted: true, lastInteractionAtMs: null }), SESSION, NOW),
    ).toBe("viewing-this-session");
    expect(
      classifyClient(
        client({ recentlyInteracted: false, lastInteractionAtMs: null }),
        SESSION,
        NOW,
      ),
    ).toBe("idle");
  });

  it("is active elsewhere when focused with recent input on another thread", () => {
    expect(classifyClient(client({ viewingThreadIds: [OTHER] }), SESSION, NOW)).toBe(
      "active-elsewhere",
    );
    expect(classifyClient(client({ viewingThreadIds: [] }), SESSION, NOW)).toBe("active-elsewhere");
    expect(
      classifyClient(client({ viewingThreadIds: [OTHER], focused: false }), SESSION, NOW),
    ).toBe("idle");
  });

  it("is background when hidden or when the mobile app left the foreground", () => {
    expect(classifyClient(client({ visible: false }), SESSION, NOW)).toBe("background");
    expect(
      classifyClient(
        client({ clientKind: "mobile", visible: true, appState: "background" }),
        SESSION,
        NOW,
      ),
    ).toBe("background");
    expect(classifyClient(client({ appState: "inactive" }), SESSION, NOW)).toBe("background");
  });
});

describe("derivePersonPresence", () => {
  it("takes the best state across clients and explains it", () => {
    const report = derivePersonPresence(
      person({
        clients: [
          client({
            clientId: "phone",
            clientKind: "mobile",
            appState: "background",
            visible: false,
          }),
          client({ clientId: "laptop" }),
        ],
      }),
      SESSION,
      NOW,
    );
    expect(report.state).toBe("viewing-this-session");
    expect(report.viewingThisSession).toBe(true);
    expect(report.stateReason).toBe("focused desktop app, this session open, interacted 8 s ago");
    expect(report.secondsSinceInteraction).toBe(8);
    expect(report.clients.map((entry) => entry.clientId)).toEqual(["phone", "laptop"]);
    expect(report.clients.every((entry) => entry.live)).toBe(true);
    expect(report.connected).toBe(true);
  });

  it("keeps viewingThisSession while idle with the session open", () => {
    const report = derivePersonPresence(person({ clients: [client(stale)] }), SESSION, NOW);
    expect(report.state).toBe("idle");
    expect(report.viewingThisSession).toBe(true);
    expect(report.stateReason).toBe("desktop app visible, this session open, no input for 5 min");
    expect(report.clients[0]?.viewingThisSession).toBe(true);
    expect(report.clients[0]?.viewingAnotherSession).toBe(false);
  });

  it("is away with history after the lease expires, and keeps the durable facts", () => {
    const report = derivePersonPresence(
      person({
        clients: [
          client({
            leaseExpiresAtMs: NOW - 5 * MINUTE,
            lastReportAtMs: NOW - 6 * MINUTE,
            lastInteractionAtMs: NOW - 7 * MINUTE,
            lastViewedThisSessionAtMs: NOW - 6 * MINUTE,
          }),
        ],
        authSessionLastConnectedAtMs: NOW - 4 * MINUTE,
        lastMessageInSessionAtMs: NOW - 30 * MINUTE,
      }),
      SESSION,
      NOW,
    );
    expect(report.state).toBe("away");
    expect(report.viewingThisSession).toBe(false);
    expect(report.lastViewedThisSessionAt).toBe(iso(NOW - 6 * MINUTE));
    expect(report.lastSeenAt).toBe(iso(NOW - 4 * MINUTE));
    expect(report.secondsSinceSeen).toBe(240);
    expect(report.secondsSinceLastMessageInSession).toBe(1800);
    expect(report.stateReason).toBe(
      "no live client, last report 6 min ago; last input 7 min ago; login last seen 4 min ago; last message here 30 min ago",
    );
    expect(report.clients[0]?.live).toBe(false);
  });

  it("is away, not unknown, when only a durable fact is known", () => {
    const report = derivePersonPresence(
      person({ directoryLastSeenAtMs: NOW - 3 * MINUTE }),
      SESSION,
      NOW,
    );
    expect(report.state).toBe("away");
    expect(report.stateReason).toBe("no client report since tracking started");
  });

  it("is unknown when nothing at all has been observed", () => {
    const report = derivePersonPresence(person(), SESSION, NOW);
    expect(report.state).toBe("unknown");
    expect(report.lastSeenAt).toBeNull();
    expect(report.stateReason).toBe("never observed: no client report, no login, no message");
  });

  it("never names the other session a client has open", () => {
    const report = derivePersonPresence(
      person({ clients: [client({ viewingThreadIds: [OTHER] })] }),
      SESSION,
      NOW,
    );
    expect(report.state).toBe("active-elsewhere");
    expect(report.clients[0]?.viewingThisSession).toBe(false);
    expect(report.clients[0]?.viewingAnotherSession).toBe(true);
    expect(report.stateReason).toBe("focused desktop app in another session, interacted 8 s ago");
    expect(mentions(report, OTHER)).toBe(false);

    const idleElsewhere = derivePersonPresence(
      person({ clients: [client({ ...stale, viewingThreadIds: [OTHER] })] }),
      SESSION,
      NOW,
    );
    expect(idleElsewhere.stateReason).toBe(
      "desktop app visible, another session open, no input for 5 min",
    );
    expect(mentions(idleElsewhere, OTHER)).toBe(false);
  });
});

describe("recommend", () => {
  const derived = (input: PresencePersonInput) => derivePersonPresence(input, SESSION, NOW);
  const settled = NOW - 10 * MINUTE;

  it("asks in chat for a viewer", () => {
    const recommendation = recommend([derived(person({ clients: [client()] }))], NOW, settled);
    expect(recommendation.action).toBe("ask-in-chat");
    expect(recommendation.suggestedFollowUpSeconds).toBe(120);
    expect(recommendation.reason).toContain("Owner has this session open now");
  });

  it("asks in chat and notifies for active-elsewhere, idle (even with this session open) and background", () => {
    const cases: ReadonlyArray<[Partial<PresenceClientInput>, number]> = [
      [{ viewingThreadIds: [OTHER] }, 300],
      [stale, 600],
      [{ ...stale, viewingThreadIds: [OTHER] }, 600],
      [{ visible: false }, 900],
    ];
    for (const [overrides, followUp] of cases) {
      const recommendation = recommend(
        [derived(person({ clients: [client(overrides)] }))],
        NOW,
        settled,
      );
      expect(recommendation.action).toBe("ask-in-chat-and-notify");
      expect(recommendation.suggestedFollowUpSeconds).toBe(followUp);
    }
  });

  it("notifies on Mattermost for someone away for a while", () => {
    const recommendation = recommend(
      [derived(person({ authSessionLastConnectedAtMs: NOW - 2 * PRESENCE_RECENT_EVIDENCE_MS }))],
      NOW,
      settled,
    );
    expect(recommendation.action).toBe("notify-mattermost");
    expect(recommendation.suggestedFollowUpSeconds).toBe(1800);
  });

  it("waits for a reply when the person was here moments ago", () => {
    const recommendation = recommend(
      [derived(person({ lastMessageInSessionAtMs: NOW - 30_000 }))],
      NOW,
      settled,
    );
    expect(recommendation.action).toBe("wait-for-reply");
    expect(recommendation.reason).toContain("was seen 30 s ago");
    expect(recommendation.suggestedFollowUpSeconds).toBe(60);
  });

  it("waits rather than escalating while the tracker is warming up or has no report yet", () => {
    const justStarted = NOW - PRESENCE_WARMUP_MS / 2;
    expect(recommend([derived(person())], NOW, justStarted).action).toBe("wait-for-reply");
    expect(recommend([derived(person())], NOW, null).action).toBe("wait-for-reply");
    expect(recommend([derived(person())], NOW, null).reason).toContain(
      "no client has reported since the server started",
    );
    expect(recommend([], NOW, justStarted).action).toBe("wait-for-reply");
    expect(recommend([], NOW, settled).action).toBe("notify-mattermost");
  });

  it("follows the best-placed person", () => {
    const recommendation = recommend(
      [
        derived(person({ userId: "u1", name: "Away" })),
        derived(person({ userId: "u2", name: "Here", clients: [client()] })),
      ],
      NOW,
      settled,
    );
    expect(recommendation.action).toBe("ask-in-chat");
    expect(recommendation.reason).toContain("Here has this session open");
  });
});

describe("buildPresenceReport", () => {
  it("orders people by state, computes attended, and echoes the constants", () => {
    const report = buildPresenceReport({
      nowMs: NOW,
      trackingSinceMs: NOW - 10 * MINUTE,
      session,
      people: [
        person({ userId: "u1", name: "Away" }),
        person({ userId: "u2", name: "Here", clients: [client()] }),
      ],
    });
    expect(report.people.map((entry) => entry.name)).toEqual(["Here", "Away"]);
    expect(report.attended).toBe(true);
    expect(report.heartbeatIntervalMs).toBe(25_000);
    expect(report.leaseTtlMs).toBe(45_000);
    expect(report.now).toBe("2026-09-29T12:00:00.000Z");
    expect(report.trackingSince).toBe(iso(NOW - 10 * MINUTE));
    expect(report.caveats).toEqual([]);
  });

  it("is unattended when nobody is live or everyone is idle, and adds the restart caveat", () => {
    const report = buildPresenceReport({
      nowMs: NOW,
      trackingSinceMs: NOW - 10_000,
      session,
      people: [person({ clients: [client({ visible: false })] })],
      caveats: ["this session has no owner"],
    });
    expect(report.attended).toBe(false);
    expect(report.caveats[0]).toBe("this session has no owner");
    expect(report.caveats[1]).toContain("tracking started 10 s ago");

    const idle = buildPresenceReport({
      nowMs: NOW,
      trackingSinceMs: NOW - 10 * MINUTE,
      session,
      people: [person({ clients: [client(stale)] })],
    });
    expect(idle.attended).toBe(false);
    expect(idle.people[0]?.viewingThisSession).toBe(true);
  });

  it("reports a null trackingSince and its caveat before any client has reported", () => {
    const report = buildPresenceReport({
      nowMs: NOW,
      trackingSinceMs: null,
      session,
      people: [person()],
    });
    expect(report.trackingSince).toBeNull();
    expect(report.caveats[0]).toContain("no client has reported since the server started");
    expect(report.recommendation.action).toBe("wait-for-reply");
  });

  it("flags unidentified live clients and vanished mobile clients", () => {
    const report = buildPresenceReport({
      nowMs: NOW,
      trackingSinceMs: NOW - 10 * MINUTE,
      session: { ...session, archived: true },
      people: [
        person({ userId: null, email: null, name: null, roles: ["viewer"], clients: [client()] }),
        person({
          clients: [client({ clientKind: "mobile", leaseExpiresAtMs: NOW - 1 })],
        }),
      ],
    });
    expect(report.attended).toBe(true);
    expect(report.caveats).toEqual([
      "1 live client(s) carry no user identity and are grouped under userId null",
      "a mobile client stops reporting as soon as the app leaves the foreground, so its absence does not mean the phone is unreachable",
      "this session is archived",
    ]);
  });
});
