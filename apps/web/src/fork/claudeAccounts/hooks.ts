/**
 * T3-CUSTOM(expbkt3): data hooks for the composer's Claude account picker.
 *
 * The account snapshot is one stream per environment. A server thread's
 * choice is seeded by `getThread` and then followed live. A draft has no
 * server thread yet, but its pre-allocated thread id is the id the first send
 * creates the thread with, so a pick is written straight away; if the server
 * refuses it for a thread it does not know yet, the pick is held here and
 * written again once the thread exists.
 */
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type {
  ClaudeAccountAccessList,
  ClaudeAccountMode,
  ClaudeAccountsSnapshot,
  EnvironmentId,
  ScopedThreadRef,
  ThreadClaudeAccount,
  UserId,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback, useEffect, useMemo, useState } from "react";
import { create } from "zustand";

import { useThreadShell } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { claudeAccountsEnvironment } from "./state";

interface LocalChoice {
  readonly mode: ClaudeAccountMode;
  /** The server's answer to the write, once it lands. */
  readonly result: ThreadClaudeAccount | null;
  readonly inFlight: boolean;
  /** False until a write for this mode has succeeded. */
  readonly synced: boolean;
  /** The server value when the pick was made; any newer frame supersedes the pick. */
  readonly serverAtPick: ThreadClaudeAccount | null;
}

interface ClaudeAccountsLocalState {
  readonly choices: Readonly<Record<string, LocalChoice>>;
  readonly put: (key: string, choice: LocalChoice) => void;
  /** Applies only while `mode` is still the latest pick for `key`. */
  readonly settle: (
    key: string,
    mode: ClaudeAccountMode,
    patch: Partial<LocalChoice> | "drop",
  ) => void;
}

const useClaudeAccountsLocalStore = create<ClaudeAccountsLocalState>((set) => ({
  choices: {},
  put: (key, choice) => set((state) => ({ choices: { ...state.choices, [key]: choice } })),
  settle: (key, mode, patch) =>
    set((state) => {
      const existing = state.choices[key];
      if (existing === undefined || existing.mode !== mode) return state;
      if (patch === "drop") {
        const { [key]: _dropped, ...rest } = state.choices;
        return { choices: rest };
      }
      return { choices: { ...state.choices, [key]: { ...existing, ...patch } } };
    }),
}));

/** Every account's limits on this environment, live while mounted. */
export function useClaudeAccountsSnapshot(
  environmentId: EnvironmentId | null,
): ClaudeAccountsSnapshot | null {
  const live = useEnvironmentQuery(
    environmentId === null
      ? null
      : claudeAccountsEnvironment.accounts({ environmentId, input: {} }),
  );
  return live.data;
}

type SnapshotResult = AsyncResult.AsyncResult<ClaudeAccountsSnapshot, unknown>;

const NO_SNAPSHOT_ATOM: Atom.Atom<SnapshotResult> = Atom.make<SnapshotResult>(
  AsyncResult.initial(false),
).pipe(Atom.withLabel("claude-accounts:none"));

/** Module-level, so the mapped atom `useAtomValue` builds stays stable. */
function snapshotEnabled(result: SnapshotResult): boolean {
  return Option.getOrNull(AsyncResult.value(result))?.enabled === true;
}

/**
 * Whether the server has the feature on, as a plain boolean: the host
 * component re-renders only when the answer flips, never on the snapshot
 * frames themselves. `null` opens no stream.
 */
export function useClaudeAccountsEnabled(environmentId: EnvironmentId | null): boolean {
  const atom: Atom.Atom<SnapshotResult> =
    environmentId === null
      ? NO_SNAPSHOT_ATOM
      : claudeAccountsEnvironment.accounts({ environmentId, input: {} });
  return useAtomValue(atom, snapshotEnabled);
}

/**
 * Writes a thread's account mode. `serverAtPick` is the server value the
 * picker showed, so the pick keeps showing until a newer frame arrives.
 * `reportFailure: false` (drafts) keeps a refused pick for a later retry;
 * otherwise a refusal is reported and the pick dropped.
 */
export function useSetThreadClaudeAccountMode() {
  const quiet = useAtomCommand(claudeAccountsEnvironment.setThreadMode, { reportFailure: false });
  const loud = useAtomCommand(claudeAccountsEnvironment.setThreadMode);
  return useCallback(
    async (input: {
      readonly threadRef: ScopedThreadRef;
      readonly mode: ClaudeAccountMode;
      readonly serverAtPick: ThreadClaudeAccount | null;
      readonly reportFailure: boolean;
    }) => {
      const key = scopedThreadKey(input.threadRef);
      useClaudeAccountsLocalStore.getState().put(key, {
        mode: input.mode,
        result: null,
        inFlight: true,
        synced: false,
        serverAtPick: input.serverAtPick,
      });
      const command = input.reportFailure ? loud : quiet;
      const result = await command({
        environmentId: input.threadRef.environmentId,
        input: { threadId: input.threadRef.threadId, mode: input.mode },
      });
      const { settle } = useClaudeAccountsLocalStore.getState();
      if (result._tag === "Success") {
        settle(key, input.mode, { inFlight: false, synced: true, result: result.value });
      } else if (input.reportFailure) {
        settle(key, input.mode, "drop");
      } else {
        settle(key, input.mode, { inFlight: false });
      }
    },
    [loud, quiet],
  );
}

