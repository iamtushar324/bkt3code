import { describe, expect, it } from "vite-plus/test";

import {
  createProductAnalytics,
  normalizeAnalyticsEmail,
  type ProductAnalyticsClient,
  type ProductAnalyticsContext,
  type ProductAnalyticsLoader,
} from "./productAnalytics";

interface FakeClient {
  readonly key: string;
  readonly captured: Array<{ event: string; properties: unknown }>;
  readonly identified: string[];
  readonly registered: Array<Record<string, unknown>>;
  readonly optIns: unknown[];
  optedOut: boolean;
}

function fakeLoader() {
  const clients: FakeClient[] = [];
  const load: ProductAnalyticsLoader = async (key) => {
    const fake: FakeClient = {
      key,
      captured: [],
      identified: [],
      registered: [],
      optIns: [],
      optedOut: false,
    };
    clients.push(fake);
    // opt_out_capturing is present so a regression that calls it is visible.
    const client = {
      capture: (event: string, properties?: unknown) => {
        fake.captured.push({ event, properties });
        return undefined;
      },
      identify: (id?: string) => {
        if (id !== undefined) fake.identified.push(id);
      },
      register: (properties: Record<string, unknown>) => {
        fake.registered.push(properties);
      },
      opt_in_capturing: (options?: unknown) => {
        fake.optIns.push(options);
      },
      opt_out_capturing: () => {
        fake.optedOut = true;
      },
    } as unknown as ProductAnalyticsClient;
    return client;
  };
  return { load, clients };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function context(config: ProductAnalyticsContext["config"]): ProductAnalyticsContext {
  return { config, surface: "web", appVersion: "1.2.3", connectionMode: "tailnet" };
}

const enabledConfig = {
  enabled: true,
  posthogKey: "phc_company",
  posthogHost: "https://us.i.posthog.com",
  instance: "bkt3",
};

describe("createProductAnalytics", () => {
  it("is a no-op and never loads PostHog when the config is missing", async () => {
    const loader = fakeLoader();
    const analytics = createProductAnalytics(loader.load);
    analytics.track("app.opened");
    analytics.configure(context(null));
    analytics.track("composer.sent", { threadId: "t1" });
    await flush();
    expect(loader.clients).toEqual([]);
    expect(analytics.isActive()).toBe(false);
  });

  it("is a no-op when the server marks analytics disabled", async () => {
    const loader = fakeLoader();
    const analytics = createProductAnalytics(loader.load);
    analytics.configure(context({ ...enabledConfig, enabled: false }));
    analytics.track("app.opened");
    await flush();
    expect(loader.clients).toEqual([]);
  });

  it("queues events until loaded, then sends sanitized properties", async () => {
    const loader = fakeLoader();
    const analytics = createProductAnalytics(loader.load);
    analytics.configure(context(enabledConfig));
    analytics.identify("  Person@Beknown.Work ");
    analytics.track("composer.sent", { threadId: "t1", prompt: "do not send me" });
    await flush();
    const [client] = loader.clients;
    expect(client?.captured).toEqual([{ event: "composer.sent", properties: { threadId: "t1" } }]);
    expect(client?.identified).toEqual(["person@beknown.work"]);
    expect(client?.optIns).toEqual([{ captureEventName: null }]);
    expect(client?.registered.at(-1)).toEqual({
      surface: "web",
      appVersion: "1.2.3",
      instance: "bkt3",
      connectionMode: "tailnet",
    });
  });

  it("never opts out: a config flap stops forwarding and reuses the same client", async () => {
    const loader = fakeLoader();
    const analytics = createProductAnalytics(loader.load);
    analytics.configure(context(enabledConfig));
    await flush();
    analytics.configure(context(null));
    analytics.track("app.opened");
    analytics.configure(context(enabledConfig));
    await flush();
    analytics.track("app.foregrounded");
    expect(loader.clients).toHaveLength(1);
    expect(loader.clients[0]?.optedOut).toBe(false);
    expect(loader.clients[0]?.captured.map((entry) => entry.event)).toEqual(["app.foregrounded"]);
  });

  it("sends to the new key only after a key change, without opting the old one out", async () => {
    const loader = fakeLoader();
    const analytics = createProductAnalytics(loader.load);
    analytics.configure(context(enabledConfig));
    await flush();
    analytics.configure(context({ ...enabledConfig, posthogKey: "phc_other" }));
    await flush();
    analytics.track("app.opened");
    expect(loader.clients.map((client) => client.optedOut)).toEqual([false, false]);
    expect(loader.clients[0]?.captured).toEqual([]);
    expect(loader.clients[1]?.captured.map((entry) => entry.event)).toEqual(["app.opened"]);
  });

  it("stays anonymous until an email is known, so one person is never split", async () => {
    const loader = fakeLoader();
    const analytics = createProductAnalytics(loader.load);
    analytics.configure(context(enabledConfig));
    analytics.identify(null);
    analytics.identify("user_2abc");
    analytics.track("app.opened");
    await flush();
    const [client] = loader.clients;
    expect(client?.identified).toEqual([]);
    expect(client?.captured.map((entry) => entry.event)).toEqual(["app.opened"]);
    analytics.identify("person@beknown.work");
    analytics.identify("PERSON@beknown.work");
    expect(client?.identified).toEqual(["person@beknown.work"]);
  });
});

describe("normalizeAnalyticsEmail", () => {
  it("trims and lower-cases emails and rejects anything else", () => {
    expect(normalizeAnalyticsEmail(" A@B.co ")).toBe("a@b.co");
    expect(normalizeAnalyticsEmail("user_2abc")).toBeNull();
    expect(normalizeAnalyticsEmail(null)).toBeNull();
  });
});
