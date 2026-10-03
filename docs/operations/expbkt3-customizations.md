# expbkt3 customization boundaries

The Beknown fork extends upstream T3 Code with team mode, external MCP control,
native plan review, the phase-grouped sidebar, and BK desktop and mobile builds.
This page is the registry of where that code lives and which seams it holds in
upstream-owned files.

These changes are structured to keep upstream merges predictable:

- Dedicated implementations carry a file-level `T3-CUSTOM(expbkt3)` comment.
- Small edits inside upstream-owned files are wrapped in
  `T3-CUSTOM(expbkt3): BEGIN` / `T3-CUSTOM(expbkt3): END` comments.
- Web entry points are gated by `VITE_T3_EXPERIMENTAL_CONTROL_CENTER` through
  `apps/web/src/experimentalFeatures.ts`.

## Stage merge (2026-10-03)

`stage` merges upstream `main` (`56914128`) into the existing BK stage history.
It adopts upstream's V2 engine and retains the fork features below; see
[Beknown deployments](./deployments.md). Every section below describes the stage line.

**Kept:** team mode (Clerk sign-in, environment users, ownership, per-user
visibility, project and thread members); member device pairing with
device-bound credentials and the managed primary for BK desktop; session
identity environment and the Claude `userEmail` fix; per-user GitHub profiles;
personal MCP identity and the external MCP endpoint; MCP control tools and web UI
tools (`t3_*`, `t3_ui_*`); admin pages (users, project access, Active Projects);
event feed and external PR sync endpoints for the Linear bridge; Claude
hard-limit account rotation; city codename worktrees; child sessions and lineage,
including cross-environment parents; manual-title ownership; shared workspace groups for sibling
sessions; session archive; the phase-grouped sidebar on web and mobile, with
per-thread custom groups; shared host appearance (name, icon, colour stored in the host's server settings); the smart git button (header asks the agent to commit / push / create PR, flag `smartGitPromptsEnabled`); thread priority; Linear tags; Mattermost links; the
row PR badge; native plan review; comments on agent messages (`chatCommentsEnabled`); plan mode on by default; agent views
(`t3_show_ui`); user presence for agents (`t3_user_presence`, `GET /api/presence`,
`BK_T3_PRESENCE_URL`); context handoff and offline digest; per-thread cost; offline
history cache and queued sends; draft focus, right-panel memory and file-tree
collapse-all; integrated-browser link routing; the mobile-web long-press menu;
the async question indicator; a read-only environment badge; the BK desktop and
mobile builds; the deploy, CI and marker tooling; Claude account profiles per thread
(`experimental.claudeAccountProfiles`: Auto placement through `claude-autoswitch --place`,
per-thread pinning, sticky `CLAUDE_CONFIG_DIR` per spawn, hard-limit move with a
continue turn; [claude-account-switching.md](./claude-account-switching.md#per-thread-account-placement)).

**Dropped in favour of upstream's own behaviour:**

| Fork feature                                                                                                             | What stage uses instead                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Durable execution, session recovery, provider reaper additions                                                           | Upstream V2 execution, durable effects, and provider-session recovery.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Durable thread bootstrap                                                                                                 | Upstream V2 launch workflows and turn-start bootstrap. Retained HTTP and MCP entry points translate their bootstrap requests into the native engine.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Provider usage-limit bars                                                                                                | Upstream's `ProviderUsageLimits` (**Usage → Limits**).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Host-wide new-thread defaults (`defaultThreadModelSelection`, `defaultThreadRuntimeMode`, the "Projects & threads" rows) | Upstream's scoped settings: `defaultModelSelection` (with effort and context options), `defaultRuntimeMode` and `defaultThreadEnvMode`, per host or per project through `projectSettingsOverrides`, plus the fork's project-scoped `defaultThreadInteractionMode` as a **Starting mode** (Plan / Build) row beside Permissions. `packages/shared/src/newThreadDefaults.expbkt3.ts` resolves them (project override, then host, then built-in) for the web's new-thread paths, the sidebar's side-by-side rows and `t3_create_session`, and the saved default always wins for a new thread — over the last composer pick too. The two old keys stay decodable; `serverSettings.ts` folds them into the upstream keys on load. |

**Dropped outright:** Plannotator, catch-up and work summaries, the bulk session
manager, the spoken session summary, notification tones and alerts, the title
refresh cadence, open-in-app targets and the remote-open backport,
the resource
monitor, terminal output flow control, attaching an external terminal session,
command palette additions, client reconnect and resync fixes, server performance
hardening (SQLite tuning, payload cap, event-log bounds, replay batching, shell
projection barrier), and the mobile VoiceOver fixes.

**Migrations.** Every shipped migration ID is frozen. Upstream migrations
052-054 register at 1036-1038. Fork migrations through 1042 retain their
original IDs. Upstream V2 migrations 055-056 register at 1043-1044; the next
free ID is **1045**. The allocation rule sits above the registry in
`apps/server/src/persistence/Migrations.ts`.

The V2 cutover uses `statev2.sqlite` and leaves `state.sqlite` intact. The
importer retains BK ownership, membership, credential profiles and thread
metadata, then imports messages, provider resume cursors, tool history, plans
and checkpoints into the native projection. Existing plan documents and
comments remain in their fork tables. Retained fork APIs translate commands
into the native orchestrator and read a compatibility projection; they do not
run a second execution engine.

Imported checkpoint diffs retain their original Git refs and workspace paths.
Historical rewind follows upstream V2 provider limits: Codex rejects legacy
history rollback, and older Claude turns do not have the SDK message boundaries
that native rewind requires. The importer preserves the actual current Claude
resume cursor; it does not infer historical SDK IDs from T3 message IDs.

**Retired event types.** The event log is append-only, so fork databases still
hold events of removed features. `persistence/retiredOrchestrationEvents.expbkt3.ts`
lists those types and reads skip them before decoding. Whenever a fork event type
is removed, add it there, or replaying an existing database fails.

**Marker baseline.** `scripts/fork-marker-baseline.json` started empty on the
cut: every fork hunk in an upstream-owned file is marked. Keep it empty.

**Fork UI style debt.** Fork web surfaces written before upstream adopted the
shadcn lint rules are exempt from them in one marked block in `vite.config.ts`.
The list is a ratchet: remove a file once it is restyled, never add one.

## Finding fork code

Find every marked boundary with:

```bash
rg 'T3-CUSTOM\\(expbkt3\\)'
```

Marker discipline is enforced in CI by `scripts/check-fork-markers.ts`
(`.github/workflows/fork-markers.yml`, and a step in `deploy-stage.yml`). It
diffs the branch against the newest upstream commit merged into it
(`FORK_UPSTREAM_REF`, which CI sets to `pingdotgg/t3code` `main`; locally it
defaults to `origin/main`) and fails when a hunk in an upstream-owned file sits
outside a marker. Files the fork _added_ are
fork-owned and skipped; ownership is decided by git status, never by sniffing
file contents, because upstream-owned files routinely carry a marked fork import
near the top.

`scripts/fork-marker-baseline.json` grandfathers non-compliant files; on stage
it is empty. It is a ratchet: a new violation in a file
outside the baseline fails, and a baselined file that becomes fully compliant
also fails, with an instruction to drop it from the list. Regenerate with
`node scripts/check-fork-markers.ts --write-baseline` (add `--force` only when
deliberately adopting new violations).

## Core exceptions — permanently fork-owned, not flag-gated

Most fork features sit behind a flag so upstream's code path stays intact and a
post-merge regression can be isolated by switching ours off. The subsystems
below are deliberate exceptions: they are load-bearing infrastructure whose
"off" path would be a second, untested execution mode — flag-gating them would
_increase_ merge and correctness risk rather than reduce it. Treat them as
permanent fork surface and keep them marked instead.

| Subsystem                         | Why it is not flag-gated                                                                                                                                                                                              |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| User management / Clerk team mode | The reason the fork exists. Already conditioned on `T3CODE_CLERK_SECRET_KEY` being configured.                                                                                                                        |
| Ownership + access control        | A disabled access-control path is a data-exposure bug, not a fallback. Part of user management in practice.                                                                                                           |
| Thread priority                   | A projection column plus ordering. Nothing to disable; the sidebar that consumes it is itself flag-gated.                                                                                                             |
| Thread custom group               | A projection column plus a sidebar grouping source. Nothing to disable; the sidebar that consumes it is itself flag-gated.                                                                                            |
| Thread Linear tags                | Durable metadata plus a read-only status lookup served from the bridge's webhook projection, with a per-viewer Bifrost fallback. Settable from the UI or over MCP. The sidebar that consumes it is itself flag-gated. |

Everything outside this table should follow the flag rule in `AGENTS.md`.

## Deliberately not extracted

Not every fork seam is worth moving to a fork-owned file. These were evaluated
and left in place on purpose — re-deriving the decision costs more than reading
it:

- **`server.ts` fork layers.** Extracting the fork layer graph behind a factory
  saves roughly 80 lines, but the factory needs one generic parameter per
  upstream layer (plus Effect diagnostic suppressions) to keep the service types
  flowing. That makes the file that composes the whole server runtime harder to
  read, and mis-ordering `provide` vs `provideMerge` fails only on a real boot.
  `server.ts` is already among the best-marked files in the fork and its
  conflicts are mechanical, so the seams stay inline and marked.
- **`ProjectionSnapshotQuery.ts` column threading**, **`ProviderService.ts`
  parameter threading**, contract struct field additions, and web component JSX
  mounts. There is no hook shape that removes these; marker discipline is the
  only available lever.

Semantic divergence is the expensive kind of fork change — where we _replaced_
an upstream algorithm rather than adding to it. Those merge cleanly and then
break at runtime, so they deserve the loudest markers. On stage the ones left
are the identity and credential-actor restart predicate in
`ProviderCommandReactor.ts` and the bootstrap copy in
`turnStartBootstrap.expbkt3.ts`.

## Feature ownership

| Area                      | Dedicated implementation                                                                                                                                                                                                                           | Upstream-facing seams                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Active Projects           | `ActiveProjectsSettingsPanel*`, `settings.projects.tsx`                                                                                                                                                                                            | `SettingsSidebarNav.tsx`, generated route tree                                                                                                                                                                                                                                                                                                                                                                                  |
| Personal MCP identity     | `ExternalMcpSettingsSection*`, `UserMcpProfileStore.ts`, `McpUpstreamProxy.ts`, `personalMcp.ts`                                                                                                                                                   | provider adapters, RPC group, server route/layer wiring                                                                                                                                                                                                                                                                                                                                                                         |
| MCP operator/native tools | `apps/server/src/mcp/toolkits/control/`                                                                                                                                                                                                            | MCP toolkit assembly and server route wiring                                                                                                                                                                                                                                                                                                                                                                                    |
| MCP web UI parity         | `apps/server/src/mcp/toolkits/webUi/`                                                                                                                                                                                                              | one reusable authenticated-handler layer export in `ws.ts`; MCP toolkit assembly                                                                                                                                                                                                                                                                                                                                                |
| Lifecycle counters        | experimental sidebar counter components                                                                                                                                                                                                            | `SidebarChrome.tsx`                                                                                                                                                                                                                                                                                                                                                                                                             |
| Urgent pending input      | `PhaseGroupedSidebar.logic.ts`                                                                                                                                                                                                                     | `PhaseGroupedSidebar.tsx`                                                                                                                                                                                                                                                                                                                                                                                                       |
| Lifecycle parking shelves | `PhaseGroupedSidebar.logic.ts` (`partitionPhaseSidebarRows`), `PhaseGroupedSidebar.tsx`                                                                                                                                                            | `useThreadActions.ts`, `Sidebar.snooze.ts`, `Sidebar.logic.ts` (all read-only)                                                                                                                                                                                                                                                                                                                                                  |
| Thread Linear tags        | `LinearIssueResolver.ts`, `LinearStatusBridge.ts`, `LinearIssueStatusCache.ts`, `LinearIssueTagDialog.tsx`, `linearIssue.ts`, migration 1004                                                                                                       | orchestration/contracts projections, `ws.ts`, `PhaseGroupedSidebar.tsx`                                                                                                                                                                                                                                                                                                                                                         |
| Custom sidebar groups     | `packages/contracts/src/threadCustomGroup.ts`, migration 1039, `phaseSidebarGrouping.ts`, `decider.customGroup.test.ts`, `handlers.customGroup.test.ts`                                                                                            | `customGroup` on the thread create/meta-update contracts, decider/projector/projection columns, MCP create+update+list handlers, sidebar row menus and filter facets                                                                                                                                                                                                                                                            |
| Shared child workspaces   | `apps/server/src/workspace-groups/`, `persistence/ThreadWorkspaceGroups`, migration 1035, `orchestration/turnStartBootstrap.expbkt3.ts`                                                                                                            | HTTP dispatch route and `t3_create_session` call the bootstrap service; `server.ts` layer                                                                                                                                                                                                                                                                                                                                       |
| Row change-request badge  | `PhaseGroupedSidebar.logic.ts` (`resolvePhaseSidebarChangeRequestBadge`)                                                                                                                                                                           | `PhaseGroupedSidebar.tsx` row metadata lane                                                                                                                                                                                                                                                                                                                                                                                     |
| Sidebar people filters    | `PhaseGroupedSidebar.logic.ts` facets, `phaseSidebarFilterStore.ts`                                                                                                                                                                                | `PhaseGroupedSidebar.tsx` popover, chips, row projection                                                                                                                                                                                                                                                                                                                                                                        |
| Sidebar grouping modes    | `packages/client-runtime/src/state/phaseSidebarGrouping.ts` (sections, custom groups, collapse), `phaseSidebarGroupingStore.ts` (web), `apps/mobile/src/features/phasesidebar/` (mobile pane, sheet, counters)                                     | `PhaseGroupedSidebar.tsx` section rendering, `SidebarChrome.tsx` unread/running/unsettled counters, `mobile-preferences.ts` one key                                                                                                                                                                                                                                                                                             |
| Per-thread session cost   | `packages/contracts/src/threadUsage.ts`, `apps/server/src/usage/threadUsage.ts`, `packages/client-runtime/src/state/threadUsage.ts`, `apps/web/src/components/chat/ThreadCostControl.tsx`, `apps/mobile/src/features/threadusage/`                 | `rpcFork.ts` method, `UsageService.ts` readThreadUsage seam, `wsForkHandlers.ts` handler, `ChatHeader.tsx` one call site, `ThreadRouteScreen.tsx` header item, `Stack.tsx` route                                                                                                                                                                                                                                                |
| Environment badge         | `packages/contracts/src/environmentAppearance.ts` (shared host setting), `packages/client-runtime/src/state/environmentAppearance.ts` (catalogue, defaults), `EnvironmentBadge.tsx` and `EnvironmentAppearance*` (web and mobile).                 | `settings.ts` field + patch, capability, `serverSettings.ts` replace, `ConnectionsSettings.tsx`/`EnvironmentRow.tsx`, mobile `Stack.tsx` + `ConnectionEnvironmentRow.tsx`                                                                                                                                                                                                                                                       |
| File browser collapse all | —                                                                                                                                                                                                                                                  | `apps/web/src/components/files/FileBrowserPanel.tsx` one button + handler                                                                                                                                                                                                                                                                                                                                                       |
| Chat comments             | `packages/contracts/src/threadComments.ts`, `apps/server/src/threadcomments/`, `packages/client-runtime/src/state/threadComments.ts`, `apps/web/src/fork/threadComments/`, `apps/web/src/state/threadComments.ts`, `docs/user/chat-comments.md`    | fork RPC methods in `rpcFork.ts` + one subscription tag in `client-runtime/src/rpc/client.ts`, `threadComments` capability, `chatCommentsEnabled` setting, `comments` right-panel kind (store/tabs), `ChatView.tsx` panel branch + banner + empty-send gate, `ChatComposer.tsx` send state + placeholder, `AssistantSelectionToolbar.tsx` group + `extraActions`, `MessagesTimeline.tsx` wrap, `ProviderCommandReactor.ts` seam |
| Native plan review        | `apps/server/src/planreview/`, `persistence/PlanReviewDocuments.ts`, migration 1009, `packages/shared/src/planReview.ts`, `packages/contracts/src/planReview.ts`, `apps/web/src/components/planreview/`, `apps/web/src/fork/planReviewSurface.tsx` | fork RPC group + scopes + handlers, one `ws.ts` dep, right-panel store/tabs, `ChatView.tsx` branch, `ProposedPlanCard.tsx` button, Experiments settings toggles, nullable comment range in `reviewCommentContext.ts` + `reviewCommentSelection.ts` + `nativeReviewDiffAdapter.ts`, plan-comment card in `MessagesTimeline.tsx` + `ThreadFeed.tsx`                                                                               |
| Session identity          | `apps/server/src/identity/SessionIdentityEnvironment.ts`, `apps/server/src/provider/claudeSessionIdentity.expbkt3.ts`                                                                                                                              | `ProviderCommandReactor.ts` execution-options seam, `ProviderService.ts` adapter-spawn seam, `identityEnvironment` on `ProviderSessionExecutionOptions`, conditional scrub in `SourceControlExecutionEnvironment.ts`, `server.ts` layer, `ClaudeAdapter.ts` system-prompt append + `UserPromptSubmit` hook seams                                                                                                                |
| Agent views in chat       | `apps/server/src/agentui/`, `persistence/AgentUiRenders.ts`, migration 1022, `packages/contracts/src/agentUi.ts`, `packages/client-runtime/src/state/agentUi.ts`, `apps/web/src/fork/agentUiSurface.tsx`, `apps/web/src/state/agentUi.ts`          | `t3_show_ui` in the MCP control toolkit, fork RPC group + scopes + handlers, one `ws.ts` dep, one `server.ts` layer, marked handle passthrough in `ActivityPayloadProjection.ts`, `agentUi` field + read in `session-logic.ts`, one import and early return in `MessagesTimeline.tsx`, Experiments toggle + `settingsSearch.ts` entry                                                                                           |
| User presence             | `apps/server/src/presence/` (rules, tracker, message query, `presenceHttp.expbkt3.ts`, `presenceEnvironment.expbkt3.ts`, `backgroundPolicyRedaction.expbkt3.ts`), `t3_user_presence` tool, web + mobile `useThreadPresenceScope`                   | `userPresence` capability, one route + layer in `server.ts`, `BK_T3_PRESENCE_URL` beside the bearer in `ClaudeAdapter.ts` + `CodexAdapter.ts`, lease redaction at both background-policy RPCs in `ws.ts`, exported `retainBackgroundScope` + one `ChatView.tsx` hook call, `retainMobileBackgroundScope` + one `ThreadRouteScreen.tsx` hook call                                                                                |
| Experimental deployment   | `.github/workflows/deploy-expbkt3.yml`, `deploy/expbkt3/`                                                                                                                                                                                          | none                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Stage deployment          | `.github/workflows/deploy-stage.yml`, `deploy/stage/`                                                                                                                                                                                              | none                                                                                                                                                                                                                                                                                                                                                                                                                            |
| BK mobile distribution    | `apps/mobile/app.config.bk.ts`, `apps/mobile/plugins/withBkAndroidReleaseSigning.cjs`, `apps/mobile/src/lib/bkBuildIdentity.ts`, `scripts/build-bk-mobile.ts`, `scripts/generate-bk-mobile-source.ts`, `.github/workflows/mobile-bk-release.yml`   | two lines in `app.config.ts` (import + export), one linking prefix in `App.tsx`, one version call in `authClientMetadata.ts`                                                                                                                                                                                                                                                                                                    |

Agent views are scoped by `apps/web/src/fork/agentUiRuntime.ts`. Framed
collaboration apps can decline to join the URL-selected room and render
unrelated origin-local state instead, so `url` renders stay blocked until the
generic URL contract can render truthfully. Agent-authored `html` renders are
unaffected — the document is what the agent produced and mounts from `srcDoc` in
an opaque-origin sandbox — and follow the client setting alone.

Generated files such as `apps/web/src/routeTree.gen.ts` do not receive hand-written
markers; they are regenerated from marked route sources.

## Sidebar people filters

Two facets in the experimental sidebar's filter popover, both fork-owned logic
with the UI in `PhaseGroupedSidebar.tsx`:

- **Started by me** (`ownedByMe`) matches on `ownerUserId`. It replaced an
  "Assigned to me" facet that tested owner-or-tagged — which is exactly the
  server's visibility rule in `accessRules.ts`, so every thread the operator
  could see already satisfied it and the checkbox selected everything. If a
  future change makes that filter "assigned" again, it is a no-op again.
- **People on the session** (`participantUserIds`) matches threads that include
  _all_ selected people, not any: selecting two teammates asks for their shared
  sessions. The directory comes from `useOrgMembers`, and `reconcile` drops ids
  that leave it — but only when a directory set is supplied, so an empty list
  during load cannot wipe a live selection.

Both persist in the existing `t3code:phase-sidebar-filters:v1` blob; the
sanitizer defaults them off for blobs written before they existed, so the
storage version stays v1.

## Where Linear issue status comes from

The sidebar shows `TEC-1295 (Done)` beside a tagged row. That status is read in
this order, and the order is the whole design:

1. **The bridge** (`LinearStatusBridge.ts`), when `BRIDGE_SERVICE_TOKEN` is set.
   TLB already receives a Linear `Issue` data-change webhook for every issue in
   the workspace and projects it into a table, so it answers from its own
   database and costs Linear nothing. Its credential belongs to the server, so
   this is the only path that works for a viewer who has no Bifrost integration
   — that viewer used to see `(unavailable)` on every row.
2. **Bifrost**, per viewer, for identifiers the bridge has never seen. One
   HTTPS round trip per issue, using that person's own virtual key.
3. **Neither configured** → the row says so, naming the thing to fix.

An entry the bridge returns with `status: null` and `error: null` means "never
seen here", not "no status": it is dropped so the Bifrost fallback still runs.
A bridge that is down, unreachable, or refuses the token returns nothing and
falls through to step 2 — it can never be worse than not having a bridge.

In front of all of it sits `LinearIssueStatusCache`, a process-wide cache keyed
by identifier with a `Deferred` per in-flight read. Issue status is
workspace-global, so it does not vary by viewer and caches cleanly; without it
the sidebar's per-minute refresh multiplied by every viewer and every browser
tab. Successes live 50s (just under the client's 55s stale time), failures 5s
so a credential that starts working is not pinned to `(unavailable)` for a full
window.

The cache is deliberately memoised at module scope rather than built in the
fork's RPC handler map: that map is rebuilt per connection, so a cache created
there would collapse one client's tabs and nothing else — which is not where the
multiplication comes from.

## toolyard (built in, auto-connected)

Every signed-in user has a `toolyard` integration (`TOOLYARD_MCP_INTEGRATION_ID`
in `packages/contracts/src/personalMcp.ts`): id and MCP server name `toolyard`,
so agents see `mcp__toolyard__*`; URL `TOOLYARD_MCP_URL`; bearer auth; always
enabled. `UserMcpProfileStore` presents it on every read and re-adds it to every
write, and `canonicalizePersonalMcpIntegration` pins its name, URL, auth mode
and enabled state, so a client can neither remove it nor point it elsewhere.
Its credential is written only by the connect flow; a credential a client sends
for it is ignored.

Connecting needs no pasted key. After sign-in the web app
(`fork/toolyardAutoConnect.tsx`, mounted from `AppRoot` because the Clerk shell
sits outside the atom registry) sees a profile whose toolyard entry has no
credential and calls `personalMcp.connectToolyard` once per app load with a
fresh Clerk session token from `state/teamIdentityToken`. The server
(`mcp/ToolyardConnect.ts`) posts `{"token"}` to
`POST <toolyard origin>/v1/connect/t3` and, on 200, stores the returned toolyard
agent token through `UserMcpProfileStore.setIntegrationCredential` with the
connected email and time. Neither token is logged or returned; the client gets
`{connected, email?, error?}`. toolyard rotates the agent token on every
successful call, which is why the client connects only while T3 holds none and
why Settings → Experiments → toolyard offers an explicit Reconnect instead of
reconnecting on its own. toolyard's refusals (`not_org_member`, `user_disabled`,
`agent_disabled`, …) come back as codes and are worded in
`fork/toolyardConnect.ts`; a code that list does not know still reaches the
client unchanged (the server accepts only `^[a-z_]{1,64}$` as a code).

Only a user-bound connection may connect, and only for itself: the server
refuses an unbound local/owner session (`not_signed_in`) and a token whose
`sub` is not the connection's actor (`identity_mismatch`; read without
verifying, toolyard verifies the signature), so a shared or paired session
cannot rotate someone's token into the shared `local-user` profile. Connects
for one user run one at a time (`mcp/PerUserLock.ts`), as do all profile
read-modify-writes inside `UserMcpProfileStore`.

A stored token can die outside T3: another T3 origin connecting through
toolyard's allowlist, the agent rotated or disabled on toolyard's Agents page.
When toolyard answers 401 twice in a row for the same stored token within ten
minutes (`UpstreamRejectionTracker`; one 401 can be a transient verification
error, and an accepted call in between forgets the first), the proxy calls
`retireIntegrationCredential` with the token it actually sent. The store
retires only if that is still the stored token — compare-and-swap under the
user's lock — so a Reconnect that raced an in-flight call keeps its new token.
Retiring removes the secret and marks toolyard unconnected (`connectedAt`
cleared), so the card reads "Not connected" and the next app load reconnects;
the agent's call still gets that 401. toolyard counts
as connected only while `connectedAt` is set, which only the connect flow
writes: a pre-existing hand-made `toolyard` entry is demoted on first read and
its stale secret removed.

Provider sessions include the toolyard proxy exactly when the user is connected
(`McpSessionRegistry` filters on `credentialConfigured`, like any integration);
`McpUpstreamProxy` adds the bearer token and `x-t3-session-id` toward toolyard.
Bifrost (bk-toolhub) stays alongside, always appended as `mcp__bifrost__*`, for
side-by-side testing.

`x-bf-vk` integrations are pinned to bk-toolhub alone (`BIFROST_GATEWAYS` has a
single entry). The earlier opt-in — any `x-bf-vk` integration pointed at
toolyard, whatever its id, with a toolyard key stored under that id — would now
canonicalize to bk-toolhub and send that key to the wrong gateway, so the store
retires any such stored entry on first read and drops it from any update,
secret included. The
Linear status fallback above is unchanged: it always posts to bk-toolhub with
the Bifrost key.

## Row change-request badge and settle-on-merge

The experimental sidebar row shows its PR next to the Linear tag:
`resolvePhaseSidebarChangeRequestBadge` in `PhaseGroupedSidebar.logic.ts` builds
it, `PhaseGroupedSidebar.tsx` renders it in the metadata lane.

- **The number is the whole label.** State is carried by colour alone — green
  open, violet merged, red closed — reusing the hues `prStatusIndicator` already
  applies in the thread header, so one PR never reads as two colours in one app.
- **Draft, mergeability, review, and checks stay in the tooltip** and the
  accessible name. They are modifiers on "open", not states; a hue each would
  make the densest lane in the app unreadable, and keeping them in the
  accessible name means state is never conveyed by colour alone.
- **Tagged links win over branch detection.** The badge reads the thread's
  `pullRequests` links first and only falls back to the branch probe when there
  are none. Branch detection only ever finds the review for the checked-out
  branch, so a PR an agent registered with `link_pull_request` — another
  repository, a stack layer, a review opened before the branch existed — was
  invisible in this lane until it happened to also be the branch's.
- **More than one review opens a list instead of a link.** A single review keeps
  the pull-request glyph and opens on click. Several unrelated reviews read
  `#1234 +2`; one chain reads the same but wears the layers glyph, so a stack is
  distinguishable from a pile at a glance. Either way the click opens a popover
  listing every tagged review, bottom of the stack first, each one coloured by
  its own state and opening on click — the badge never has to guess which
  review you meant.

Whether a merge settles a thread is upstream's `sidebarAutoSettleOnMerge`
setting (default on). The fork's own "a merge never settles" rewrite was retired
for it; the fork helpers left in `client-runtime/state/threadSettled.ts` exist
for the phase sidebar.

## Session titles

Titles are upstream's: the first user turn names the thread from its prompt, and
a `thread.meta.update` with a `title` records `titleState.source = "manual"`, so
generated names never replace a manual one. The fork's `titleOrigin` (command)
and `titleManuallySet` (event, read models) fields are gone; stored events that
still carry those keys decode unchanged because the schemas ignore unknown keys
(`decider.customGroup.test.ts` pins that). Migration 1013's `title_manually_set`
column stays in place, unused.

One fork seam remains: `t3_create_session` clips a title out of the first ten
words of the prompt and sends it as `titleSeed`, so the first turn treats it as a
placeholder and names the session. A title the caller passed explicitly is
theirs and is not seeded.

## Session identity environment

Every provider session spawns with additive environment variables naming the
people behind the turn, so an agent never has to infer them from the shared
machine:

| Variable                  | Value                                                                   |
| ------------------------- | ----------------------------------------------------------------------- |
| `BK_IDENTITY_RUNTIME`     | Always `t3-code`. Marks the runtime even when nobody could be resolved. |
| `BK_SESSION_OWNER_EMAIL`  | Primary email of the thread owner, from the environment-user directory. |
| `BK_MESSAGE_SENDER_EMAIL` | Primary email of the user who actually sent the message being answered. |

Four rules carry the behaviour:

- **The directory is the only source.** Git config, `whoami`, and checked-in
  dotfiles describe the machine; on a shared box they attribute one
  contributor's session to another, which is the bug this replaces.
- **The sender is never inferred.** Owner fallback is applied for credential
  binding, but `BK_MESSAGE_SENDER_EMAIL` is set only from a real sender. An
  absent variable means "unknown", and an agent must say so rather than guess.
- **Unresolvable identity degrades, never blocks.** A missing user record or an
  unreadable directory leaves the marker alone and the turn proceeds.
- **A changed identity restarts the provider.** The process reads its
  environment once at spawn, so `ProviderCommandReactor` fingerprints what each
  live session was started with and restarts on an owner transfer or a new
  sender, next to the existing credential-actor restart.

Claude Code's native system prompt normally derives `userEmail` from the
authenticated Claude account. That account is shared in the Beknown runtime, so
the Claude adapter appends the resolved `BK_MESSAGE_SENDER_EMAIL` as the
authoritative `userEmail`. When the sender is unresolved, the appended context
explicitly leaves `userEmail` unknown and forbids inference from the shared
Claude account, operating-system identity, or Git identity. Non-T3 Claude
sessions keep the upstream system prompt unchanged.

The CLI still emits its own `# userEmail` context section on every turn and
offers no switch to suppress it, so both branches of the appended block name
that section and countermand it explicitly: it reports the shared, rotating
subscription account, it does not identify the user, and it must be ignored for
user attribution. Naming it matters — the native section arrives later in
context than the appended block, and without the countermand a session answered
"who am I" with the rotated account holder while the appended block correctly
named the sender.

The countermand alone is not enough on smaller models. Verified against the
deployed build on 2026-08-21: Opus 5 answered "who am I" with the T3 sender,
but Sonnet 5 at medium effort failed 3/3 — it quoted the countermand block back
verbatim and still answered with the native `# userEmail` value. Position, not
wording, is what the model weighs, and the native section is a user-context
block that outranks anything written into the system prompt.

So the adapter also registers an SDK `UserPromptSubmit` hook that returns the
same identity as `additionalContext` on **every** turn, which lands at
user-message position and does win (Sonnet 5 medium, 2/2, including adversarial
prompt wording). `claudeSessionIdentityTurnContext` builds that text and
`withClaudeSessionIdentityTurnHook` folds the hook into the SDK query options,
merging with any hooks already registered rather than replacing them. The
system-prompt append stays as the belt to the hook's braces; both are gated on
`BK_IDENTITY_RUNTIME`, so upstream Claude sessions get neither. The identity
environment is read once at spawn and a changed sender already restarts the
provider, so the per-turn text cannot go stale.

The markers compose with source-control profiles rather than replacing them:
`mergeSourceControlEnvironment` scrubs the machine's inherited Git and GitHub
credentials only when the overlay carries a source-control identity of its own,
so machine-identity mode keeps its own `GH_TOKEN` while still carrying the
markers.

## Upstream merge workflow

1. Fetch and merge `upstream/main` into `expbkmain` — the long-lived staging
   branch — before feature work. Never test an upstream merge directly on
   `bkmain`; see [Beknown deployments](./deployments.md).
2. Resolve upstream-owned files by preserving the smallest marked seam. Prefer
   adapting dedicated custom files over expanding edits inside upstream files.
3. Regenerate the route tree when routes change by running the focused web build.
4. Run focused tests and type checks for changed packages.
5. Run the isolated `test-t3-app` browser pass for visible web changes.
6. Deploy only the verified commit through the experimental workflow, then
   promote it to `bkmain` through a pull request and reset `expbkmain` from
   `bkmain`.

`stage` takes upstream merges directly, the same way, and is verified at
`https://stagebkt3.dev.beknown.live`; the
[`merge-upstream`](../../.agents/skills/merge-upstream/SKILL.md) skill has the
full procedure.

When upstream adds an equivalent feature, compare behavior at the marked seam
and retire the custom implementation rather than maintaining two paths.