export interface ThreadClaudeAccountState {
  /** Null until anything is known, which reads as Auto. */
  readonly account: ThreadClaudeAccount | null;
  readonly setMode: (mode: ClaudeAccountMode) => Promise<void>;
}

/** The thread's account choice and its setter. `enabled: false` mounts no streams. */
export function useThreadClaudeAccount(
  threadRef: ScopedThreadRef | null,
  enabled: boolean,
): ThreadClaudeAccountState {
  // A draft has no server row to read: its streams would fail "not-found" and
  // never retry. The shell appears once the first send creates the thread.
  const shell = useThreadShell(enabled ? threadRef : null);
  const target =
    enabled && threadRef !== null && shell !== null
      ? { environmentId: threadRef.environmentId, input: { threadId: threadRef.threadId } }
      : null;
  const initial = useEnvironmentQuery(
    target === null ? null : claudeAccountsEnvironment.thread(target),
  );
  const live = useEnvironmentQuery(
    target === null ? null : claudeAccountsEnvironment.threadSubscription(target),
  );
  const server = live.data ?? initial.data ?? null;
  const key = threadRef === null ? null : scopedThreadKey(threadRef);
  const local = useClaudeAccountsLocalStore((state) =>
    key === null ? undefined : state.choices[key],
  );
  const write = useSetThreadClaudeAccountMode();
  const isServerThread = target !== null;

  // A draft pick the server refused before the thread existed.
  useEffect(() => {
    if (!isServerThread || threadRef === null || local === undefined) return;
    if (local.synced || local.inFlight) return;
    void write({ threadRef, mode: local.mode, serverAtPick: server, reportFailure: true });
  }, [isServerThread, local, server, threadRef, write]);

  const setMode = useCallback(
    async (mode: ClaudeAccountMode) => {
      if (threadRef === null) return;
      await write({ threadRef, mode, serverAtPick: server, reportFailure: isServerThread });
    },
    [isServerThread, server, threadRef, write],
  );

  let account = server;
  if (
    threadRef !== null &&
    local !== undefined &&
    (local.inFlight || server === local.serverAtPick)
  ) {
    const base = local.result ?? server;
    account = { ...base, threadId: threadRef.threadId, mode: local.mode };
  }
  return { account, setMode };
}

export interface ClaudeAccountAccessState {
  /** Allow lists by account; an account missing here is open to everyone. Null while loading. */
  readonly usersByProfile: ReadonlyMap<string, ReadonlyArray<UserId>> | null;
  readonly error: string | null;
  /** Replaces one account's list; an empty list opens it to everyone. */
  readonly setUsers: (profile: string, userIds: ReadonlyArray<UserId>) => Promise<void>;
}

/** Who may use each Claude account, for the admin settings page. `null` opens nothing. */
export function useClaudeAccountAccess(
  environmentId: EnvironmentId | null,
): ClaudeAccountAccessState {
  const query = useEnvironmentQuery(
    environmentId === null ? null : claudeAccountsEnvironment.access({ environmentId, input: {} }),
  );
  const write = useAtomCommand(claudeAccountsEnvironment.setAccess);
  // A write answers with every list, which is newer than the last read.
  const [written, setWritten] = useState<{
    readonly at: number;
    readonly list: ClaudeAccountAccessList;
  } | null>(null);
  const { refresh } = query;
  const setUsers = useCallback(
    async (profile: string, userIds: ReadonlyArray<UserId>) => {
      if (environmentId === null) return;
      const result = await write({ environmentId, input: { profile, userIds } });
      if (result._tag === "Success") setWritten({ at: Date.now(), list: result.value });
      else refresh();
    },
    [environmentId, refresh, write],
  );
  const latest =
    written !== null && (query.dataUpdatedAt === null || written.at >= query.dataUpdatedAt)
      ? written.list
      : query.data;
  const entries = latest?.entries;
  const usersByProfile = useMemo(
    () =>
      entries === undefined
        ? null
        : new Map(entries.map((entry) => [entry.profile, entry.userIds] as const)),
    [entries],
  );
  return { usersByProfile, error: query.error, setUsers };
}
