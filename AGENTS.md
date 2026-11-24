# T3 Code

T3 Code is a minimal GUI for coding agents. A Node WebSocket server wraps provider CLIs and agents (Codex, Claude Code, Cursor, Grok, OpenCode, Antigravity, Kiro, Pi, Muse Code, fx) and serves web, desktop, and mobile clients.

You can think of T3 Code as an open source "bring-your-own-subscription" alternative to apps like Claude Desktop, Codex App, Cursor Glass and Conductor.

> **You are in the Beknown fork**, not upstream. Read "Beknown fork and deployments" and "Building features that survive upstream merges" below before writing code. Everything else in this file is upstream's guidance and still applies.

## Beknown fork and deployments

This repository is the Beknown fork of T3 Code (`origin` = `iamtushar324/bkt3code`, which the old `beknown-work/bkt3code` name redirects to; `upstream` = `pingdotgg/t3code`). Five environments run on the shared dev server, each from its own clone:

| Environment                        | Branch             | Worktree                             | Domain                       | Port  | Service               |
| ---------------------------------- | ------------------ | ------------------------------------ | ---------------------------- | ----- | --------------------- |
| t3 (upstream-style)                | `t3main`           | `/home/ubuntu/repos/t3code`          | `t3.dev.beknown.live`        | 18082 | `t3-beknown.service`  |
| bkt3 (fork production)             | `bkmain`           | `/home/ubuntu/repos/t3code-nextbkt3` | `bkt3.dev.beknown.live`      | 18087 | `t3-nextbkt3.service` |
| bkt3-bkp (old bkt3, frozen backup) | none (`7c0b134a7`) | `/home/ubuntu/repos/t3code-bkmain`   | `bkt3-bkp.dev.beknown.live`  | 18083 | `t3-bkmain.service`   |
| expbkt3 (fork staging)             | `expbkmain`        | `/home/ubuntu/repos/t3code-expbkt3`  | `expbkt3.dev.beknown.live`   | 18085 | `t3-expbkt3.service`  |
| stage (fresh-cut fork)             | `stage`            | `/home/ubuntu/repos/t3code-stage`    | `stagebkt3.dev.beknown.live` | 18086 | `t3-stage.service`    |

Branch semantics:

