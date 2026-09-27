# Execution Reliability

> For maintainers. Using T3 Code? See [Recovering interrupted work](../user/execution-recovery.md).

T3 Code treats every accepted `thread.turn.start` as a durable execution intent. The intent says
what the user wants; the provider session says what is currently observed. Keeping those two facts
separate prevents a missing process from making accepted work disappear and prevents a stale
spinner from claiming that a provider is still running.

## Commit Boundary

A successful command acknowledgement covers one SQLite transaction containing:

- the user message and exact attachments;
- the `thread.turn-start-requested` event and command receipt;
- the execution intent, including model/runtime/interaction options and acting user;
- new-thread bootstrap instructions, when present.

The intent is keyed by the original command ID. Repeating that ID returns the existing receipt and
cannot create a second message or work item. Projection failure aborts the transaction, so the
server never acknowledges an intent it cannot recover.

## Desired and Observed State

`projection_thread_execution_intents` is the control-plane source of truth. `desired_state` records
whether work should run, while `phase` records the durable lifecycle. Provider events update the
same intent and the public `ThreadExecutionSnapshot`.

The client derives presentation from the durable intent plus its local outbox:

| Source                            | Presentation                   |
| --------------------------------- | ------------------------------ |
| local outbox only                 | Sending                        |
| accepted intent, no provider turn | Queued, Preparing, or Starting |
| provider evidence                 | Running or Waiting             |
| desired running, provider absent  | Recovering or Retrying         |
| retry budget exhausted            | Recovery failed                |

Older servers omit `intent`; clients retain the legacy session-derived presentation in that case.

## Coordinator

`DurableExecutionCoordinator` is the only owner of normal turn delivery and recovery. Committed
events, startup reconciliation, provider exits, and due timers all call the same idempotent
`run(workItemId)` path.

Claims use a generation-fenced 60-second lease renewed every 15 seconds. The coordinator verifies
the generation immediately before provider or bootstrap side effects. A stop, interrupt, archive,
or delete increments the generation and therefore wins any race with an older worker. One claim may
run per thread and no more than two claims run globally.

Recovery attempts use deterministic jitter around this schedule:

```text
immediate, 1s, 2s, 5s, 10s, 30s, 1m, 2m, 5m, 10m
```

The original delivery is not an attempt. Attempt 10 either produces matching provider-turn evidence
or moves the item to `recovery-exhausted`, sets desired state to stopped, and leaves an attention
item. Retry starts a fresh generation and budget. Dismiss retains the audit trail but clears the
attention item.

## Guarded Recovery

Only work proven never delivered may reuse the exact original payload. If delivery might have
started, the coordinator first inspects the provider session. It adopts a matching active turn,
reconciles known completion, or sends a synthetic continuation through a provider that declares
durable resume support. The continuation instructs the agent to inspect persisted conversation and
workspace state before acting. It never blindly repeats the original prompt.

Pending approvals and structured input are user boundaries. Native callback state is not assumed to
survive a restart and T3 Code never approves or answers them automatically.

## Durable Bootstrap

Bootstrap thread creation is part of the initial event transaction. Worktree creation and setup
launch happen after commit. `thread_execution_bootstrap_operations` records each external step as
pending, running, or acknowledged.

Worktrees use a deterministic path and branch and are inspected before creation. Setup uses a stable
terminal ID. If a crash leaves setup launch uncertain and no durable activity proves the launch,
the item requires attention instead of running the script twice. Partial threads remain visible.

## Client Outbox

The shared client runtime persists an outbound message before network dispatch. Entries are
namespaced by environment and authenticated identity and retain command/message IDs, attachments,
settings, and bootstrap data. Connection loss resends the same command ID. Only an accepted receipt
removes the entry; deterministic rejection leaves it locally failed and editable.

Web and desktop use IndexedDB. Mobile uses its platform persistence implementation. Clearing an
environment clears its namespace; logging out does not transfer or deliver one identity's work as
another identity.

## Compatibility

The environment capability `durableExecutionRecovery` gates client behavior. Migration 1003 mirrors
desired state into `session_recovery_state` for one rollback-safe release. The legacy sweep remains
disabled while the durable coordinator owns execution. Migration 1001 and its table remain
immutable after the mirror is removed.

## Tests

Reliability tests should wait on committed events, provider acknowledgements, and worker drains—not
sleep. Cover command idempotency, transaction rollback, claim fencing, every provider's declared
resume behavior, exact retry exhaustion, bootstrap uncertainty, and client reload/offline/account
boundaries.
