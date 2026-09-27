import { useAtomValue } from "@effect/atom-react";
import {
  type CheckpointDiffTarget,
  type ComposerPathSearchTarget,
} from "@t3tools/client-runtime/state/threads";
import {
  createThreadSearchResultsAtomFamily,
  makeThreadSearchKey,
  type EnvironmentThreadSearchMatch,
} from "@t3tools/client-runtime/state/thread-search";
import { type VcsRefTarget } from "@t3tools/client-runtime/state/vcs";
import type {
  EnvironmentId,
  OrchestrationThread,
  ProjectContentMatch,
  ProjectEntryKind,
  VcsListRefsInput, // T3-CUSTOM(expbkt3): exact remote-ref query input.
  VcsListRefsResult,
  VcsRef,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback, useEffect, useMemo, useState } from "react";

// T3-CUSTOM(expbkt3): BEGIN — search this device's cache for unreachable hosts.
import { searchCachedThreads } from "@t3tools/client-runtime/state/cached-thread-search";
import { readCachedThreadsForEnvironment } from "../connection/storage";
import { useEnvironments } from "./environments";
// T3-CUSTOM(expbkt3): END
import { appAtomRegistry } from "../rpc/atomRegistry";
import { orchestrationEnvironment } from "./orchestration";
import { isPaginatedBranchesNextPagePending } from "./paginatedBranches";
import { projectContentSearch, projectEnvironment } from "./projects";
import { useEnvironmentQuery } from "./query";
import { vcsEnvironment } from "./vcs";

const PROJECT_PATH_SEARCH_DEBOUNCE_MS = 120;
const COMPOSER_PATH_SEARCH_LIMIT = 80;
const PROJECT_CONTENT_SEARCH_DEBOUNCE_MS = 120;
const PROJECT_CONTENT_SEARCH_LIMIT = 500;
const THREAD_SEARCH_DEBOUNCE_MS = 200;
const VCS_REF_LIST_LIMIT = 100;
const EMPTY_REFS: ReadonlyArray<VcsRef> = [];
const EMPTY_CONTENT_MATCHES: ReadonlyArray<ProjectContentMatch> = [];
const INITIAL_BRANCH_CURSORS = [undefined] as const;
const EMPTY_THREAD_SEARCH_MATCHES: ReadonlyArray<EnvironmentThreadSearchMatch> = Object.freeze([]);
const EMPTY_THREAD_SEARCH_ATOM = Atom.make({
  matches: EMPTY_THREAD_SEARCH_MATCHES,
  isLoading: false,
}).pipe(Atom.withLabel("web:thread-search:empty"));

const threadSearchResultsAtom = createThreadSearchResultsAtomFamily({
  getSearchAtom: (environmentId, query) =>
    orchestrationEnvironment.threadSearch({
      environmentId,
      input: { query },
    }),
  labelPrefix: "web:thread-search",
});

export interface ThreadDetailView {
  readonly data: OrchestrationThread | null;
  readonly error: string | null;
  readonly isPending: boolean;
  readonly isDeleted: boolean;
}

/** Shared with the pull requests page, which debounces its search the same way. */
export function useDebouncedValue<A>(value: A, delayMs: number): A {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebounced(value);
    }, delayMs);
    return () => {
      window.clearTimeout(timer);
    };
  }, [delayMs, value]);

  return debounced;
}

// T3-CUSTOM(expbkt3): BEGIN — offline search over this device's thread cache.
/**
 * Matches from this device's cache, for environments whose host cannot answer a
 * search right now.
 *
 * Read from IndexedDB rather than from the atoms, because the point is to find
 * work after a restart — when nothing has been opened yet this session. Bounded
 * by what the cache holds, and stated as such at the call site.
 */
