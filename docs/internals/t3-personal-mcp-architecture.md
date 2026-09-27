# Personal MCP identity architecture

> **T3-CUSTOM(expbkt3):** This is the experimental multi-user credential layer
> deployed on `expbkt3.dev`. It is kept behind dedicated contracts, services,
> provider seams, routes, and settings components so upstream merges remain
> mechanical.

## Invariants

1. Browser-supplied user IDs are never trusted. The server derives the actor from
   the authenticated WebSocket subject.
2. Every managed ACP generation has one immutable actor until it is stopped or
   resumed under a different actor.
3. ACPs receive only a short-lived T3 token.
4. Raw upstream credentials remain in `ServerSecretStore`.
5. Missing personal credentials fail closed. There is no global-secret fallback.
6. T3 native tools authorize the actor against project/thread ownership and
   membership on every user-wide operation.
7. External personal tokens are stored only as SHA-256 hashes and are displayed
   once when rotated.

## Data model

`user_mcp_profiles` stores:

- Clerk user ID, or the deterministic `local-user` identity in single-user mode;
- enabled upstream integration metadata;
- provider-instance and tool assignments;
- personal external-token hash, prefix, and use timestamps.

Integration secrets use a SHA-256-derived `user + integration` filename in
`ServerSecretStore`. Profile JSON contains only `credentialConfigured`.

## Execution lifecycle

For an interactive turn:

1. The orchestration message records `sentByUserId`.
2. `ProviderCommandReactor` passes that user to `ProviderService`.
3. If an existing ACP generation belongs to a different actor, it is
   restarted/resumed before the prompt is delivered.
4. `McpSessionRegistry` issues a random bearer token containing the actor,
   thread, provider instance, provider session, capabilities, and expiry.
5. Every provider adapter installs the native T3 server plus the actor's enabled
   upstream proxy connections.
6. The upstream proxy revalidates the bearer and resolves the secret on every
   request.

Codex receives generated `mcp_servers.*` launch configuration. Claude Code gets
its HTTP `mcpServers` map. OpenCode registers remote MCP servers through its SDK.
Cursor and Grok receive equivalent ACP MCP server arrays.

## User session authority

Every user-bound provider session has native read/control/plan authority and
receives `t3.session.create`. It may:

- list the actor's owned or directly shared sessions;
- list projects visible to the actor;
- control an accessible session;
- create a new actor-owned session in an accessible project.

It may not access another user's private session, create server-wide projects,
modify server settings, or dispatch raw orchestration commands. Those remain
legacy administrator operations.

## Shared sessions

Turns are serialized. Tushar's turn uses Tushar's profile; Priya's later turn
causes a provider generation change and uses Priya's profile. A persistent MCP
connection from the previous generation loses authorization when its T3 token is
revoked.

Personal external tokens use a synthetic request scope, so they never imply a
current session or an automatic parent for newly created work.

## Operations

- Rotate a personal external token after suspected exposure.
- Disable **My external access** to reject it without affecting in-T3 runs.
- Disable or remove an integration to omit it from future ACP generations.
- Changing integration assignment takes effect when the provider session is next
  started/resumed.
- Logs include actor, provider session/instance, and integration ID, but never
  authorization headers, credentials, or raw sensitive arguments.