- `main` — byte-pure mirror of upstream. Never deployed, never carries fork commits. Pushing to it deploys nothing.
- `t3main` — `main` plus two fork-owned files: `.github/workflows/deploy-t3.yml` and a `.gitmodules` entry declaring the vendored alchemy gitlink so `actions/checkout` can clean credentials. Deploys t3.dev. Updated by merging `main` in; never force-pushed.
- `bkmain` — the fork's production line. Deploys bkt3. All fork work merges here through pull requests.
- `expbkmain` — long-lived staging branch for drastic changes, above all upstream merges. Deploys expbkt3, and is reset from `bkmain` between experiments.
- `stage` — a fresh cut of upstream `main` (`de251fc29`, 2026-09-27) carrying only the fork features still in use, each behind the smallest seam. On 2026-10-09 `bkmain` was fast-forwarded to it and bkt3 production moved to the stage code on a cleaned copy of the old database; `bkmain` and `stage` were identical at that point. It deploys like the others, through `.github/workflows/deploy-stage.yml` and the systemd timer; what it kept and dropped is in [expbkt3 customization boundaries](./docs/operations/expbkt3-customizations.md#stage-cut-2026-09-27).

Coding sessions always run on the bkt3 instance, in worktrees under `/home/ubuntu/.t3/nextbkt3-dev/worktrees/`. Do not start work in a deployment worktree; those are checkouts the deploy scripts fast-forward.

How to update an environment: merge to its branch. The branch's GitHub Actions workflow validates and uploads a SHA-addressed build artifact, and a systemd timer on the box installs that exact artifact within a minute of the run turning green. Application code is never built on the server. Full detail, manual deploy commands, and the upstream-merge workflow are in [docs/operations/deployments.md](./docs/operations/deployments.md).

Deploying restarts the target service, which **kills the agent sessions hosted on it** — a bkt3 deploy ends the session that triggered it and interrupts every other in-flight turn on bkt3. Trigger manual deploys from the other instance or from a human shell, and warn the user before merging to `bkmain`.

**Ship to `expbkmain` first.** Every fork change — features, not just upstream merges — goes to `expbkmain` and is verified running at expbkt3.dev.beknown.live before it merges to `bkmain`. bkt3 hosts the team's live coding sessions, so a regression there interrupts real work, and the failure modes that matter most (migrations against an existing database, startup ordering, provider processes) only appear on a real deploy. expbkt3 is cheap to break: reset it from `bkmain`, merge the branch, wait for the timer, and exercise the change in the browser. Only then open or merge the `bkmain` PR.

**Merging to `expbkmain` is pre-authorised, and you own it until it is live.** You do
not need to ask before merging a green PR to `expbkmain` — merge it, then stay on it:
watch the branch workflow, wait for the systemd timer to install the artifact, and
confirm the running service is on the merge SHA. Report once, when it is deployed, not
when it is merged. "Merged" is not a delivery; the reviewer cannot verify anything until
expbkt3 is actually serving the new build, and a build or install can still fail after a
green PR. Ground truth is `/home/ubuntu/.t3/expbkt3-dev/deployed-sha` matching the merge
commit, plus `t3-expbkt3.service` active. This authorisation covers `expbkmain`, and
`stage` for the Manager session below, only — `bkmain` still needs a human, because
deploying it kills the team's live sessions.

**Tushar's Manager session may merge to `stage` by its own judgement.** Tushar's Manager
session (the bk-docs `manager` skill, `tushar` child) may merge a green PR into `stage`
without a further ask, once CI is green and the change is reviewed. It then owns the
change until it is live: it verifies it running on stagebkt3.dev.beknown.live, the same
way as the `expbkmain` rule above. A merge or promotion to `bkmain` still needs Tushar.
The Manager asks once, as one item on its batched Toolyard decision card, because a
`bkmain` deploy restarts bkt3 and stops the live sessions; Tushar then picks the time.
(Tushar, 2026-10-23.)

## Building features that survive upstream merges

We track a fast-moving upstream. Every line this fork changes inside an upstream-owned file is a line that has to be re-resolved, by hand, on every future merge — and a merge that touches 25 files of core code costs a day and risks silently dropping fork behavior. Cost is driven by _where_ we write code far more than by how much we write.

**Nudge the developer toward these when a change starts editing upstream files.** Say it plainly: "this can be built as an additive module instead of editing `ChatView.tsx`; that keeps the next upstream merge cheap." If they still want the inline edit, do it — just make the seam as small as possible and mark it.

Ranked from cheapest to most expensive to maintain:

1. **New files in fork-owned directories.** A feature living in its own module or package costs nothing at merge time — git has no competing change to reconcile. Prefer a new `apps/server/src/workspace-groups/` over threading logic through `server.ts`.
2. **One call site in an upstream file, delegating to fork code.** If upstream code must invoke ours, aim for a single import plus a single line, not logic scattered through the file. One-line conflicts resolve in seconds; interleaved ones need real thought.
3. **Composition over modification.** Wrap an upstream component rather than editing it. Render `<ForkFeature><UpstreamThing /></ForkFeature>` instead of adding branches inside `UpstreamThing`.
4. **Configuration and feature flags over branching.** Fork behavior gated by a flag (`VITE_T3_EXPERIMENTAL_CONTROL_CENTER`, a server setting) keeps upstream's code path intact and lets us disable our feature to isolate a regression after a merge.
5. **Additive schema changes.** Add fields and new union members; avoid renaming or reordering upstream ones. Renames conflict with every upstream change to the same symbol.
6. **Number fork database migrations from 1000 up.** Upstream keeps the low numbers, so its migrations land at their own index and merges stop being a judgment call. Applied migrations are keyed by `${id}_${name}` in `effect_sql_migrations`, so renumbering one that already ran makes it run a second time on live data — indices 33-42 are a frozen legacy fork block for exactly that reason. The full allocation rule sits above the registry in `apps/server/src/persistence/Migrations.ts`; apply it mechanically instead of re-deriving it.

Rules that apply regardless of approach:

- **Prefer the bridge to the fork.** New automation belongs in `t3-linear-bridge` (the Go control plane on the same host), not in this repo. It already has the seams: a durable outbox action switch, worker-loop registration, webhook inbox lanes, and hot-reloading managed config — and it talks to T3 only through `/api/orchestration/shell` and `/api/orchestration/dispatch`, so it costs zero merge surface. Fork this repo only when the feature genuinely needs one of: UI, new per-session storage, or an in-process hook into the provider/orchestration layers. Poll latency (~2s) is the bridge's one real limitation; weigh that before choosing the fork.
- **Mark every fork edit inside an upstream file** with a `T3-CUSTOM(expbkt3)` comment, so the seam is greppable during a merge and reviewable afterwards. This is enforced in CI by `scripts/check-fork-markers.ts` (workflow: `.github/workflows/fork-markers.yml`), which fails a PR that adds unmarked hunks to an upstream-owned file. `scripts/fork-marker-baseline.json` grandfathers the existing backlog and is a ratchet — it may shrink, never grow. See [expbkt3 customization boundaries](./docs/operations/expbkt3-customizations.md).
- **Never reformat, reorder, or opportunistically refactor upstream code.** A moved import or re-wrapped line produces a conflict with zero product value. Keep diffs minimal and local — this is the single cheapest discipline available.
- **Cover fork behavior with tests in fork-owned test files.** After a merge, those tests are the only thing that proves a customization survived conflict resolution.
- **Upstream anything generally useful.** A fix accepted upstream is a fix we stop re-merging forever; it converts a permanent tax into a one-time contribution. Bug fixes and small primitives are usually welcome upstream — check before building the fork-only version.
- **Merge upstream often, in small batches.** Conflict pain grows faster than linearly with the size of the delta: two 15-commit merges are far cheaper than one 30-commit merge, because each conflict is reasoned about with less surrounding drift. Treat a monthly cadence as the ceiling, not the target. The end-to-end procedure — mirror sync, measuring the conflict surface, resolution rules, and the post-merge CI failures that recur every time — is the [`merge-upstream`](./.agents/skills/merge-upstream/SKILL.md) skill. Follow it rather than re-deriving the steps.
- **A fork edit that _relocates_ upstream code is the most dangerous kind.** When the fork moves a block into its own module, a later upstream fix to that block arrives as a conflict-free change to a region the fork no longer has — git keeps the "deletion" and the fix silently never lands. Nothing catches this: it typechecks, and upstream's regression test for it usually lives in the file the fork stopped using. A 2026-08 merge lost upstream's "no origin remote" bootstrap fallback exactly this way. Prefer wrapping over relocating, and when reviewing a merge, diff the upstream side of any relocated block by hand.
- **Never rebase the fork branches onto upstream.** `bkmain`, `expbkmain`, and `stage` are long-lived and shared; merging preserves the record of how each conflict was resolved, and rebasing re-inflicts every conflict and rewrites published history.
- **`git rerere` is enabled in this repo** (`rerere.enabled=true`), so a conflict resolved once is replayed automatically the next time the same hunk collides. Never resolve a conflict by discarding one side wholesale just to make it go away — a bad resolution gets replayed too. Verify what rerere auto-resolved before committing a merge.
- **Test upstream merges on `expbkmain` first**, never directly on `bkmain`. Reset `expbkmain` from `bkmain` so its conflicts are exactly the ones `bkmain` will see, verify at expbkt3.dev, then promote.

## Server code must scale with bkt3's database

bkt3 is far bigger than a typical install: a 16 GB `statev2.sqlite`, about 1,800 threads (half of them archived), 20+ live provider sessions and several Claude accounts that are often full. The server runs on one event loop with synchronous `node:sqlite`, so every query, decode and subprocess spawn on the main thread pauses every client. Code that is instant on a dev database froze bkt3 for 2-13 s at a time (#164 in September 2026, then #325/#326, #328 and #338 in October). Before merging server code, check it against these rules:

1. **No all-threads reads on a hot path.** A full shell snapshot (`getShellSnapshot`, `readShellSnapshot`) or a loop over every thread costs about 2 s on bkt3. Never run one per event, per turn end, per connection, per account change, or on a timer. Read the narrowest thing that answers the question: one thread (`getThreadShell`), live sessions from memory (`ProviderSessionManager.listLive`, which is optional, so keep a fallback), or an indexed query that selects the few rows you need. Full snapshots are for rare, user-triggered requests only.
2. **Cheap checks first.** Run in-memory guards (is there room elsewhere, is the feature on, has anything changed) before any database read, so the common no-op case costs nothing. `ClaudeAccountsService.maybeRebalance` read every session twice per turn end before it checked whether another account had room (#338).
3. **Every query seeks an index.** `run_id IN (...) OR (? = 1 AND run_id IS NULL)` silently scans (#326; use `INDEXED BY` or split the query). `orchestration_events` lookups need `aggregate_kind` with the stream id (#164). Check new queries with `EXPLAIN QUERY PLAN` against a copy of real data (see Test data).
4. **No subprocess per thread.** Linux `fork()` of the ~1.5 GB server costs about 30 ms of main thread, even for a cached git call. A sweep that spawns per thread is a freeze: rotate idle threads, cache results, and spawn only for threads that changed (#325).
5. **Count calls in tests.** A focused test for a hot-path change asserts how many reads a trigger costs (for example, a turn end on a full account makes zero `listSessions` calls), not only the result. Wall-clock checks belong on a real-data copy, not in CI.
6. **Check production after the deploy.** Count `event loop stalled` warnings with `journalctl -u t3-nextbkt3.service`, probe `GET /.well-known/t3/environment` every 250 ms, and compare with the hours before the deploy. The server trace keeps only a few minutes, so capture a stall while it happens.

## What makes T3 Code special?

We have over 500,000 users who love T3 Code. It's important we maintain the things they love as we continue to iterate on the product. Here's a brief list of the things we can never compromise on.

### 1. Open at the core

T3 Code is truly open. We share our roadmap, we share how we think about things, and of course we share all our code. A large number of our users run forks (our MIT license covers source code only, not T3 Code's trademarks or branding; see [TRADEMARK.md](TRADEMARK.md)). We work in the open, and should strive to stay that way.

### 2. Performance without compromise

Lots of apps have gotten bogged down with bad tech decisions and "slop". We have not, and we're proud of the performance of T3 Code. We regularly audit for performance regressions, often caused by sending too much data over websockets, css animations causing gpu spikes, lists being hard to render, and more. Make sure all changes are considerate of performance impact.

### 3. Remote ready

The architecture of T3 Code's websocket layer (`t3`) enables a lot of awesome remote features. These have become core to the product. Whether users are connecting directly over their local network, using Tailscale, or leaning in fully with T3 Connect (our tunnel solution, also in this repo), we need to make sure new features are properly supported.

### 4. Multi-surface

T3 Code has 3 key app surfaces: **web**, **desktop**, and **mobile**.

**Web** is kind of two surfaces, as we have the public facing "app.t3.codes" as well as locally hosting the web app through the `t3` command. Both need to be supported by all new features where reasonable.

**Desktop** is the main surface most users install first. It's a full Electron app that bundles the server runner as well. The desktop app can also be used as the host server, allowing remote connections from app.t3.codes or the mobile app.

**Mobile** is a React Native app for both iOS and Android, available on the App Store and Google Play. The mobile app allows for connecting to any T3 Code server to control work remotely.

## A note from Theo

I like ambitious ideas, simple systems, and software that feels obvious. Do not preserve complexity just because it already exists. Do not introduce machinery because it looks architecturally impressive. Understand the real constraint, then fight for the smallest model that makes the correct behavior unsurprising.

Channel both "measure twice, cut once" and "yagni". Fight scope creep. Try to honor the dev's intent in both a minimal and realistic fashion.

The rest of this document is meant to help you navigate the codebase and make changes effectively. Think of these instructions less as "hard rules", more as "good defaults". The developer's preferences should be able to override anything here.

Of note: Most T3 Code contributions will come from T3 Code itself, often controlled remotely. This means you should be careful about accessing data, killing dev servers, and other things that may damage the T3 Code instance that the contributor is using.

## Terminology

- **you** = the agent reading this file. **we / us / maintainers** = Theo, Julius, and the people building T3 Code. **user** = person driving coding agents in T3 Code. **agent** = coding agent running inside T3 Code.
- Domain terms (environment, project, thread, turn, provider, checkpoint, etc.): [00_glossary.md](docs/internals/00_glossary.md).

## The three ways to hurt yourself

1. **Killing by pattern.** Never `pkill -f`, `pgrep | kill`, or `kill` a PID you found by matching a name, path, or worktree string. Your own agent process has this worktree's path in its argv, and this machine runs several other dev servers at once. Kill only a PID you captured at spawn, or the owner of your port from `ss -H -ltnp` after confirming `/proc/<pid>/cwd` is your worktree.
2. **Writing to the live install.** `~/.t3/userdata` is the developer's real T3 Code database, in use while you work. Reading or copying from it is fine. Never start a server against it, never open it read-write, never clean it up.
3. **Baking in origins.** Never set `VITE_HTTP_URL` or `VITE_WS_URL` for dev. Dev is single-origin and Vite proxies `/api`, `/ws`, `/oauth`, and `/.well-known`. Setting them bakes localhost into the bundle and silently breaks every remote browser.

## Hit every surface

The most common defect in this repo is a change that works on the path you tested and is missing everywhere else. Before calling frontend work done, walk this list and say which entries applied:

- **Entry points.** Chat view, Settings, command palette, and keybindings. Fixing one is not fixing the feature.
- **Clients.** Web, desktop (Electron shell/IPC), and mobile (React Native). Shared logic lives in `packages/client-runtime`.
- **Providers.** Every provider adapter needs a decision, even if the decision is "not supported here".
- **Agents.** Capabilities a user triggers should be service methods reachable by MCP tools and scheduled tasks, not inline handler code.
- **Contracts.** Wire changes go in `packages/contracts` so server, web, mobile, and desktop follow.
- **Reverse states.** Every way in needs a way out and a way to see it (snooze/unsnooze, close/reopen). A one-way door is a bug.
- **Connection modes.** Local, remote/relay, and tunnel; multi-device and multi-environment.
- **Languages.** Translate user-facing copy in `apps/{web,mobile}/src/i18n/translations` (`vp run i18n:generate` / `vp run i18n:check`) and `apps/marketing/src/i18n`. See [14_i18n.md](docs/internals/14_i18n.md).
- **Docs.** Check whether the change makes existing guidance inaccurate. Follow [Documentation](#documentation).

## Dev servers and test data

See [00_development.md](docs/operations/00_development.md) for setup, ports, seeding (`vp run migrate-dev-db`), and [reusable dev auth](docs/operations/00_development.md#reusable-dev-credential). Agent-specific rules:

- **Worktree setup:** Wait while `.t3/setup-running` names a live PID; do not run `vp i` concurrently. If no `.t3/setup-*` marker exists, run `vp i` yourself.
- **Process lifecycle:** Start dev servers, Metro, and builds from your own shell so they exit with your session—never detach with `systemd-run`, `nohup`, `setsid`, or `tmux` unless asked. Stop background tasks with your harness's own stop (`vp` does not forward SIGTERM to child Vite/server processes).
- **Sharing (`vp run dev --share`):** Wait for `pairingUrl:` and hand the full URL to the user. Never wire `tailscale serve` by hand, open the URL yourself, or consume the user's one-time pairing link. Mint another with `node apps/server/src/bin.ts pair` if needed.
- **Test data:** Always copy in (never symlink) and refresh `statev2.sqlite`, not `state.sqlite`. Bring `secrets` / `settings.json` only if the flow under test needs them.
- **Extra checkouts:** Put `git worktree add` next to this worktree, not in `/tmp`, and remove it when done.

## Verifying

- Before you push, run `vp run check:changed`. **Do not run repo-wide checks** (`vp check`, `vp run -r test`, `vp run -r typecheck`) unless asked—CI owns the full suite.
  - In the Beknown fork this is a hard rule, not a preference: the dev server is shared by both T3 Code deployments, every agent session, branch databases, and self-hosted runners, and full-suite runs have OOM-crashed it. Never run a repo-wide build either — deployments install GitHub-built artifacts, so nothing needs building here.
  - The loop is: push the branch, open the PR, watch CI remotely with `gh pr checks <n> --watch` and `gh run view <id> --log-failed`, then push fixes from this box. The fork's deploy workflows run on GitHub-hosted `ubuntu-latest`, so they are real offload.
  - Check headroom with `free -g` and `uptime` before anything long. Under ~6G available or load above ~12, move the work to CI instead.
- Iterate with `vp test run <files>` (add `-t "<name>"` for large files) and `vp run typecheck` (`effect-tsgo tsrs --noEmit`). Run `node -e` snippets from the owning package (`effect` does not resolve from repo root).
- Follow [15_testing.md](docs/internals/15_testing.md) for what to test, bug-fix proof, draining async work (no sleeps/polling), web browser tests (`await using screen = await render(...)`), and real-app [Scenarios](docs/internals/15_testing.md#scenarios) (`vp run scenarios:prove`).
- Give user-visible frontend changes one integrated pass in a real client: `test-t3-app` for web, `test-t3-mobile` for mobile (primary agent only; subagents do not launch dev servers). Inspect the rendered result and walk the flow as a user using the feature—checking layout, visual hierarchy, and ergonomics—and fix anything rough until you are satisfied before handing back. Use the free `Replay (dev)` provider unless the change depends on a real provider (then pick its cheapest model, e.g. Haiku or Luna). On mobile, run `vp run mobile:install <ios|android> [device-id]` before Metro rather than rebuilding from scratch.

## Evals

`evals/` checks how real models behave with T3 Code's model-facing text: agent instructions, MCP tool descriptions and schemas, and generated titles. Before changing that text, read [evals/README.md](evals/README.md) and run the evals it names. When fixing a model behavior bug, add a case that fails before the fix.

## Pull requests

- Never make a PR unless the developer explicitly asks you to do so.
- Merging a green PR into `expbkmain` needs no further ask, but it is not finished at
  merge: follow it through the deploy and report only once expbkt3 is serving it. See
  "Beknown fork and deployments". Tushar's Manager session may also merge a green,
  reviewed PR into `stage` by its own judgement, then verify it on stagebkt3. Merging to
  `bkmain` still needs a human (for the Manager: one item on its batched Toolyard
  decision card).
- `origin` is not always GitHub. Check `git remote get-url origin` before your first forge command and use that forge's CLI and skill. See [Forge mirror](docs/operations/00_development.md#forge-mirror-optional).
- Conventional commit titles, plain language: `fix(web): new threads no longer spike CPU`.
- Body: the problem in a sentence or two, then how you fixed it. End with the model and harness that did the work.
- UI changes need before/after images; motion or timing needs a short video. Upload PR evidence to GitHub—never commit PR-only screenshots or assets.
- One request is one PR. Split only when asked. Outside contributions follow [CONTRIBUTING.md](CONTRIBUTING.md#one-problem).
- When babysitting: call `watch_pull_request` and end your turn. Do not poll or sleep. Verify each bot finding against the source, fix real ones, dismiss false positives with a written reason. Stay quiet when nothing is new; stop when bots are green on the latest commit.

## Documentation

Most code changes do not need an internal documentation change. Agents can read the code.

- `docs/internals/` is for architectural decisions and their reasons, constraints that span components, and implementation traps that are hard to discover from the source. Before adding a paragraph, ask what a maintainer would get wrong without it. If reading the relevant code answers the question, leave it out.
- Do not document every feature, enumerate fields, methods, constants, timeouts, or migration numbers, narrate control flow, maintain file catalogs, or append PR summaries. Anything that can drift will drift; types, tests, and code already record the implementation. The glossary defines shared vocabulary; it is not a feature index.
- A local reason the code can't show goes in a short nearby code comment. Use an internal doc when the reasoning crosses boundaries or needs context the code cannot carry well. Link to the relevant source instead of copying it.
- When a documented decision or constraint changes, rewrite or remove the affected text. Do not append another account of the new behavior. A new internal page needs a distinct, durable reason to exist.
- `docs/user/` helps users accomplish tasks in the shipped product's voice, without implementation details or contributor tooling. Focus on what a feature does, how to start, and anything unintuitive—not descriptions of buttons, layouts, or UI tweaks.
- `docs/operations/` holds maintainer setup, release, and debugging runbooks. Keep end-user server instructions in `docs/user/`.

## Plans and work artifacts

- Do not commit implementation plans, research notes, or agent scratch files (keep temporary material outside the worktree).
- Track active maintainer work in its GitHub issue or project item; external proposals belong in Ideas discussions. A merged PR is the implementation record.

## Where code lives

- `apps/server` - WebSocket, event-sourced orchestration (`Orchestrator` → `EventSink` → `EffectWorker`), providers, checkpointing. Read [02_effect-services.md](docs/internals/02_effect-services.md) and `.repos/effect/LLMS.md`.
- `apps/web` - React/Vite UI. `apps/desktop` wraps it; `apps/mobile` is React Native; `apps/marketing` is the site.
- `packages/contracts` - Effect/Schema wire contracts plus small derived helpers. No heavy runtime logic.
- `packages/shared` - shared runtime utils, subpath exports, no barrel.
- `packages/client-runtime` - client connection and domain state shared by web and mobile.
- `.repos/` - vendored read-only references. Never edit or import from them (`vpr sync:repos` updates them; if sparse-checked-out, read via `git show origin/main:.repos/<path>`).

### Internal docs by area

Read the matching doc before changing code in that area; code review enforces them.

| Area                                       | Read first                                                                                                                                                                                        |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Architecture & orchestration               | [00_glossary.md](docs/internals/00_glossary.md), [01_architecture.md](docs/internals/01_architecture.md)                                                                                          |
| Server Effect services & errors            | [02_effect-services.md](docs/internals/02_effect-services.md)                                                                                                                                     |
| Providers & ACP                            | [03_providers.md](docs/internals/03_providers.md)                                                                                                                                                 |
| Auth, MCP, guest links, assets, security   | [04_environment-auth.md](docs/internals/04_environment-auth.md), [SECURITY.md](SECURITY.md)                                                                                                       |
| Remote routes, peer links, previews        | [05_remote.md](docs/internals/05_remote.md)                                                                                                                                                       |
| T3 Connect & relay                         | [06_t3-connect.md](docs/internals/06_t3-connect.md)                                                                                                                                               |
| Server updates & crash recovery            | [07_server-updates.md](docs/internals/07_server-updates.md)                                                                                                                                       |
| Telemetry & analytics                      | [08_product-analytics.md](docs/internals/08_product-analytics.md)                                                                                                                                 |
| Client connection & sync runtime           | [09_connection-runtime.md](docs/internals/09_connection-runtime.md)                                                                                                                               |
| Web UI primitives, styles & React Compiler | [10_web-ui.md](docs/internals/10_web-ui.md)                                                                                                                                                       |
| Mobile layout, navigation & dev lifecycle  | [11_mobile-layout.md](docs/internals/11_mobile-layout.md), [12_mobile-navigation.md](docs/internals/12_mobile-navigation.md), [13_mobile-development.md](docs/internals/13_mobile-development.md) |
| Translations & UI copy                     | [14_i18n.md](docs/internals/14_i18n.md)                                                                                                                                                           |
| Writing & reviewing tests                  | [15_testing.md](docs/internals/15_testing.md)                                                                                                                                                     |
| Wire budgets, server metrics & perf        | [16_performance-regressions.md](docs/internals/16_performance-regressions.md)                                                                                                                     |
| Repo & package scripts                     | [17_scripts.md](docs/internals/17_scripts.md)                                                                                                                                                     |

## Taste

- Complexity belongs at the adapter boundary. Orchestration stays pure, UI stays dumb.
- Client mutations use `createEnvironmentRpcCommand`, declare protected methods in `CLIENT_GUARDED_RPC_SCOPES`, and gate UI with `permissionAtom` (server stays authoritative). Keep raw RPC clients inside `rpc/`.
- Server features are Effect services using `Effect.fn("Service.operation")` with thin transport handlers; see [02_effect-services.md](docs/internals/02_effect-services.md).
- `apps/web/src/components/ui` exports own their look (`shadcn/no-restyle` enforces this); see [10_web-ui.md](docs/internals/10_web-ui.md).
- Inferred types over annotations. `any` is the enemy.
- Default to no comment. Write one only for a constraint, external quirk, or invariant the code can't show (1–4 lines max; `t3code/no-low-value-comments` enforces this).
- React effects are only for synchronizing with external systems. Derive in render and act in handlers; any remaining effect states its reason via `// oxlint-disable-next-line t3code/no-unreasoned-state-sync -- <why>`.
- No continuously repainting animations; they peg the GPU on high-refresh displays.
- Security matters, but do not over-index on dev-mode or maintainer-only features. Read [SECURITY.md](SECURITY.md) before auditing or triaging reports.
- If a rule here fights the task in front of you, say so loudly and get a human sign-off before breaking it.