function useCachedThreadSearch(
  environmentIds: ReadonlyArray<EnvironmentId>,
  query: string,
): ReadonlyArray<EnvironmentThreadSearchMatch> {
  const [matches, setMatches] = useState<ReadonlyArray<EnvironmentThreadSearchMatch>>(
    EMPTY_THREAD_SEARCH_MATCHES,
  );
  const environmentKey = environmentIds.join(",");

  useEffect(() => {
    if (environmentIds.length === 0 || query.length === 0) {
      setMatches(EMPTY_THREAD_SEARCH_MATCHES);
      return;
    }
    let cancelled = false;
    void Promise.all(
      environmentIds.map(async (environmentId) => {
        const snapshots = await readCachedThreadsForEnvironment(environmentId);
        return searchCachedThreads(
          snapshots.map((snapshot) => snapshot.thread),
          query,
        ).map((match) => ({ ...match, environmentId }));
      }),
    ).then((perEnvironment) => {
      if (cancelled) return;
      setMatches(perEnvironment.flat());
    });
    return () => {
      cancelled = true;
    };
    // environmentKey stands in for the array identity, which changes per render.
  }, [environmentKey, query]);

  return matches;
}
// T3-CUSTOM(expbkt3): END

export function useThreadSearch(
  environmentIds: ReadonlyArray<EnvironmentId>,
  query: string,
): {
  readonly matches: ReadonlyArray<EnvironmentThreadSearchMatch>;
  readonly isPending: boolean;
} {
  const normalizedQuery = query.trim();
  const debouncedQuery = useDebouncedValue(normalizedQuery, THREAD_SEARCH_DEBOUNCE_MS);
  const canSearch = environmentIds.length > 0 && normalizedQuery.length >= 2;
  const settledQuery = canSearch && normalizedQuery === debouncedQuery ? debouncedQuery : null;
  const searchKey = useMemo(
    () => (settledQuery === null ? null : makeThreadSearchKey(environmentIds, settledQuery)),
    [environmentIds, settledQuery],
  );
  const result = useAtomValue(
    searchKey === null ? EMPTY_THREAD_SEARCH_ATOM : threadSearchResultsAtom(searchKey),
  );
  const isDebouncing = canSearch && normalizedQuery !== debouncedQuery;
  // T3-CUSTOM(expbkt3): BEGIN — cover the hosts that cannot answer. Their
  // results come from this device's cache, and are merged behind the live ones
  // so a reachable host's authoritative answer always leads.
  const { presentationById } = useEnvironments();
  const unreachableEnvironmentIds = useMemo(
    () =>
      environmentIds.filter((environmentId) => {
        const environment = presentationById.get(environmentId);
        // "connected" is the only phase whose host can answer a search; the
        // rest are some flavour of not-there, including a retry in progress.
        return environment !== undefined && environment.connection.phase !== "connected";
      }),
    [environmentIds, presentationById],
  );
  const cachedMatches = useCachedThreadSearch(
    unreachableEnvironmentIds,
    settledQuery === null || isDebouncing ? "" : settledQuery,
  );
  // T3-CUSTOM(expbkt3): END
  return {
    matches: isDebouncing
      ? EMPTY_THREAD_SEARCH_MATCHES
      : cachedMatches.length === 0
        ? result.matches
        : [...result.matches, ...cachedMatches],
    isPending: canSearch && (isDebouncing || result.isLoading),
  };
}

// T3-CUSTOM(expbkt3): BEGIN — optionally retain matching remote refs.
export type BranchQueryTarget = VcsRefTarget & {
  readonly includeMatchingRemoteRefs?: boolean;
};

// T3-CUSTOM(expbkt3): Exact worktree-base pickers can request the remote
// counterpart of a local branch instead of receiving the deduplicated list.
export function buildBranchesListInput(target: BranchQueryTarget): VcsListRefsInput | null {
  const query = target.query?.trim() ?? "";
  if (target.cwd === null) return null;
  return {
    cwd: target.cwd,
    ...(query.length > 0 ? { query } : {}),
    ...(target.includeMatchingRemoteRefs === undefined
      ? {}
      : { includeMatchingRemoteRefs: target.includeMatchingRemoteRefs }),
    limit: VCS_REF_LIST_LIMIT,
  };
}

export function useBranches(target: BranchQueryTarget) {
  const input = buildBranchesListInput(target);
  return useEnvironmentQuery(
    target.environmentId !== null && input !== null
      ? vcsEnvironment.listRefs({
          environmentId: target.environmentId,
          input,
        })
      : null,
  );
}
// T3-CUSTOM(expbkt3): END

