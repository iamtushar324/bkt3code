import { useAtomValue } from "@effect/atom-react";
import {
  type CheckpointDiffTarget,
  type ComposerPathSearchTarget,
} from "@t3tools/client-runtime/state/threads";
import {
  createThreadSearchResultsAtomFamily,
  makeThreadSearchKey,
  visibleThreadSearch,
  type EnvironmentThreadSearchMatch,
  type SettledThreadSearch,
  type ThreadSearchResultsState,
  type ThreadSearchScope,
} from "@t3tools/client-runtime/state/thread-search";
import { THREAD_SEARCH_QUERY_MAX_LENGTH } from "@t3tools/contracts";
import { messageSearchTokens } from "@t3tools/shared/paletteSearch";
import { type VcsRefTarget } from "@t3tools/client-runtime/state/vcs";
import type {
  EnvironmentId,
  OrchestrationV2GetTurnItemResult,
  ProjectContentMatch,
  ProjectEntry,
  ProjectEntryKind,
  ThreadId,
  TurnItemId,
  VcsListRefsInput, // T3-CUSTOM(expbkt3): exact remote-ref query input.
  VcsListRefsResult,
  VcsRef,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom } from "effect/reactivity";
import { useEffect, useState } from "react";

// T3-CUSTOM(expbkt3): BEGIN — search this device's cache for unreachable hosts.
import { searchCachedThreads } from "@t3tools/client-runtime/state/cached-thread-search";
import { readCachedThreadsForEnvironment } from "../connection/storage";
import { useEnvironments } from "./environments";
// T3-CUSTOM(expbkt3): END
import { appAtomRegistry } from "../rpc/atomRegistry";
import { useFilesystemReadAccess } from "./filesystem";
import { orchestrationEnvironment } from "./orchestration";
import { olderSettledThreads, threadFamilies } from "./threads";
import { isPaginatedBranchesNextPagePending } from "./paginatedBranches";
import { projectContentSearch, projectEnvironment } from "./projects";
import { useEnvironmentQuery } from "./query";
import { vcsEnvironment } from "./vcs";

const PROJECT_PATH_SEARCH_DEBOUNCE_MS = 120;
const COMPOSER_PATH_SEARCH_LIMIT = 80;
const PROJECT_CONTENT_SEARCH_DEBOUNCE_MS = 120;
const PROJECT_CONTENT_SEARCH_LIMIT = 500;
const THREAD_SEARCH_DEBOUNCE_MS = 120;
const VCS_REF_LIST_LIMIT = 100;
const EMPTY_REFS: ReadonlyArray<VcsRef> = [];
const EMPTY_PROJECT_ENTRIES: ReadonlyArray<ProjectEntry> = [];
const EMPTY_CONTENT_MATCHES: ReadonlyArray<ProjectContentMatch> = [];
const INITIAL_BRANCH_CURSORS = [undefined] as const;
const EMPTY_THREAD_SEARCH_MATCHES: ReadonlyArray<EnvironmentThreadSearchMatch> = Object.freeze([]);
const EMPTY_THREAD_SEARCH_ATOM = Atom.make<ThreadSearchResultsState>({
  matches: EMPTY_THREAD_SEARCH_MATCHES,
  isLoading: false,
  rows: [],
}).pipe(Atom.withLabel("web:thread-search:empty"));

const olderSettledBeforeAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) => get(olderSettledThreads.olderSettledAtom(environmentId))?.before ?? null).pipe(
    Atom.withLabel(`web:older-settled-before:${environmentId}`),
  ),
);
// Whether any of these environments leaves older settled threads out, so short queries matter.
const anyOlderSettledAtom = Atom.family((environmentIdsKey: string) =>
  Atom.make((get) =>
    (JSON.parse(environmentIdsKey) as ReadonlyArray<EnvironmentId>).some(
      (environmentId) => get(olderSettledBeforeAtom(environmentId)) !== null,
    ),
  ).pipe(Atom.withLabel(`web:any-older-settled:${environmentIdsKey}`)),
);
const threadSearch = createThreadSearchResultsAtomFamily({
  getSearchAtom: (environmentId, input) =>
    input.olderSettledBefore === undefined
      ? orchestrationEnvironment.threadSearch({ environmentId, input })
      : olderSettledThreads.searchAtom(environmentId, input),
  olderSettledBefore: olderSettledBeforeAtom,
  labelPrefix: "web:thread-search",
});

