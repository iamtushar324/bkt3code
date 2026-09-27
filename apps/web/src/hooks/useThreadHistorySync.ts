/**
 * T3-CUSTOM(expbkt3): deepen the open thread's cached history in the background.
 *
 * The thread the operator is looking at is the one they are most likely to hand
 * off, and its cache holds only the window that was loaded to render it. This
 * walks the existing pagination backwards while the host is reachable, so the
 * cached copy grows toward the whole conversation before it is ever needed.
 *
 * It rides the same request the "load earlier turns" control uses, which
 * already merges each page into the thread state and persists the merged
 * snapshot. Nothing polls: every merged page changes the page state, which
 * re-evaluates the policy, and a short spacing between pages keeps a long
 * backfill from monopolising the connection.
 *
 * @module hooks/useThreadHistorySync
 */
import type { ScopedThreadRef } from "@t3tools/contracts";
import { countUserTurns, shouldRequestOlderPage } from "@t3tools/client-runtime/historySync";
import { requestOlderThreadTurns } from "@t3tools/client-runtime/state/threads";
import * as Option from "effect/Option";
import { useEffect, useRef, useSyncExternalStore } from "react";

import { OFFLINE_HISTORY_SYNC_ENABLED } from "../experimentalFeatures";
import { useEnvironmentThread } from "../state/threads";

/** Breathing room between pages, so a backfill never starves live traffic. */
const HISTORY_SYNC_PAGE_SPACING_MS = 1_500;
/**
 * Quiet period after a thread becomes live (open, resume, reconnect): the user
 * is looking at the latest turns right then, and a snapshot resume that just
 * replaced the window should not immediately re-download ten older pages.
 */
const HISTORY_SYNC_SETTLE_MS = 10_000;

const subscribeVisibility = (onChange: () => void) => {
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
};
const documentVisible = () => document.visibilityState !== "hidden";

export function useThreadHistorySync(ref: ScopedThreadRef | null): void {
  const environmentId = ref?.environmentId ?? null;
  const threadId = ref?.threadId ?? null;
  const state = useEnvironmentThread(environmentId, threadId);

  const page = Option.getOrNull(state.page);
  const thread = Option.getOrNull(state.data);
  const status = state.status;
  const hasMore = page?.hasMore ?? false;
  const loadingOlder = page?.loadingOlder ?? false;
  const beforeCursor = page?.beforeCursor ?? null;
  const loadedUserTurns = countUserTurns(thread?.messages ?? []);
  const sessionStatus = thread?.session?.status;
  const sessionRunning = sessionStatus === "running" || sessionStatus === "starting";
  const visible = useSyncExternalStore(subscribeVisibility, documentVisible, () => true);
  // When the thread last became live; the first page waits out the settle period.
  const liveSince = useRef<number | null>(null);
  useEffect(() => {
    liveSince.current = status === "live" ? Date.now() : null;
  }, [status]);

  useEffect(() => {
    if (!OFFLINE_HISTORY_SYNC_ENABLED || environmentId === null || threadId === null) {
      return;
    }
    if (
      !shouldRequestOlderPage({
        status,
        page: beforeCursor === null ? null : { beforeCursor, hasMore, loadingOlder },
        loadedUserTurns,
        sessionRunning,
        documentVisible: visible,
      })
    ) {
      return;
    }
    const settleRemainingMs =
      liveSince.current === null ? 0 : liveSince.current + HISTORY_SYNC_SETTLE_MS - Date.now();
    const timer = setTimeout(
      () => {
        requestOlderThreadTurns(environmentId, threadId);
      },
      Math.max(HISTORY_SYNC_PAGE_SPACING_MS, settleRemainingMs),
    );
    return () => clearTimeout(timer);
  }, [
    environmentId,
    threadId,
    status,
    hasMore,
    loadingOlder,
    beforeCursor,
    loadedUserTurns,
    sessionRunning,
    visible,
  ]);
}