export function usePaginatedBranches(target: VcsRefTarget) {
  const query = target.query?.trim() ?? "";
  const targetKey =
    target.environmentId !== null && target.cwd !== null
      ? JSON.stringify([target.environmentId, target.cwd, query])
      : null;
  const [pagination, setPagination] = useState<{
    readonly targetKey: string | null;
    readonly cursors: ReadonlyArray<number | undefined>;
  }>({
    targetKey,
    cursors: INITIAL_BRANCH_CURSORS,
  });
  const cursors = pagination.targetKey === targetKey ? pagination.cursors : INITIAL_BRANCH_CURSORS;
  const pageAtoms = useMemo(
    () =>
      target.environmentId !== null && target.cwd !== null
        ? cursors.map((cursor) =>
            vcsEnvironment.listRefs({
              environmentId: target.environmentId!,
              input: {
                cwd: target.cwd!,
                ...(query.length > 0 ? { query } : {}),
                ...(cursor === undefined ? {} : { cursor }),
                limit: VCS_REF_LIST_LIMIT,
              },
            }),
          )
        : [],
    [cursors, query, target.cwd, target.environmentId],
  );
  const pagesAtom = useMemo(
    () =>
      Atom.make((get) => pageAtoms.map((atom) => get(atom))).pipe(
        Atom.withLabel(`web:vcs-ref-pages:${targetKey ?? "empty"}`),
      ),
    [pageAtoms, targetKey],
  );
  const results = useAtomValue(pagesAtom);
  const values = results.flatMap((result) => {
    const value = Option.getOrNull(AsyncResult.value(result));
    return value === null ? [] : [value];
  });
  const refs = new Map<string, VcsRef>();
  for (const value of values) {
    for (const ref of value.refs) {
      refs.set(ref.name, ref);
    }
  }
  const first = values[0] ?? null;
  const last = values.at(-1) ?? null;
  const data: VcsListRefsResult | null =
    first === null || last === null
      ? null
      : {
          refs: [...refs.values()],
          isRepo: first.isRepo,
          hasPrimaryRemote: first.hasPrimaryRemote,
          nextCursor: last.nextCursor,
          totalCount: Math.max(...values.map((value) => value.totalCount)),
        };
  const failed = results.find((result) => result._tag === "Failure");
  const isFetchingNextPage = isPaginatedBranchesNextPagePending(results);
  const error =
    failed?._tag === "Failure"
      ? (() => {
          const cause = Cause.squash(failed.cause);
          return cause instanceof Error && cause.message.trim().length > 0
            ? cause.message
            : "Failed to load refs.";
        })()
      : null;
  const refresh = useCallback(() => {
    const firstPage = pageAtoms[0];
    setPagination({ targetKey, cursors: INITIAL_BRANCH_CURSORS });
    if (firstPage !== undefined) {
      appAtomRegistry.refresh(firstPage);
    }
  }, [pageAtoms, targetKey]);
  const loadNext = useCallback(() => {
    if (targetKey === null || data?.nextCursor === null || data?.nextCursor === undefined) {
      return;
    }
    setPagination((current) => {
      const currentCursors =
        current.targetKey === targetKey ? current.cursors : INITIAL_BRANCH_CURSORS;
      return currentCursors.includes(data.nextCursor!)
        ? { targetKey, cursors: currentCursors }
        : { targetKey, cursors: [...currentCursors, data.nextCursor!] };
    });
  }, [data?.nextCursor, targetKey]);

  return {
    data,
    refs: data?.refs ?? EMPTY_REFS,
    error,
    isPending: results.some((result) => result.waiting),
    isFetchingNextPage,
    refresh,
    loadNext,
  };
}

type ProjectPathSearchTarget = ComposerPathSearchTarget & {
  readonly kind?: ProjectEntryKind | undefined;
  readonly imageOnly?: boolean | undefined;
};

export function areProjectPathSearchTargetsEqual(
  left: ProjectPathSearchTarget,
  right: ProjectPathSearchTarget,
): boolean {
  return (
    left.environmentId === right.environmentId &&
    left.cwd === right.cwd &&
    left.query === right.query &&
    left.kind === right.kind &&
    left.imageOnly === right.imageOnly
  );
}