export function useDebouncedValue<A>(value: A, delayMs: number): A {
  const [debounced, setDebounced] = useState(value);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- debounce timer that publishes the value after delayMs
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
 * search right now. Reads IndexedDB rather than the atoms so it finds work after
 * a restart, and is bounded by what the cache holds.
 */
function useCachedThreadSearch(
  environmentIds: ReadonlyArray<EnvironmentId>,
  query: string,
): ReadonlyArray<EnvironmentThreadSearchMatch> {
  const [resolved, setResolved] = useState<{
    readonly requestKey: string;
    readonly matches: ReadonlyArray<EnvironmentThreadSearchMatch>;
  } | null>(null);
  // The key stands in for the array identity, which changes per render.
  const environmentKey = JSON.stringify(environmentIds);
  const requestKey = JSON.stringify([environmentKey, query]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads this device's IndexedDB thread cache for hosts that cannot answer the search
  useEffect(() => {
    const ids = JSON.parse(environmentKey) as ReadonlyArray<EnvironmentId>;
    if (ids.length === 0 || query.length === 0) return;
    let cancelled = false;
    void Promise.all(
      ids.map(async (environmentId) => {
        const snapshots = await readCachedThreadsForEnvironment(environmentId);
        return searchCachedThreads(
          snapshots.map((snapshot) => snapshot.projection),
          query,
        ).map((match) => ({ ...match, environmentId }));
      }),
    ).then((perEnvironment) => {
      if (cancelled) return;
      setResolved({
        requestKey: JSON.stringify([environmentKey, query]),
        matches: perEnvironment.flat(),
      });
    });
    return () => {
      cancelled = true;
    };
  }, [environmentKey, query]);

  // Matches resolved for an older request are never shown, so an empty request needs no reset.
  return resolved !== null && resolved.requestKey === requestKey
    ? resolved.matches
    : EMPTY_THREAD_SEARCH_MATCHES;
}
// T3-CUSTOM(expbkt3): END

/**
 * Server matches for a thread search: message hits, and on environments that leave older settled
 * threads out of the shell, the rows of the best older matches, mounted into the thread list while
 * they show so the caller's own ranking finds them.
 */
export function useThreadSearch(
  environmentIds: ReadonlyArray<EnvironmentId>,
  query: string,
  scope: ThreadSearchScope = {},
): {
  readonly matches: ReadonlyArray<EnvironmentThreadSearchMatch>;
  readonly query: string;
  readonly isPending: boolean;
} {
  // A pasted wall of text searches by its start rather than failing the request.
  const normalizedQuery = query.trim().slice(0, THREAD_SEARCH_QUERY_MAX_LENGTH).trim();
  const debouncedQuery = useDebouncedValue(normalizedQuery, THREAD_SEARCH_DEBOUNCE_MS);
  const anyOlderSettled = useAtomValue(anyOlderSettledAtom(JSON.stringify(environmentIds)));
  // Messages need a word of three or more letters; older settled titles match from two.
  const canSearch =
    environmentIds.length > 0 &&
    ((scope.titlesOnly !== true && messageSearchTokens(normalizedQuery).long.length > 0) ||
      (anyOlderSettled && normalizedQuery.length >= 2));
  const settledQuery = canSearch && normalizedQuery === debouncedQuery ? debouncedQuery : null;
  const searchKeyOf = (searchQuery: string) =>
    makeThreadSearchKey(environmentIds, searchQuery, scope);
  const searchKey = settledQuery === null ? null : searchKeyOf(settledQuery);
  const result = useAtomValue(
    searchKey === null ? EMPTY_THREAD_SEARCH_ATOM : threadSearch.results(searchKey),
  );
  const isPending = canSearch && (normalizedQuery !== debouncedQuery || result.isLoading);
  // T3-CUSTOM(expbkt3): the cached-search request waits out the debounce too.
  const isDebouncing = canSearch && normalizedQuery !== debouncedQuery;
  // T3-CUSTOM(expbkt3): BEGIN — cover the hosts that cannot answer. Their
  // results come from this device's cache, and are merged behind the live ones
  // so a reachable host's authoritative answer always leads.
  const { presentationById } = useEnvironments();
  const unreachableEnvironmentIds = environmentIds.filter((environmentId) => {
    const environment = presentationById.get(environmentId);
    // "connected" is the only phase whose host can answer a search; the
    // rest are some flavour of not-there, including a retry in progress.
    return environment !== undefined && environment.connection.phase !== "connected";
  });
  const cachedMatches = useCachedThreadSearch(
    unreachableEnvironmentIds,
    settledQuery === null || isDebouncing ? "" : settledQuery,
  );
  // T3-CUSTOM(expbkt3): END
  // What fast environments returned shows without waiting for a slow one;
  // callers keep shown rows in place with `nextShownOrder`.
  const ready =
    settledQuery !== null &&
    (!result.isLoading || result.matches.length > 0 || result.rows.length > 0)
      ? { query: settledQuery, matches: result.matches }
      : null;
  // Kept from earlier renders: React's pattern for information from previous renders.
  const [previous, setPrevious] = useState<SettledThreadSearch | null>(null);
  if (ready !== null && previous?.matches !== ready.matches) setPrevious(ready);
  const visible = canSearch
    ? visibleThreadSearch(normalizedQuery, ready, previous)
    : { query: "", matches: EMPTY_THREAD_SEARCH_MATCHES };
  // The shown results' rows stay mounted until newer results replace them.
  const shownKey = visible.query === "" ? null : searchKeyOf(visible.query);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- mounts the shown search results' rows into the thread family registry until newer results replace them
  useEffect(() => {
    if (shownKey === null) return;
    const environments = (JSON.parse(shownKey) as [ReadonlyArray<EnvironmentId>])[0];
    const releases = environments.map((environmentId) =>
      threadFamilies.mountRows(
        appAtomRegistry,
        environmentId,
        `search:${shownKey}`,
        threadSearch.rows(shownKey, environmentId),
      ),
    );
    return () => {
      for (const release of releases) release();
    };
  }, [shownKey]);
  return {
    // T3-CUSTOM(expbkt3): cached matches from unreachable hosts follow the live ones.
    matches:
      cachedMatches.length === 0 || visible.query !== (settledQuery ?? "")
        ? visible.matches
        : [...visible.matches, ...cachedMatches],
    query: visible.query,
    isPending,
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

function vcsRefPageAtom(targetKey: string, cursor: number | undefined) {
  const [environmentId, cwd, query] = JSON.parse(targetKey) as [EnvironmentId, string, string];
  return vcsEnvironment.listRefs({
    environmentId,
    input: {
      cwd,
      ...(query.length > 0 ? { query } : {}),
      ...(cursor === undefined ? {} : { cursor }),
      limit: VCS_REF_LIST_LIMIT,
    },
  });
}

const EMPTY_VCS_REF_PAGES_ATOM = Atom.make<
  ReadonlyArray<Atom.Type<ReturnType<typeof vcsRefPageAtom>>>
>([]).pipe(Atom.withLabel("web:vcs-ref-pages:empty"));

const vcsRefPagesAtom = Atom.family((pagesKey: string) => {
  const [targetKey, cursors] = JSON.parse(pagesKey) as [string, Array<number | null>];
  const pageAtoms = cursors.map((cursor) => vcsRefPageAtom(targetKey, cursor ?? undefined));
  return Atom.make((get) => pageAtoms.map((atom) => get(atom))).pipe(
    Atom.withLabel(`web:vcs-ref-pages:${pagesKey}`),
  );
});

export function usePaginatedBranches(target: VcsRefTarget) {
  // Leave unkeyed; mismatches already reset cursors, and a seeded key would break caching across the hook.
  const [pagination, setPagination] = useState<{
    readonly targetKey: string | null;
    readonly cursors: ReadonlyArray<number | undefined>;
  }>({
    targetKey: null,
    cursors: INITIAL_BRANCH_CURSORS,
  });
  const { environmentId, cwd } = target;
  const query = target.query?.trim() ?? "";
  const targetKey =
    environmentId !== null && cwd !== null ? JSON.stringify([environmentId, cwd, query]) : null;
  const cursors = pagination.targetKey === targetKey ? pagination.cursors : INITIAL_BRANCH_CURSORS;
  const pagesKey = targetKey === null ? null : JSON.stringify([targetKey, cursors]);
  const results = useAtomValue(
    pagesKey === null ? EMPTY_VCS_REF_PAGES_ATOM : vcsRefPagesAtom(pagesKey),
  );
  const values = results.flatMap((result) => {
    const value = AsyncResult.getOrElse(result, () => null);
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
  const refresh = () => {
    setPagination({ targetKey, cursors: INITIAL_BRANCH_CURSORS });
    if (targetKey !== null) {
      appAtomRegistry.refresh(vcsRefPageAtom(targetKey, undefined));
    }
  };
  const nextCursor = data?.nextCursor;
  const loadNext = () => {
    if (targetKey === null || nextCursor === null || nextCursor === undefined) {
      return;
    }
    setPagination((current) => {
      const currentCursors =
        current.targetKey === targetKey ? current.cursors : INITIAL_BRANCH_CURSORS;
      return currentCursors.includes(nextCursor)
        ? { targetKey, cursors: currentCursors }
        : { targetKey, cursors: [...currentCursors, nextCursor] };
    });
  };

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

function areProjectPathSearchTargetsEqual(
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
  const normalizedTarget = {
    environmentId: target.environmentId,
    cwd: target.cwd,
    query: target.query == null ? null : target.query.trim(),
    kind: target.kind,
    imageOnly: target.imageOnly,
  };
  const debouncedTarget = useDebouncedValue(normalizedTarget, PROJECT_PATH_SEARCH_DEBOUNCE_MS);
  const fileAccess = useFilesystemReadAccess(debouncedTarget.environmentId);
  const { canReadFiles } = fileAccess;
  const searchTarget =
    debouncedTarget.environmentId !== null &&
    debouncedTarget.cwd !== null &&
    debouncedTarget.query !== null &&
    (allowEmptyQuery || debouncedTarget.query.length > 0)
      ? {
          environmentId: debouncedTarget.environmentId,
          input: {
            cwd: debouncedTarget.cwd,
            query: debouncedTarget.query,
            limit,
            ...(debouncedTarget.kind ? { kind: debouncedTarget.kind } : {}),
            ...(debouncedTarget.imageOnly ? { imageOnly: true } : {}),
          },
        }
      : null;
  const result = useEnvironmentQuery(
    canReadFiles && searchTarget !== null ? projectEnvironment.searchEntries(searchTarget) : null,
  );
  const hasTarget = searchTarget !== null;

  return {
    entries: result.data?.entries ?? EMPTY_PROJECT_ENTRIES,
    error:
      !hasTarget || fileAccess.isPending
        ? null
        : canReadFiles
          ? result.error
          : (fileAccess.error ?? "This connection cannot search host files."),
    isPending:
      !areProjectPathSearchTargetsEqual(normalizedTarget, debouncedTarget) ||
      (hasTarget && (fileAccess.isPending || result.isPending)),
    searchedTarget: debouncedTarget,
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
  const hasTarget = target.environmentId !== null && target.cwd !== null;
  const fileAccess = useFilesystemReadAccess(target.environmentId);
  const canReadFiles = hasTarget && fileAccess.canReadFiles;
  const isCheckingAccess = hasTarget && fileAccess.isPending;
  // Preserve query whitespace; trim only to detect blank input.
  const query = target.query;
  const hasQuery = query.trim().length > 0;
  const debouncedQuery = useDebouncedValue(query, PROJECT_CONTENT_SEARCH_DEBOUNCE_MS);
  const result = useEnvironmentQuery(
    canReadFiles &&
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
    canReadFiles,
    isCheckingAccess,
    matches: result.data?.matches ?? EMPTY_CONTENT_MATCHES,
    error:
      !hasTarget || isCheckingAccess
        ? null
        : canReadFiles
          ? result.error
          : (fileAccess.error ?? "This connection cannot search host files."),
    isPending:
      isCheckingAccess ||
      (canReadFiles && hasQuery && (query !== debouncedQuery || result.isPending)),
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

/** Reads one item's detail from somewhere other than the environment, as the guest page does. */
export type TurnItemDetailSource = (input: {
  readonly threadId: ThreadId;
  readonly itemId: TurnItemId;
  readonly revision: string;
}) => Atom.Atom<AsyncResult.AsyncResult<OrchestrationV2GetTurnItemResult, unknown>>;

export function useTurnItemDetail(
  target: {
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
    readonly itemId: TurnItemId;
    readonly revision: string;
  } | null,
  source?: TurnItemDetailSource,
) {
  const input =
    target === null
      ? null
      : { threadId: target.threadId, itemId: target.itemId, revision: target.revision };
  return useEnvironmentQuery<OrchestrationV2GetTurnItemResult, unknown>(
    target === null || input === null
      ? null
      : source
        ? source(input)
        : orchestrationEnvironment.turnItem({ environmentId: target.environmentId, input }),
  );
}
