/**
 * T3-CUSTOM(expbkt3): wires client product analytics to app state (TEC-1631).
 *
 * Mounted once under the router. It hands the primary environment's analytics
 * config to the service and, only while that is on, mounts the trackers for
 * identity, views, opened threads and app visibility. With analytics off it
 * renders nothing and subscribes to nothing beyond the primary environment.
 *
 * @module ProductAnalyticsCoordinator
 */
import { useParams, useRouterState } from "@tanstack/react-router";
import { useEffect, useMemo, useRef } from "react";

import { APP_VERSION } from "../../branding";
import { isElectron } from "../../env";
import { usePrimaryEnvironment } from "../../state/environments";
import { useCurrentUserId } from "../../state/identity";
import { useOrgMembers } from "../../state/orgMembers";
import { productAnalytics, trackProductEvent } from "./productAnalytics";
import {
  createVisibilityReporter,
  resolveConnectionMode,
  viewNameFromRouteId,
} from "./productAnalytics.logic";

/** A visibility change must hold this long before it is reported. */
const VISIBILITY_SETTLE_MS = 5_000;

let appOpenedSent = false;

export function ProductAnalyticsCoordinator() {
  const primary = usePrimaryEnvironment();
  const analytics = primary?.serverConfig?.environment.analytics ?? null;
  const target = primary?.entry.target ?? null;
  const key = analytics !== null && analytics.enabled ? analytics.posthogKey : null;
  const host = analytics !== null && analytics.enabled ? analytics.posthogHost : null;
  const instance = analytics?.instance ?? null;
  const connectionMode = useMemo(() => resolveConnectionMode(target), [target]);

  useEffect(() => {
    productAnalytics.configure({
      config:
        key === null || host === null
          ? null
          : {
              enabled: true,
              posthogKey: key,
              posthogHost: host,
              ...(instance === null ? {} : { instance }),
            },
      surface: isElectron ? "desktop" : "web",
      appVersion: APP_VERSION,
      connectionMode,
    });
    if (key !== null && !appOpenedSent) {
      appOpenedSent = true;
      trackProductEvent("app.opened");
    }
  }, [key, host, instance, connectionMode]);

  if (key === null) return null;
  return (
    <>
      <ProductAnalyticsIdentity />
      <ProductAnalyticsRouteTracker />
      <ProductAnalyticsActivityTracker />
    </>
  );
}

/** Identifies by work email; falls back to the server user id when it is unknown. */
function ProductAnalyticsIdentity() {
  const userId = useCurrentUserId();
  const { resolveUser } = useOrgMembers();
  const email = userId === null ? null : resolveUser(userId).email;
  const distinctId = email ?? userId;
  useEffect(() => {
    productAnalytics.identify(distinctId);
  }, [distinctId]);
  return null;
}

function ProductAnalyticsRouteTracker() {
  const routeId = useRouterState({ select: (state) => state.matches.at(-1)?.routeId ?? null });
  const { threadId: routeThreadId } = useParams({ strict: false });
  const threadId = typeof routeThreadId === "string" ? routeThreadId : null;
  const view = viewNameFromRouteId(routeId);
  const lastThreadId = useRef<string | null>(null);

  useEffect(() => {
    if (view !== null) trackProductEvent("view.changed", { view });
  }, [view]);

  useEffect(() => {
    if (threadId === null || threadId === lastThreadId.current) return;
    lastThreadId.current = threadId;
    trackProductEvent("session.opened", { threadId });
  }, [threadId]);
  return null;
}

/** App visibility (settled, so window peeks send nothing) and last input kind. */
function ProductAnalyticsActivityTracker() {
  useEffect(() => {
    const reporter = createVisibilityReporter({
      delayMs: VISIBILITY_SETTLE_MS,
      emit: (state) =>
        trackProductEvent(state === "foreground" ? "app.foregrounded" : "app.backgrounded"),
    });
    const onVisibility = () =>
      reporter.update(document.visibilityState === "hidden" ? "background" : "foreground");
    const onKeyDown = () => productAnalytics.noteInput("keyboard");
    const onPointerDown = () => productAnalytics.noteInput("pointer");
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("keydown", onKeyDown, { capture: true, passive: true });
    window.addEventListener("pointerdown", onPointerDown, { capture: true, passive: true });
    return () => {
      reporter.dispose();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("keydown", onKeyDown, { capture: true });
      window.removeEventListener("pointerdown", onPointerDown, { capture: true });
    };
  }, []);
  return null;
}
