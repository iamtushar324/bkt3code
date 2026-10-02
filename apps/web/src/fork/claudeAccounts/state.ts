/**
 * T3-CUSTOM(expbkt3): Claude account atoms bound to the web connection.
 *
 * Built here from the client runtime's exported RPC helpers rather than in
 * `packages/client-runtime`, since only the web composer and the Claude
 * account access settings read them. Mode writes are serialised per thread so
 * the last pick is the one that sticks.
 */
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../../connection/runtime";

const scheduler = createAtomCommandScheduler();

export const claudeAccountsEnvironment = {
  /** Every account's limits; the server pushes a frame every ~15 s and on rate-limit events. */
  accounts: createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
    label: "environment-data:claude-accounts:subscribe",
    tag: WS_METHODS.subscribeClaudeAccounts,
    idleTtlMs: 5_000,
  }),
  thread: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "environment-data:claude-accounts:thread",
    tag: WS_METHODS.claudeAccountsGetThread,
    idleTtlMs: 5_000,
  }),
  threadSubscription: createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
    label: "environment-data:claude-accounts:thread-subscribe",
    tag: WS_METHODS.subscribeThreadClaudeAccount,
    idleTtlMs: 5_000,
  }),
  setThreadMode: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:claude-accounts:set-thread-mode",
    tag: WS_METHODS.claudeAccountsSetThreadMode,
    scheduler,
    concurrency: {
      mode: "serial",
      key: ({ environmentId, input }) => `${environmentId}:${input.threadId}`,
    },
  }),
  /** Every account's allow list (admins only). */
  access: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "environment-data:claude-accounts:access",
    tag: WS_METHODS.claudeAccountsAccessList,
    idleTtlMs: 5_000,
  }),
  /** Each write carries the account's whole list, so the last one per account wins. */
  setAccess: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:claude-accounts:set-access",
    tag: WS_METHODS.claudeAccountsAccessSet,
    scheduler,
    concurrency: {
      mode: "serial",
      key: ({ environmentId, input }) => `${environmentId}:access:${input.profile}`,
    },
  }),
};
