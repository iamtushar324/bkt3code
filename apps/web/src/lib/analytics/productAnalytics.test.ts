import { describe, expect, it } from "vite-plus/test";

import {
  createProductAnalytics,
  type ProductAnalyticsClient,
  type ProductAnalyticsContext,
  type ProductAnalyticsLoader,
} from "./productAnalytics";

interface FakeClient {
  readonly key: string;
  readonly captured: Array<{ event: string; properties: unknown }>;
  readonly identified: string[];
  readonly registered: Array<Record<string, unknown>>;
  optedOut: boolean;
}

function fakeLoader() {
  const clients: FakeClient[] = [];
  let loads = 0;
  const load: ProductAnalyticsLoader = async (key) => {
    loads += 1;
    const fake: FakeClient = {
      key,
      captured: [],
      identified: [],
      registered: [],
      optedOut: false,
    };
    clients.push(fake);
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
      opt_out_capturing: () => {
        fake.optedOut = true;
      },
    } as unknown as ProductAnalyticsClient;
    return client;
  };
  return { load, clients, loadCount: () => loads };
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
    expect(loader.loadCount()).toBe(0);
    expect(analytics.isActive()).toBe(false);
  });

  it("is a no-op when the server marks analytics disabled", async () => {
    const loader = fakeLoader();
    const analytics = createProductAnalytics(loader.load);
    analytics.configure(context({ ...enabledConfig, enabled: false }));
    analytics.track("app.opened");
    await flush();
    expect(loader.loadCount()).toBe(0);
  });

  it("queues events until loaded, then sends sanitized properties", async () => {
    const loader = fakeLoader();
    const analytics = createProductAnalytics(loader.load);
    analytics.configure(context(enabledConfig));
    analytics.identify("person@beknown.work");
    analytics.track("composer.sent", { threadId: "t1", prompt: "do not send me" });
    await flush();
    const [client] = loader.clients;
    expect(client?.captured).toEqual([{ event: "composer.sent", properties: { threadId: "t1" } }]);
    expect(client?.identified).toEqual(["person@beknown.work"]);
    expect(client?.registered.at(-1)).toEqual({
      surface: "web",
      appVersion: "1.2.3",
      instance: "bkt3",
      connectionMode: "tailnet",
    });
  });

  it("retires the old client when the key changes and stops when disabled", async () => {
    const loader = fakeLoader();
    const analytics = createProductAnalytics(loader.load);
    analytics.configure(context(enabledConfig));
    await flush();
    analytics.configure(context({ ...enabledConfig, posthogKey: "phc_other" }));
    await flush();
    expect(loader.clients.map((client) => client.optedOut)).toEqual([true, false]);
    analytics.configure(context(null));
    analytics.track("app.opened");
    expect(loader.clients[1]?.optedOut).toBe(true);
    expect(loader.clients[1]?.captured).toEqual([]);
  });
});
