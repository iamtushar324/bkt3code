import { describe, expect, it } from "vite-plus/test";

import {
  commandIdForPaletteItem,
  commandIdFromPaletteValue,
  createKeyThrottle,
  createVisibilityReporter,
  isAnalyticsSettingKey,
  resolveConnectionMode,
  sanitizeAnalyticsProperties,
  stripUrlProperties,
  viewNameFromRouteId,
} from "./productAnalytics.logic";

describe("sanitizeAnalyticsProperties", () => {
  it("keeps only the event's allowlisted keys", () => {
    expect(
      sanitizeAnalyticsProperties("composer.sent", {
        threadId: "thread-1",
        interactionMode: "plan",
        hasAttachments: true,
        viaKeyboard: false,
        prompt: "secret text",
        title: "Fix the login page",
      }),
    ).toEqual({
      threadId: "thread-1",
      interactionMode: "plan",
      hasAttachments: true,
      viaKeyboard: false,
    });
  });

  it("drops objects, long strings and non-finite numbers", () => {
    expect(
      sanitizeAnalyticsProperties("settings.changed", { settingKey: { nested: "value" } }),
    ).toEqual({});
    expect(sanitizeAnalyticsProperties("view.changed", { view: "x".repeat(500) })).toEqual({});
    expect(sanitizeAnalyticsProperties("command_palette.used", { commandId: Number.NaN })).toEqual(
      {},
    );
  });

  it("keeps nothing for unknown events or missing properties", () => {
    expect(sanitizeAnalyticsProperties("custom.event", { threadId: "t" })).toEqual({});
    expect(sanitizeAnalyticsProperties("app.opened", { threadId: "t" })).toEqual({});
    expect(sanitizeAnalyticsProperties("composer.sent", undefined)).toEqual({});
  });
});

describe("viewNameFromRouteId", () => {
  it("names a view by its route template, never by ids", () => {
    expect(viewNameFromRouteId("/_chat/$environmentId/$threadId")).toBe(
      "/chat/$environmentId/$threadId",
    );
    expect(viewNameFromRouteId("/_chat/draft/$draftId")).toBe("/chat/draft/$draftId");
    expect(viewNameFromRouteId("/_chat/")).toBe("/chat");
    expect(viewNameFromRouteId("/settings/general")).toBe("/settings/general");
    expect(viewNameFromRouteId("__root__")).toBe("/");
  });

  it("drops segments that look like concrete values", () => {
    expect(viewNameFromRouteId("/projects/3f2a9c1e-uuid/thread title")).toBe("/projects");
    expect(viewNameFromRouteId(null)).toBeNull();
  });
});

describe("palette command ids", () => {
  it("keeps the command kind and drops environment ids, paths and text", () => {
    expect(commandIdFromPaletteValue("action:add-project:env-123:local")).toBe(
      "action:add-project",
    );
    expect(commandIdFromPaletteValue("appearance:dark")).toBe("appearance:dark");
    expect(commandIdFromPaletteValue("thread:01HZX9")).toBe("thread");
    expect(commandIdFromPaletteValue("/home/user/repo")).toBeNull();
  });

  it("prefers the keybinding command and hides project script names", () => {
    expect(commandIdForPaletteItem({ shortcutCommand: "terminal.toggle", value: "x" })).toBe(
      "terminal.toggle",
    );
    expect(commandIdForPaletteItem({ shortcutCommand: "script.deploy-prod.run", value: "x" })).toBe(
      "script.run",
    );
    expect(commandIdForPaletteItem({ value: "action:new-thread" })).toBe("action:new-thread");
  });
});

describe("isAnalyticsSettingKey", () => {
  it("accepts identifiers only", () => {
    expect(isAnalyticsSettingKey("followUpBehavior")).toBe(true);
    expect(isAnalyticsSettingKey("some value with spaces")).toBe(false);
    expect(isAnalyticsSettingKey("/path")).toBe(false);
  });
});