export function useProjectPathSearch(
  target: ProjectPathSearchTarget,
  limit: number,
  options?: { readonly allowEmptyQuery?: boolean },
) {
  const allowEmptyQuery = options?.allowEmptyQuery === true;
  const normalizedTarget = useMemo(
    () => ({
      environmentId: target.environmentId,
      cwd: target.cwd,
      query: target.query == null ? null : target.query.trim(),
      kind: target.kind,
      imageOnly: target.imageOnly,
    }),
    [target.cwd, target.environmentId, target.imageOnly, target.kind, target.query],
  );
  const debouncedTarget = useDebouncedValue(normalizedTarget, PROJECT_PATH_SEARCH_DEBOUNCE_MS);
  const result = useEnvironmentQuery(
    debouncedTarget.environmentId !== null &&
      debouncedTarget.cwd !== null &&
      debouncedTarget.query !== null &&
      (allowEmptyQuery || debouncedTarget.query.length > 0)
      ? projectEnvironment.searchEntries({
          environmentId: debouncedTarget.environmentId,
          input: {
            cwd: debouncedTarget.cwd,
            query: debouncedTarget.query,
            limit,
            ...(debouncedTarget.kind ? { kind: debouncedTarget.kind } : {}),
            ...(debouncedTarget.imageOnly ? { imageOnly: true } : {}),
          },
        })
      : null,
  );

  return {
    entries: result.data?.entries ?? [],
    error: result.error,
    isPending:
      !areProjectPathSearchTargetsEqual(normalizedTarget, debouncedTarget) || result.isPending,
    searchedQuery: debouncedTarget.query ?? "",
    truncated: result.data?.truncated ?? false,
    refresh: result.refresh,
  };
}

export function useComposerPathSearch(target: ComposerPathSearchTarget) {
  return useProjectPathSearch(target, COMPOSER_PATH_SEARCH_LIMIT);
}

interface ProjectContentSearchTarget {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
  readonly query: string;
  readonly caseSensitive: boolean;
  readonly wholeWord: boolean;
  readonly useRegex: boolean;
}

export function useProjectContentSearch(target: ProjectContentSearchTarget) {
  // Whitespace is significant in content queries; trimming is only used to
  // decide whether the input is blank.
  const query = target.query;
  const hasQuery = query.trim().length > 0;
  const debouncedQuery = useDebouncedValue(query, PROJECT_CONTENT_SEARCH_DEBOUNCE_MS);
  const result = useEnvironmentQuery(
    target.environmentId !== null &&
      target.cwd !== null &&
      hasQuery &&
      debouncedQuery.trim().length > 0
      ? projectContentSearch({
          environmentId: target.environmentId,
          input: {
            cwd: target.cwd,
            query: debouncedQuery,
            limit: PROJECT_CONTENT_SEARCH_LIMIT,
            caseSensitive: target.caseSensitive,
            wholeWord: target.wholeWord,
            useRegex: target.useRegex,
          },
        })
      : null,
  );

  return {
    matches: result.data?.matches ?? EMPTY_CONTENT_MATCHES,
    error: result.error,
    isPending: hasQuery && (query !== debouncedQuery || result.isPending),
    hasQuery,
    truncated: result.data?.truncated ?? false,
    invalidRegex: target.useRegex && result.data?.regexFallbackError !== undefined,
  };
}

export function useCheckpointDiff(
  target: CheckpointDiffTarget,
  options?: { readonly enabled?: boolean },
) {
  const enabled =
    options?.enabled !== false &&
    target.environmentId !== null &&
    target.threadId !== null &&
    target.fromTurnCount !== null &&
    target.toTurnCount !== null;
  const fullThreadTarget =
    enabled && target.fromTurnCount === 0
      ? {
          environmentId: target.environmentId!,
          input: {
            threadId: target.threadId!,
            toTurnCount: target.toTurnCount!,
            ignoreWhitespace: target.ignoreWhitespace,
          },
        }
      : null;
  const turnTarget =
    enabled && target.fromTurnCount !== 0
      ? {
          environmentId: target.environmentId!,
          input: {
            threadId: target.threadId!,
            fromTurnCount: target.fromTurnCount!,
            toTurnCount: target.toTurnCount!,
            ignoreWhitespace: target.ignoreWhitespace,
          },
        }
      : null;
  const fullThread = useEnvironmentQuery(
    fullThreadTarget === null ? null : orchestrationEnvironment.fullThreadDiff(fullThreadTarget),
  );
  const turn = useEnvironmentQuery(
    turnTarget === null ? null : orchestrationEnvironment.turnDiff(turnTarget),
  );
  return fullThreadTarget === null ? turn : fullThread;
}
