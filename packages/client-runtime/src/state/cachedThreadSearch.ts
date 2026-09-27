/**
 * T3-CUSTOM(expbkt3): search the threads this device has cached.
 *
 * Thread search is a host query — it scans the whole message projection, which
 * only the host has. When the host is unreachable that returns nothing, and the
 * operator is left unable to find work they were doing minutes earlier.
 *
 * This is the honest subset: the threads whose history is already on this
 * device. It is not a substitute for the host's search and does not pretend to
 * be — it cannot see a thread that was never opened here, or messages older
 * than the cached window. What it does cover is the case that matters while a
 * host is down, which is finding the work you were just in.
 *
 * Matches carry the real role of the message they came from, so they render and
 * sort exactly like host results with no special-casing downstream.
 *
 * @module state/cachedThreadSearch
 */
import type { OrchestrationThread, OrchestrationThreadSearchMatch } from "@t3tools/contracts";

/** Mirrors the host's snippet cap, so a cached match cannot render differently. */
const SNIPPET_MAX_LENGTH = 240;
const SNIPPET_LEAD = 60;
/** Bounds the work and the result list; the host's own search is also capped. */
export const CACHED_THREAD_SEARCH_MATCH_LIMIT = 50;

export function cachedSearchSnippet(text: string, needle: string): string {
  const index = text.toLowerCase().indexOf(needle);
  if (index < 0) {
    return text.slice(0, SNIPPET_MAX_LENGTH);
  }
  const start = Math.max(0, index - SNIPPET_LEAD);
  const snippet = text.slice(start, start + SNIPPET_MAX_LENGTH);
  return start > 0 ? `…${snippet.slice(1)}` : snippet;
}

/**
 * One match per thread — the newest message that contains the query — so a long
 * conversation cannot crowd out every other result.
 */
export function searchCachedThreads(
  threads: ReadonlyArray<OrchestrationThread>,
  query: string,
  limit: number = CACHED_THREAD_SEARCH_MATCH_LIMIT,
): ReadonlyArray<OrchestrationThreadSearchMatch> {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) {
    return [];
  }

  const matches: Array<OrchestrationThreadSearchMatch> = [];
  for (const thread of threads) {
    for (let index = thread.messages.length - 1; index >= 0; index -= 1) {
      const message = thread.messages[index];
      if (message === undefined) continue;
      if (message.role !== "user" && message.role !== "assistant") continue;
      if (!message.text.toLowerCase().includes(needle)) continue;
      matches.push({
        threadId: thread.id,
        projectId: thread.projectId,
        source: message.role,
        snippet: cachedSearchSnippet(message.text, needle),
        messageCreatedAt: message.createdAt,
      });
      break;
    }
  }

  return matches
    .sort((left, right) =>
      (right.messageCreatedAt ?? "").localeCompare(left.messageCreatedAt ?? ""),
    )
    .slice(0, limit);
}
