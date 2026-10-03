# Legacy orchestration migration

Orchestration v2 snapshots `state.sqlite` into `statev2.sqlite` before opening writable persistence
on its first launch. Only the copy receives v2 migrations; the original remains available to v1.
Subsequent launches reuse the copy without refreshing it from v1. It creates v2 thread shell events first and imports
the complete user and assistant transcript lazily when a client reads or continues the thread. The
v1 projection tables remain the import source and provide a read-only recovery source if an import
needs investigation.

## Imported data

The shell import preserves the project and thread identifiers, title, provider and model selection,
runtime and interaction modes, branch, worktree path, creation and update times, archive and delete
times, settlement override and timestamps, snooze timestamps, pin timestamp and order, and linked
pull request. The metadata repair path fills snooze, pin order, `unsettledAt`, and linked pull request
fields for threads imported before those fields were covered.

Transcript import reads user and assistant rows from `projection_thread_messages`. It preserves
message identifiers, text, supported attachments, timestamps, role, and ordering. A message that was
still streaming becomes an interrupted turn item.

<!-- T3-CUSTOM(expbkt3): BEGIN — retained fork history and frozen migration ledger. -->

BK also imports saved runs, checkpoints and diffs, reasoning, tool activity, proposed plans, and
pending questions through its legacy adapters. The original tables retain all source records.
Ownership, memberships, credential profiles, manual titles, tags and lineage remain available to
the native engine. Historical provider operations require native SDK boundaries; saved chat message
identifiers do not provide those boundaries. See
[BK customizations](../operations/expbkt3-customizations.md) for those limits.

## First continuation

BK retains an available provider resume cursor and uses it on the first continuation. When no
usable cursor exists, it creates a fresh provider session and sends a legacy handoff from user and
assistant messages. The handoff selects
the newest transcript suffix within a 32,000-character budget, including section labels and the
import notice. This budget is separate from portable provider handoffs.

## Client and server cutover

Clients and servers must agree on `ORCHESTRATION_PROTOCOL_VERSION` (currently 2). The client
runtime appends `orchestrationProtocol=2` to the socket URL, and the `/ws` route rejects a missing
or mismatched version with HTTP 426 (`orchestration_protocol_incompatible`) before any RPC or auth
work runs. The client checks the environment descriptor the same way: a missing version means the
host predates protocol 2, and a different version means both sides need updating. Either direction
blocks the connection as `unsupported` with a message naming the machine to update rather than
running half-upgraded. See `packages/client-runtime/src/connection/compatibility.ts` and
`apps/server/src/ws.ts`.

## Divergent migration ids

`effect_sql_migrations` records `migration_id` and `name`, but the migrator compares ids only:
rows at or below the recorded maximum are skipped without checking names. A database that ran a
local or fork migration under an id this build later assigns to a different migration therefore
never receives this build's migration at that id. `runMigrations` logs each recorded id whose name
differs from the manifest so the skipped schema change is diagnosable. BK freezes its shipped ids
1–45 and 1000–1042. Incoming upstream migrations receive the next free ids: V2 is 1043, and index
cleanup is 1044. Allocate each later migration above the recorded maximum. Never replace an applied
id or use upstream's preview ledger rewrite on the fork database.

<!-- T3-CUSTOM(expbkt3): END -->

## Recovery

There is no supported whole-thread export API. Recovery uses an untouched copy of the environment's
`userdata` directory and opens that copy with SQLite's read-only mode. The user guide documents the
queries against `projection_threads` and `projection_thread_messages`. Never start a server against
the recovery copy because startup can run migrations and write new state.
