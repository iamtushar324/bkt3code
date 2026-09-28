# T3 Code MCP control center

> **T3-CUSTOM(expbkt3):** This integration is maintained as an experimental,
> upstream-isolated extension. See the
> [customization boundary registry](../operations/expbkt3-customizations.md).

The experimental control center exposes T3 Code itself as a Streamable HTTP MCP
server. Trusted agents can triage sessions, inspect their history and live state,
send prompts, change session defaults, resolve approvals, create sessions, and
submit plans to T3's built-in [plan review](./plan-review.md). Plans produced
through T3's normal plan mode are reviewable without any special tool.

This feature is intentionally disabled in normal builds. Build the web client with:

```bash
VITE_T3_EXPERIMENTAL_CONTROL_CENTER=true pnpm exec vp run --filter @t3tools/web build
```

The server endpoint is always `/mcp`; external operator authentication remains
disabled until it is enabled in **Settings → Experiments → External T3 MCP
control**.

Experimental builds also expose **Settings → Active Projects** for editing the
nickname shown throughout T3, checking per-project running/attention totals,
opening the latest session, starting a new thread, copying the workspace path,
and removing a T3 project without deleting its files.

## Connect an external agent

1. Open Settings → Experiments.
2. Enable **External MCP server**.
3. Enable **My external access**.
4. Rotate your personal API token and copy it immediately. T3 stores only its
   hash and cannot reveal it again.
5. Set the public URL, normally `https://your-t3-host.example/mcp`.
6. Copy the generated agent configuration.

A generic configuration looks like:

```json
{
  "mcpServers": {
    "t3-code-control": {
      "type": "http",
      "url": "https://your-t3-host.example/mcp",
      "headers": {
        "Authorization": "Bearer <personal-api-token>"
      }
    }
  }
}
```

The personal token is a password-equivalent secret. It resolves to the user who
created it and can see or control only that user's accessible projects and
sessions. The compact web UI bridge may perform any operation that the same
logged-in web user is authorized to perform, including validated settings and
orchestration operations. It does not grant access-management or relay-write
scopes, make another user's project or thread visible, or bypass administrator
checks inside a handler. Rotating the token immediately invalidates the previous
token.

Reverse proxies must preserve `Authorization`, support streaming responses, and
avoid buffering the `/mcp` endpoint.

## Credential boundaries

T3 has three MCP principals:

- **Provider session:** automatically created for an agent running inside a T3
  session. The credential carries the authenticated user who started the current
  ACP generation. Every user-bound provider session receives user-wide visibility
  and `t3.session.create`, but each operation is still limited to projects and
  sessions accessible to that user.
- **External user:** created in the user's Experimental settings. It has the same
  user-scoped visibility as that account and may create user-owned sessions.
- **Legacy external operator:** retained only for controlled migration and local
  administration. It has server-wide access, including settings and raw commands.
  Its key is no longer returned to browser clients.

All principals use the same `/mcp` endpoint. Tool-level capability, user access,
and session scope checks run on every call.

## ACP identity and personal upstream MCP

Codex, Claude Code, OpenCode, Cursor, and Grok all receive the same logical MCP
configuration through their provider adapters. The configuration contains only a
short-lived T3 bearer token. It never contains a user's Bifrost, Linear, GitHub,
or other upstream credential.

When a user starts a turn, T3 binds the ACP generation to that authenticated user.
If a different authorized user starts the next turn in a shared session, T3
restarts/resumes the provider generation with the new identity before sending the
turn. This prevents a long-lived ACP process from retaining the previous user's
MCP authority.

Managed integrations are configured under **Settings → Experiments → My managed
MCP integrations**. Each integration can be assigned to every provider instance
or an explicit list, and may carry a tool allowlist. Calls use:

```text
ACP → /mcp/upstream/<integration-id> → user's write-only credential → upstream MCP
```

The proxy accepts the ACP's short-lived T3 token, resolves its `actorUserId`,
verifies the provider assignment and tool allowlist, loads the credential from
`ServerSecretStore`, injects the selected authentication header, and streams the
upstream response. An absent credential fails closed; T3 never falls back to
another user's key.

Bifrost integrations normally use `x-bf-vk`. Bearer, `x-api-key`, and validated
custom-header authentication are also supported.

## Tools

