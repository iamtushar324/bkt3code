# Durable thread bootstrap

Thread bootstrap is the high-level, durable path for creating a thread, preparing its workspace,
and optionally dispatching its first turn. It keeps strict `thread.create` deterministic while
giving web, HTTP, WebSocket, and MCP callers one defaults and readiness boundary.

## Resolution and persistence

`ThreadCreationDefaultsResolver` resolves every defaulted field independently:

```text
explicit request override → project override → target environment app setting
```

On servers advertising `durableExecutionRecovery`, an initial prompt travels as a
`thread.turn.start` with an embedded bootstrap request. The client outbox persists that request and
the exact prompt together. The server resolves defaults and commits thread creation, message,
resolved request, execution intent, and command receipt in one transaction. New-worktree requests
receive a desired branch and expected managed worktree path before filesystem work begins. Origin
refs are fetched and resolved to a commit SHA only after that commit; unavailable refs fail visibly.

The execution intent retains the resolved request needed for recovery. Workspace-only and
version-skew `thread.bootstrap.request` operations retain their public lifecycle in
`projection_thread_bootstraps`. Public snapshots expose only output-free progress. Pending prompt
content remains in the internal request and terminal bytes remain in capped, redacted terminal
history.

## Coordinator lifecycle

For a durable execution turn, `DurableExecutionCoordinator` claims the accepted intent and runs
workspace/setup preparation before provider delivery. The legacy workspace-only bootstrap
coordinator persists `thread.bootstrap-requested`, returns to the caller, then runs three phases in
a detached server fiber:

1. Create or adopt the requested workspace.
2. Run the selected project setup action in a one-shot interactive PTY when this operation created
   a new worktree.
3. Dispatch the first turn with a deterministic command ID after setup succeeds or is bypassed.

Local directories and supplied existing worktrees skip setup. A request without an initial prompt
completes after workspace readiness. A non-zero exit, signal, launch failure, or user stop records a
typed setup failure with terminal ID and never dispatches the pending turn.

Retry reads the project's current setup action, so editing a broken command takes effect without
recreating the thread. Each attempt gets a distinct deterministic terminal ID and prior history is
retained. Continue is accepted only after successful worktree creation and failed setup. Worktree
failures cannot be bypassed.

## Recovery invariants

Browser and transport disconnects do not own the coordinator fiber. At server startup, recovery is
queued behind the existing command-readiness gate and does not wait for interactive setup to end.

- A setup recorded as running becomes an interrupted failure; it is never silently rerun.
- A completed worktree phase is reused.
- A worktree whose creation was in flight is adopted only when repository, desired branch, and
  exact expected managed path all match. Otherwise the step fails for explicit retry.
- Pending or dispatched first turns reuse deterministic command IDs, so recovery cannot start the
  first turn twice.

Setup activities carry terminal ID, exit code, and status but never output. Terminal attachment is
the only output-loading path.

## Compatibility

Servers advertise `durableThreadBootstrap`, `threadCreationDefaults`, and, when available,
`durableExecutionRecovery`. New web clients prefer the shared-outbox turn command when recovery is
available and retain the high-level bootstrap command for version skew. Legacy
`thread.turn.start.bootstrap` payloads commit directly as execution intents; they are not routed
through a pre-acceptance side-effect path. MCP `t3_create_session` uses the atomic turn path when a
prompt is supplied and returns after durable queueing rather than waiting for setup.
