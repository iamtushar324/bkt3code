# Thread-owned source-control identity

> For maintainers. Using T3 Code? See [source control integrations](../user/source-control.md).

T3 Code supports two source-control identity modes. `machine` preserves the historical behavior in
which Git and hosting CLIs use the server process's credentials. `thread-profile` resolves a GitHub
profile from every thread and fails closed when no usable profile exists.

## Identity model

A source-control profile is an attribution identity, not an access-control principal. Any trusted
collaborator who can use a thread can cause activity under its assigned profile. The durable thread
stores only a profile ID. Profile metadata lives in server settings; the personal access token lives
only in `ServerSecretStore`.

Profile creation, token maintenance, archival, and the one-to-one assignment between a Clerk-backed
environment user and a profile are administrator operations surfaced under **Settings → Users**.
Thread ownership can still be changed by trusted collaborators because it determines attribution,
not access.

Authenticated T3 requests always use their authenticated actor as the owner of a newly created
thread. A scoped actorless orchestration caller may instead provide an owner while creating a
thread, including inside an atomic first-turn bootstrap. The HTTP boundary resolves that owner
before dispatch, so `thread.created` is projected before the provider reactor resolves the first
turn's source-control identity. WebSocket clients cannot nominate a different owner. Omitting the
external owner preserves ownerless creation, and no reconciliation path transfers ownership of an
existing thread.

Commit and hosting attribution are independent:

- Git author and committer fields come from `GIT_AUTHOR_*` and `GIT_COMMITTER_*`.
- HTTPS push authentication and GitHub API activity use the profile's process-scoped `GH_TOKEN`.
- The profile gets an isolated `GH_CONFIG_DIR`; inherited GitHub tokens, Git identity variables,
  global credential helpers, and SSH transport are removed or overridden.

No token crosses the RPC boundary or enters settings, events, projections, provider diagnostics,
terminal snapshots, checkpoints, or logs.

## Resolution boundary

`SourceControlProfileService` validates and stores profiles, reports credential health, and produces
a server-only `SourceControlExecutionContext`. Thread-originated Git, GitHub CLI, provider, and
terminal operations resolve that context on the server. Clone, repository lookup, and publish flows
resolve an explicit profile because they can happen before a thread exists.

The environment merge order for locally managed provider sessions is:

1. host environment;
2. provider-instance environment;
3. thread source-control environment;
4. session-only T3 MCP variables.

Reserved GitHub and Git identity keys from earlier layers are scrubbed before the profile overlay is
applied. External OpenCode servers are rejected in enforced mode because T3 Code cannot inject into
their process environment. Built-in Git actions remain profile-aware.

## Git transport

Thread-profile mode permits GitHub network authentication only over HTTPS. The server recognizes
GitHub SCP and `ssh://` remotes, including `ssh.github.com`, and can rewrite the selected `origin` to
`https://github.com/OWNER/REPOSITORY.git`. The URL never contains a credential. A process-scoped Git
configuration clears GitHub's inherited credential helper and installs `gh auth git-credential`
under the selected profile environment.

Local working-tree reads remain available. Remote operations fail with a typed profile or
SSH-remote error instead of falling back to machine credentials.

## Ownership changes and concurrency

Owner changes, turn starts, built-in Git actions, terminal operations, and remote conversion share a
per-thread action lock. A non-blocking owner-change request fails when another action owns the lock.
After acquiring it, the server re-reads thread state and the target profile, rejects active turns or
terminal commands, stops a non-stopped provider session, closes terminals, persists
`thread.source-control-profile-set`, and appends a redacted activity entry.

If cleanup fails, no owner event is written. If persistence fails after cleanup, the old owner
remains and the stopped thread can resume normally. Earlier commits and pull requests are immutable;
only operations started after the projected owner event use the new identity.

## Persistence and compatibility

Older settings decode to `machine` with an empty profile map. Older `thread.created` events and
bootstrap commands decode their profile ID to `null`. The thread projection migration adds a
nullable `source_control_profile_id` and does not import machine tokens, Git configuration, or SSH
keys.

Archived profiles remain resolvable by threads that already reference them, but cannot be newly
assigned. Disconnected or invalid credentials fail authenticated operations until replaced. When
thread-profile mode encounters an existing unowned thread, read-only local views continue to work,
while turns, terminals, and authenticated source-control actions require selecting an owner.