| Tool                        | Purpose                                                                                                                      |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `t3_list_sessions`          | Triage active or archived sessions with provider status, attention reasons, and latest-turn summary; filter by custom group. |
| `t3_get_session`            | Inspect recent messages, activities, plans, approvals, inputs, and checkpoints.                                              |
| `t3_list_projects`          | Discover project IDs, roots, repository identity, defaults, scripts, and active session counts.                              |
| `t3_get_configuration`      | Discover redacted server settings and the live provider/model catalog, including supported model options.                    |
| `t3_send_prompt`            | Start or steer a turn and optionally select model, runtime mode, and plan/default interaction mode.                          |
| `t3_update_session`         | Keep title, Linear issue tag, custom group, priority, branch, model, runtime mode, and interaction mode current.             |
| `t3_session_action`         | Interrupt, stop, restart, archive or unarchive, settle or activate, snooze or unsnooze, or delete.                           |
| `t3_respond_approval`       | Resolve a pending provider approval using the request's allowed decision.                                                    |
| `t3_respond_user_input`     | Answer a pending structured user-input request.                                                                              |
| `t3_create_project`         | Register or safely create a workspace project on a fresh T3 server. External operators only.                                 |
| `t3_update_project`         | Update a project's title, default model/options, and project actions. External operators only.                               |
| `t3_create_session`         | Create a user-owned session. User-bound provider sessions, external users, and legacy external operators.                    |
| `t3_link_session`           | File one session under another, for organising related work into a tree.                                                     |
| `t3_unlink_session`         | Detach a session from its parent, returning it to the top level.                                                             |
| `t3_submit_plan`            | Publish a Markdown or HTML plan as the session's proposed plan, reviewable in built-in plan review.                          |
| `t3_update_server_settings` | Apply a validated settings patch. External operators only.                                                                   |
| `t3_dispatch_command`       | Dispatch any current validated orchestration command. External operators only; prefer focused tools.                         |
| `t3_ui_list_tools`          | List every virtual tool generated from the authenticated web UI RPC contract, with scope and stream metadata.                |
| `t3_ui_get_tool`            | Read the exact input, success, and declared error schemas for one virtual web UI tool.                                       |
| `t3_ui_call`                | Execute one virtual web UI tool through the browser's handler, validation, authorization, and visibility path.               |
| `t3_ui_batch`               | Execute up to 25 virtual web UI tools sequentially in a shared handler scope.                                                |
| `link_pull_request`         | Tag a pull request onto a session, for a review branch detection will not find on its own.                                   |
| `unlink_pull_request`       | Remove a pull request tag from a session.                                                                                    |
| `list_thread_pull_requests` | List a session's tagged pull requests with their host state and how they chain into stacks.                                  |

The MCP JSON schemas describe every field. Agents should call
`t3_get_configuration` before changing models and `t3_get_session` before
answering approvals or structured input.

## Naming a session's work

Three pieces of a session's identity are settable over MCP, so an agent can
label its own work rather than leaving it to whoever opens the sidebar:

- **Title** — `t3_update_session` with `title`. An MCP rename takes ownership of
  the title, so automatic title generation will not overwrite it afterwards.
- **Linear issue** — `t3_update_session` with `linearIssueUrl`, or `null` to
  clear it. Only `linear.app` issue URLs are accepted; the key and its live
  status then appear beside the session in the sidebar.
- **Custom group** — `t3_update_session` with `customGroup`, or `null` to remove
  the session from its group; `t3_create_session` accepts the same field. A
  custom group is the shared label that sections the sidebar's Custom view and
  backs its Group filter, so an agent fanning out work can file every child
  under one label. Labels match case-insensitively; `t3_list_sessions` reports
  each session's `customGroup` and takes a `customGroup` filter.
- **Pull requests** — `link_pull_request`, once per review, including each layer
  of a stack. A session can hold several; the sidebar shows the current one's
  number and opens the full list when there is more than one. Tag them
  explicitly whenever a review is not simply the checked-out branch's.

An in-session agent omits `sessionId` and acts on its own session. An external
or user-wide agent supplies `sessionId`, and may only name sessions its own
actor can already see.

## Complete web UI parity and code mode

The four `t3_ui_*` bridge tools expose the complete authenticated WebSocket RPC surface
without advertising roughly one hundred large schemas in every provider prompt.
At the time of this release the catalog contains 100 virtual tools, including 19
streams. The list is generated from `WsRpcGroup`, so a later web RPC is present
automatically and the parity test fails if naming, authorization coverage, or
schema generation becomes incomplete.

Use this code-mode sequence:

1. Call `t3_ui_list_tools` with no filters to receive the full virtual tool list.
   Each entry includes its generated name, underlying RPC method, category,
   required transport scope, read/write hint, stream mode, and whether the
   current caller has that scope.
2. Call `t3_ui_get_tool` with the chosen virtual name to retrieve its exact
   input, success, and declared error JSON schemas.
3. Call `t3_ui_call` with `tool` and `input`, or combine dependent operations in
   `t3_ui_batch`. Batch execution is sequential and may stop on the first error.