describe("resolveConnectionMode", () => {
  const primary = (httpBaseUrl: string) =>
    ({ _tag: "PrimaryConnectionTarget", httpBaseUrl }) as const;

  it("tells local, tailnet and remote primaries apart", () => {
    expect(resolveConnectionMode(primary("http://localhost:3773"))).toBe("local");
    expect(resolveConnectionMode(primary("http://127.0.0.1:3773"))).toBe("local");
    expect(resolveConnectionMode(primary("https://dev-server-1.tailab6257.ts.net"))).toBe(
      "tailnet",
    );
    expect(resolveConnectionMode(primary("http://100.101.5.7:3773"))).toBe("tailnet");
    expect(resolveConnectionMode(primary("https://bkt3.example.com"))).toBe("remote");
  });

  it("maps other targets by kind", () => {
    expect(resolveConnectionMode({ _tag: "RelayConnectionTarget" })).toBe("relay");
    expect(resolveConnectionMode({ _tag: "SshConnectionTarget" })).toBe("ssh");
    expect(resolveConnectionMode({ _tag: "BearerConnectionTarget" })).toBe("remote");
    expect(resolveConnectionMode(null)).toBeNull();
  });
});

describe("stripUrlProperties", () => {
  it("removes the URL and title properties PostHog adds", () => {
    expect(
      stripUrlProperties({
        $current_url: "https://bkt3/chat/env/thread",
        $pathname: "/chat/env/thread",
        $title: "Fix login",
        $browser: "Chrome",
        view: "/chat",
      }),
    ).toEqual({ $browser: "Chrome", view: "/chat" });
  });

  it("removes every session-entry, initial and previous-pageview property by prefix", () => {
    expect(
      stripUrlProperties({
        $session_entry_url: "https://bkt3/pull-requests?repository=owner/repo",
        $session_entry_pathname: "/pull-requests",
        $session_entry_referrer: "https://github.com/owner/repo",
        $session_entry_host: "bkt3",
        $session_entry_some_future_key: "x",
        $initial_person_info: { u: "https://bkt3/chat/env/thread", r: "$direct" },
        $initial_referrer_info: { $referrer: "https://github.com" },
        $prev_pageview_pathname: "/chat/env/thread",
        $host: "dev-server-1.tailab6257.ts.net",
        utm_source: "newsletter",
        gclid: "abc",
        $session_id: "s1",
        instance: "bkt3",
      }),
    ).toEqual({ $session_id: "s1", instance: "bkt3" });
  });
});

describe("createVisibilityReporter", () => {
  function harness() {
    const timers = new Map<number, () => void>();
    let nextId = 0;
    const emitted: string[] = [];
    const reporter = createVisibilityReporter({
      delayMs: 1_000,
      emit: (state) => emitted.push(state),
      setTimer: (callback) => {
        nextId += 1;
        timers.set(nextId, callback);
        return nextId;
      },
      clearTimer: (handle) => timers.delete(handle as number),
    });
    const flush = () => {
      for (const [id, callback] of [...timers]) {
        timers.delete(id);
        callback();
      }
    };
    return { reporter, emitted, flush };
  }

  it("sends a settled change once", () => {
    const { reporter, emitted, flush } = harness();
    reporter.update("background");
    flush();
    reporter.update("background");
    flush();
    expect(emitted).toEqual(["background"]);
  });

  it("sends nothing for a quick hide and show", () => {
    const { reporter, emitted, flush } = harness();
    reporter.update("background");
    reporter.update("foreground");
    flush();
    expect(emitted).toEqual([]);
  });
});

describe("createKeyThrottle", () => {
  it("allows each key once per window", () => {
    let now = 0;
    const allow = createKeyThrottle(1_000, () => now);
    expect(allow("a")).toBe(true);
    expect(allow("a")).toBe(false);
    expect(allow("b")).toBe(true);
    now = 1_000;
    expect(allow("a")).toBe(true);
  });
});
