/**
 * T3-CUSTOM(expbkt3): client product analytics (TEC-1631).
 *
 * Call sites use `trackProductEvent(name, props)`: one line, no awaits, and a
 * no-op until the primary environment advertises an analytics config. Only
 * then is `posthog-js` loaded, by dynamic import, so the main bundle and
 * startup cost do not change while analytics is off.
 *
 * Only the primary environment's config is used. A client connected to
 * several servers never mixes keys: a new key retires the old client first.
 *
 * @module productAnalytics
 */
import type { ExecutionEnvironmentAnalytics } from "@t3tools/contracts";
import type { PostHog, PostHogConfig } from "posthog-js";

import {
  createKeyThrottle,
  isAnalyticsSettingKey,
  type ProductAnalyticsConnectionMode,
  type ProductAnalyticsEvent,
  type ProductAnalyticsSurface,
  sanitizeAnalyticsProperties,
  stripUrlProperties,
} from "./productAnalytics.logic";

export interface ProductAnalyticsContext {
  readonly config: ExecutionEnvironmentAnalytics | null;
  readonly surface: ProductAnalyticsSurface;
  readonly appVersion: string;
  readonly connectionMode: ProductAnalyticsConnectionMode | null;
}

/** The part of the PostHog client this module calls. */
export type ProductAnalyticsClient = Pick<
  PostHog,
  "capture" | "identify" | "register" | "opt_out_capturing"
>;

export type ProductAnalyticsLoader = (
  key: string,
  options: Partial<PostHogConfig>,
  name: string,
) => Promise<ProductAnalyticsClient>;

/** Events captured before `posthog-js` finishes loading. Older ones are dropped. */
const MAX_PENDING_EVENTS = 50;

interface ActiveSession {
  readonly key: string;
  client: ProductAnalyticsClient | null;
  closed: boolean;
  readonly pending: Array<{ event: string; properties: Record<string, unknown> }>;
}

const loadPostHog: ProductAnalyticsLoader = async (key, options, name) => {
  const { default: posthog } = await import("posthog-js");
  return posthog.init(key, options, name);
};

function postHogOptions(host: string): Partial<PostHogConfig> {
  return {
    api_host: host,
    autocapture: false,
    capture_pageview: false,
    capture_pageleave: false,
    disable_session_recording: true,
    persistence: "localStorage",
    person_profiles: "identified_only",
    // Named events only: no surveys, flags, heatmaps, vitals or remote scripts.
    disable_surveys: true,
    advanced_disable_flags: true,
    disable_web_experiments: true,
    disable_external_dependency_loading: true,
    enable_heatmaps: false,
    capture_performance: false,
    capture_exceptions: false,
    capture_dead_clicks: false,
    rageclick: false,
    before_send: (event) => ({
      ...event,
      properties: stripUrlProperties(event.properties),
      ...(event.$set === undefined ? {} : { $set: stripUrlProperties(event.$set) }),
      ...(event.$set_once === undefined ? {} : { $set_once: stripUrlProperties(event.$set_once) }),
    }),
  };
}

export function createProductAnalytics(load: ProductAnalyticsLoader = loadPostHog) {
  let session: ActiveSession | null = null;
  let superProperties: Record<string, string> = {};
  let distinctId: string | null = null;
  let identifiedAs: string | null = null;
  let sessionCount = 0;
  let lastInputWasKeyboard = false;

  const applyIdentity = (client: ProductAnalyticsClient) => {
    client.register(superProperties);
    if (distinctId !== null && identifiedAs !== distinctId) {
      client.identify(distinctId);
      identifiedAs = distinctId;
    }
  };

  const close = () => {
    if (session === null) return;
    session.closed = true;
    session.client?.opt_out_capturing();
    session = null;
    identifiedAs = null;
  };

  return {
    /** Apply the primary environment's config. `null` or disabled turns it off. */
    configure(context: ProductAnalyticsContext): void {
      const config = context.config?.enabled === true ? context.config : null;
      superProperties = {
        surface: context.surface,
        appVersion: context.appVersion,
        ...(config?.instance === undefined ? {} : { instance: config.instance }),
        ...(context.connectionMode === null ? {} : { connectionMode: context.connectionMode }),
      };
      if (config === null) {
        close();
        return;
      }
      if (session !== null && session.key === config.posthogKey) {
        if (session.client !== null) applyIdentity(session.client);
        return;
      }
      close();
      const next: ActiveSession = {
        key: config.posthogKey,
        client: null,
        closed: false,
        pending: [],
      };
      session = next;
      sessionCount += 1;
      void load(config.posthogKey, postHogOptions(config.posthogHost), `bkt3_${sessionCount}`)
        .then((client) => {
          if (next.closed) {
            client.opt_out_capturing();
            return;
          }
          next.client = client;
          applyIdentity(client);
          for (const { event, properties } of next.pending.splice(0)) {
            client.capture(event, properties);
          }
        })
        .catch(() => {
          // Analytics must never break the app; a failed load stays off.
          if (session === next) session = null;
        });
    },

    /** The user's work email, or the server user id when the email is unknown. */
    identify(id: string | null): void {
      distinctId = id;
      if (session?.client) applyIdentity(session.client);
    },

    track(event: ProductAnalyticsEvent, properties?: Readonly<Record<string, unknown>>): void {
      if (session === null) return;
      const clean = sanitizeAnalyticsProperties(event, properties);
      if (session.client !== null) {
        session.client.capture(event, clean);
        return;
      }
      if (session.pending.length >= MAX_PENDING_EVENTS) session.pending.shift();
      session.pending.push({ event, properties: clean });
    },

    isActive(): boolean {
      return session !== null;
    },

    noteInput(kind: "keyboard" | "pointer"): void {
      lastInputWasKeyboard = kind === "keyboard";
    },

    /** Whether the last user input before now was a key press. */
    lastInputWasKeyboard(): boolean {
      return lastInputWasKeyboard;
    },
  };
}

export type ProductAnalytics = ReturnType<typeof createProductAnalytics>;

export const productAnalytics: ProductAnalytics = createProductAnalytics();

/** One-line hook for call sites. A no-op while analytics is off. */
export function trackProductEvent(
  event: ProductAnalyticsEvent,
  properties?: Readonly<Record<string, unknown>>,
): void {
  productAnalytics.track(event, properties);
}

export function lastInputWasKeyboard(): boolean {
  return productAnalytics.lastInputWasKeyboard();
}

/** Drags and repeated writes of one setting count once per window. */
const SETTINGS_CHANGED_WINDOW_MS = 10_000;
const settingsChangedThrottle = createKeyThrottle(SETTINGS_CHANGED_WINDOW_MS);

/** `settings.changed` per key in a patch. Keys only, never values. */
export function trackSettingsChanged(keys: ReadonlyArray<string>): void {
  if (!productAnalytics.isActive()) return;
  for (const settingKey of keys) {
    if (isAnalyticsSettingKey(settingKey) && settingsChangedThrottle(settingKey)) {
      productAnalytics.track("settings.changed", { settingKey });
    }
  }
}