For example, `server.getConfig` is exposed as
`t3_ui_server_get_config`, while
`sourceControl.profiles.replaceCredential` is exposed as
`t3_ui_source_control_profiles_replace_credential`. Dots and camel-case
boundaries become lower-case underscores; `t3_ui_list_tools` is the canonical
list rather than documentation copied by hand.

Calls reuse the same in-process handlers as the web socket client. That means
payload decoding, transport scopes, Clerk administrator checks, per-user
project/thread visibility, settings redaction, orchestration receipts, and
provider-specific behavior stay identical to the web UI. An `authorized: true`
catalog entry confirms only the transport scope; the handler still checks the
specific project, thread, user, process, or external resource at call time.

Streaming virtual tools return bounded event arrays. Subscription streams use a
short snapshot-oriented window by default; progress streams use a longer window
for operations such as server updates, relay installation, and stacked Git
actions. Callers may set `maxItems` (1–500), `idleTimeoutMs` (100–60,000), and
`totalTimeoutMs` (1,000–300,000). Every value is clamped server-side, so a
subscription cannot leave an MCP request open indefinitely.

Browser-local preferences, HTTP authentication/session bootstrap, and cloud-link
handshakes that are not part of the authenticated WebSocket contract are not in
this catalog. Focused tools
such as `t3_get_session`, `t3_send_prompt`, and the `preview_*` family remain the
preferred interface for routine agent work; the bridge is the complete escape
hatch for deep control and read parity.

`t3_create_session` takes an omitted model from the project's default and then the app default; it
starts in full access and Build mode unless told otherwise. Its structured `workspace` override can
request Local, an existing worktree, or a new worktree with a Local or Origin base ref. When a prompt
is supplied, T3 prepares the worktree and runs the project's setup script before the first turn, the
same way a session started from the app does. It returns `sessionId`, the resolved `workspace`,
and who can see the session.

### Where a session a session creates works

A session that creates another session no longer scatters checkouts. With no `workspace` passed:

| The new session targets           | Where it works                                                                |
| --------------------------------- | ----------------------------------------------------------------------------- |
| the creating session's repository | that session's own worktree, or its project checkout when it has no worktree  |
| a different repository            | one worktree, shared by every session that session creates in that repository |

The second row holds for a fan-out as well as a sequence: the shared worktree is reserved when each
session is accepted, before any checkout exists, so four sessions created at once land in one tree
rather than four.

Pass a `workspace` to opt out; it is honoured exactly as given. `{mode: "new-worktree"}` is the way
to ask for an isolated tree, which is what several sessions editing one repository **in parallel**
need — sharing a worktree means sharing a branch and a working tree, and their edits will interleave.

### Session lineage

A session created by another session records that session as its parent, and the experimental
phase-grouped sidebar files it under that parent as a collapsible subtree. This keeps a fan-out —
typically cross-repo work — readable as one unit of work instead of several unrelated rows.

A parent row reports what its subtree is doing without being opened. Next to the timestamp it
carries two counters, each covering every level beneath it, and each shown whether the subtree is
open or closed:

- a green dot with a number — that many child sessions finished a turn you have not read
- a pulse glyph with a number — that many child sessions have an agent working

They use the same glyphs the child rows use for the same state, so the number reads as "this many of
those, below me". A parent whose subtree is waiting on a human also flies a `↳ INPUT`, `↳ APPROVAL`,
or `↳ ERROR` badge while it is collapsed.

Nesting is the calling agent's choice:

| Field                             | Effect                                                                                                                                             |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createAsChild` omitted or `true` | Nested under the calling session. The default, and the right choice for work you fanned out.                                                       |
| `createAsChild: false`            | Created at the top level, exactly as if a person had started it. Use this when the new session is independent work that should stand on its own.   |
| `parentSessionId`                 | Nest under a specific session rather than the caller, for building a tree you are not the root of. Cannot be combined with `createAsChild: false`. |

`t3_list_sessions` and `t3_get_session` report `parentSessionId`, so an agent can inspect its own
subtree instead of re-spawning work it already delegated.

Sessions created through a personal external token are never parented automatically: that token
has a synthetic request scope rather than a session the user is working in.

Lineage is editable after creation, so an agent can reorganise a workspace it did not lay out
itself:

- `t3_link_session({ sessionId, parentSessionId })` files one session under another.
- `t3_unlink_session({ sessionId })` returns it to the top level.

A session's own children always travel with it, and unlinking a parent never orphans its subtree.

A person can do the same from the sidebar row's context menu — **Move under session…** and **Detach
from parent**.

Lineage always stays a tree. A session cannot be filed under itself or under any of its own
descendants; the server rejects such a link rather than storing a cycle.

### Who sees a session an agent creates

A session created from another session is born tagged with that session's audience: the parent
session's owner plus everyone tagged on it. Delegated work therefore stays in the sidebar of the
person who asked for it, even when someone else prompted the parent and ends up owning the new
session — before this, a session spawned during a shared conversation vanished from every watcher's
sidebar except the last person to type.

Inheritance follows the session that created the work, not the sidebar tree, so `createAsChild:
false` still keeps the same audience. The same rule covers a person starting a side-by-side session
from a sidebar row.

The calling agent can override the audience:

| Field                              | Effect                                                                    |
| ---------------------------------- | ------------------------------------------------------------------------- |
| omitted                            | Inherits the calling session's owner and tags. The default.               |
| `tagUserIds`                       | Tags exactly these users instead. Accepts T3 user IDs or email addresses. |
| `tagUserIds` + `inheritParentTags` | Tags these users **on top of** the inherited audience.                    |
| `inheritParentTags: false`         | Tags nobody: the session is private to its owner.                         |

An email or ID that matches no user in the workspace fails the call rather than silently tagging
nobody. `t3_create_session` returns `ownerUserId` and `taggedUserIds` so the agent can report who
can see the session it just made.

Tagging stays editable afterwards: `thread.member.add` and `thread.member.remove` change a session's
audience at any time, and reach an agent through `t3_dispatch_command`.

### Side-by-side sessions

The same context menu starts one. **Create new thread** offers two workspaces:

| Choice                  | Where the new session runs                                                                          |
| ----------------------- | --------------------------------------------------------------------------------------------------- |
| **Using same worktree** | The worktree the session you clicked is using, or its project checkout when it is not in a worktree |
| **Using new worktree**  | A fresh worktree, created immediately and branched from the session you clicked                     |

Either choice creates the session on the spot, files it under the one you started it from, and opens
it with an empty composer. It is a real session before a single word is typed, so switching to
another row and back returns to it with whatever you had written still there — the sidebar tree is
the tab strip. It inherits the parent's provider and model, starts in Build mode, and takes the
app's default runtime mode. The first message you send retitles it, as in any other session.

The **New thread** button in the sidebar header is unchanged: it still starts a single scratch draft
per project rather than a durable session.

## Recommended triage loop

1. Call `t3_list_sessions` with `attentionOnly: true`.
2. Read the attention reasons and latest-turn summary before fetching a full session.
3. Call `t3_get_session` only for sessions that need a decision.
4. Respond to approvals or input using the exact pending request ID.
5. Send a targeted prompt when the agent needs guidance; use `interrupt` first
   only when replacing an active turn.
6. Update a stale title when the objective has materially changed.
7. Re-list sessions to confirm the attention state cleared.

The sidebar counters use the same practical categories: the red attention count
includes pending approvals, structured input, actionable plans, and failures; the
green count includes active, blocked, or stopping executions. Archived sessions
are excluded.

## Submitting a plan

Plans from T3's normal plan mode open in built-in plan review on their own.
`t3_submit_plan` is for agents outside T3, or for a plan written some other way.
It takes the target `sessionId` (optional for an in-session caller), a `format`
of `md` or `html`, and the complete `content`. The plan becomes the session's
actionable proposed plan; approving it starts implementation through the normal
turn path.

## Security and operational notes

- Bind the T3 server to a private interface and expose it only through an
  authenticated TLS reverse proxy.
- Never place an operator key in source control, chat transcripts, shell history,
  screenshots, or logs.
- The settings read tool redacts provider environment secrets and never returns
  legacy operator or personal integration credentials.
- A shared session changes credential identity only at a serialized turn
  boundary. Direct ACP configuration outside T3's managed proxy is not covered
  by this isolation guarantee.
- HTML plans render inside a sandboxed frame in plan review. Accept HTML only from
  trusted agents.
- Session deletion and advanced raw commands are destructive. Inspect the session
  first and prefer focused tools.
- Rotating the key during `t3_update_server_settings` may invalidate the call's
  credential immediately after the update succeeds.

## Implementation map

- MCP authentication and scopes:
  `apps/server/src/mcp/{McpSessionRegistry,McpInvocationContext}.ts`
- Per-user profile/secret metadata and upstream proxy:
  `apps/server/src/mcp/{UserMcpProfileStore,McpUpstreamProxy}.ts`
- Tool contracts and handlers:
  `apps/server/src/mcp/toolkits/control/`
- Complete authenticated web UI bridge:
  `apps/server/src/mcp/toolkits/webUi/`
- Plan review:
  `apps/server/src/planreview/`, `apps/web/src/components/planreview/`
- Sidebar status derivation:
  `apps/web/src/components/sidebar/sidebarSessionCounters.ts`
- Experimental settings:
  `apps/web/src/components/settings/ExternalMcpSettingsSection.tsx`
- Right-panel review surface:
  `apps/web/src/fork/planReviewSurface.tsx`, `apps/web/src/rightPanelStore.ts`
