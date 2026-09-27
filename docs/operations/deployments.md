# Beknown deployments

Three T3 Code environments run on the shared dev server `dev-server-1`
(`ip-10-31-39-131`, 16 vCPU / 30G RAM). This document is the operational
reference for all three: what they are, how code reaches them, and how to change
them safely.

## Environments

| Environment            | Branch      | Worktree                            | Domain                                          | Port  | Service              | State dir                      |
| ---------------------- | ----------- | ----------------------------------- | ----------------------------------------------- | ----- | -------------------- | ------------------------------ |
| t3 (upstream-style)    | `t3main`    | `/home/ubuntu/repos/t3code`         | `t3.dev.beknown.live`                           | 18082 | `t3-beknown.service` | `/home/ubuntu/.t3/beknown-dev` |
| bkt3 (fork production) | `bkmain`    | `/home/ubuntu/repos/t3code-bkmain`  | `bkt3.dev.beknown.live`                         | 18083 | `t3-bkmain.service`  | `/home/ubuntu/.t3/bkt3-dev`    |
| expbkt3 (fork staging) | `expbkmain` | `/home/ubuntu/repos/t3code-expbkt3` | `expbkt3.dev.beknown.live` (apex `expbkt3.dev`) | 18085 | `t3-expbkt3.service` | `/home/ubuntu/.t3/expbkt3-dev` |

Per-environment detail lives next to the scripts: [`deploy/t3/README.md`](../../deploy/t3/README.md),
[`deploy/bkt3/README.md`](../../deploy/bkt3/README.md),
[`deploy/expbkt3/README.md`](../../deploy/expbkt3/README.md).

### One repository, three worktrees

`/home/ubuntu/repos/t3code` holds the only real `.git` directory. The other two
checkouts are linked git worktrees sharing its object store, so a commit fetched
in one is immediately visible in the others. Because a branch can only be
checked out in one worktree at a time, each environment owns its branch
exclusively.

Remotes: `origin` = `git@github.com:beknown-work/bkt3code.git` (the fork; the old
`beknown-work/t3code` name 404s), `upstream` = `git@github.com:pingdotgg/t3code.git`.

### Branch semantics

- **`main`** — byte-pure mirror of upstream `pingdotgg/t3code`. Never deployed,
  never carries fork commits. A push to `main` alone deploys nothing.
- **`t3main`** — `main` plus two fork-owned files:
  `.github/workflows/deploy-t3.yml` and a `.gitmodules` entry. Deploys `t3.dev`.
  Kept in sync by merging `main` into it; never force-pushed.
  - The `.gitmodules` entry declares the nested gitlink at
    `.repos/alchemy-effect/.vendor/alchemy`, which upstream leaves undeclared.
    Without it `actions/checkout` aborts while cleaning credentials
    (`git submodule foreach --recursive` → `No url found for submodule path`).
    Sparse-checkout does not help, because `foreach` reads the index rather than
    the working tree. `bkmain` carries the same entry; it describes the gitlink
    without initializing or changing the vendored subtree.
- **`bkmain`** — the Beknown fork's production line. Deploys `bkt3.dev`. All
  fork work merges here through pull requests.
- **`expbkmain`** — long-lived staging branch for drastic changes, above all
  upstream merges. Deploys `expbkt3.dev`. Reset from `bkmain` between
  experiments, so it never disappears from `origin` (a deleted trigger branch
  used to make the deployment timer fail every minute).

## How code reaches a server

Deployment is **pull-based**. No workflow holds SSH or Tailscale credentials for
this box, and no GitHub-hosted runner reaches it.

1. A push lands on `t3main`, `bkmain`, or `expbkmain`.
2. That branch's workflow runs on GitHub-hosted `ubuntu-latest`: install, lint,
   typecheck, test, build web + server, then upload a SHA-addressed artifact
   (`t3-<sha>`, `bkt3-<sha>`, `expbkt3-<sha>`) containing `apps/web/dist`,
   `apps/server/dist`, and a `SHA` file.
3. On the box, a systemd timer (`t3-beknown-deploy.timer`,
   `t3-bkmain-deploy.timer`, `t3-expbkt3-deploy.timer`) fires once a minute and
   runs that environment's `auto-deploy.sh`. It fetches the branch head and asks
   the GitHub Actions API whether a run exists for that **exact** commit.
   Unfinished or unreachable → defer and retry next tick. Failed → refuse.
4. On success, `deploy.sh` takes a `flock`, refuses a wrong branch or dirty
   worktree, fast-forwards, downloads and verifies the artifact (SHA match plus
   presence of `index.html` and `bin.mjs`), backs up the current `dist`
   directories, `rsync --delete`s the new ones into place, restarts the service,
   and health-checks the private port. A failed health check restores the backup
   and restarts again.
5. The deployed commit is recorded in `<state-dir>/deployed-sha`, separately from
   the worktree HEAD.

The artifact carries only `apps/web/dist` and `apps/server/dist`. The server
bundle resolves its runtime dependencies from `node_modules` on the host, so
`deploy.sh` runs `pnpm install --frozen-lockfile` whenever `pnpm-lock.yaml`
changes (tracked by hash in `<state-dir>/deployed-lock`). Without that step a
dependency bump ships a new bundle against old packages and the service crashes
on start — an upstream `effect` bump did exactly that, and the health check
rolled it back every minute. Installing packages is not building application
code.

**Application code is never built on this server.** The dev-server compute policy
forbids repo-wide installs, builds, and test suites here; they have OOM-crashed
the box. CI builds the artifact, the host only installs it.

For `t3main` and `expbkmain`, CI also resolves the upstream nightly tag that
points at the integrated upstream tip and temporarily aligns the web, server,
desktop, and contracts package versions before validation and build. This keeps
the byte-pure `main` mirror unchanged while the deployed UI and server report
the matching nightly version. When the integrated upstream tip is ahead of its
closest upstream nightly tag, the experimental workflow derives a SemVer
prerelease such as `0.0.39-nightly.20260905.1286.upstream.gbe7796d867a1`.
The tag portion identifies the nearest released ancestor and the `g`-prefixed
suffix identifies the exact integrated upstream commit; an exact tag remains
unchanged. CI still fails closed when it cannot find a nightly ancestor or the
nearest nightly tag is invalid, instead of publishing an artifact labeled as a
prior exact release.

### Restarting a service kills its agent sessions

Agent sessions run as children of the service whose state directory holds their
worktree (check with `cat /proc/$$/cgroup`):

- worktree under `/home/ubuntu/.t3/bkt3-dev/worktrees/` → child of `t3-bkmain.service`
- worktree under `/home/ubuntu/.t3/beknown-dev/` → child of `t3-beknown.service`

So a bkt3 deploy interrupts every in-flight turn on bkt3, including the session
that triggered it. Trigger a manual deploy from the _other_ instance or from a
human shell. The same applies to the automatic timer: merging to `bkmain`
restarts bkt3 about a minute after CI goes green.

Corollary: if `auto-deploy.sh` itself is broken, the timer can never ship its own
fix, because the deployment checkout is only fast-forwarded inside `deploy.sh`.
Break that deadlock with one manual deploy.

## Host-only dependencies

These exist on the box and are not in the repository:

- **Clerk secrets** — `clerk.conf` systemd drop-ins under
  `/etc/systemd/system/<unit>.d/`, sourcing `EnvironmentFile=-/home/ubuntu/.t3/<state-dir>/clerk.env`.
  Reinstalling a unit file does not remove drop-ins, but `systemctl revert` does.
  These cover the **server runtime only**. `VITE_CLERK_PUBLISHABLE_KEY` is baked
  into the SPA at build time, and builds now run in CI, so it comes from the
  `VITE_CLERK_PUBLISHABLE_KEY` Actions variable instead — see the "Build web
  client" step in each deploy workflow. Drop it and team mode goes silently off
  in the browser (no sign-in gate, no member tagging) while the server stays in
  team mode; the page still loads, so nothing fails loudly. Any future
  `VITE_`-prefixed setting on this box has the same split.
- **Linear status bridge token** — `bridge.conf` systemd drop-ins under
  `/etc/systemd/system/<unit>.d/`, setting `BRIDGE_SERVICE_TOKEN` to the value in
  `/home/ubuntu/.config/t3-linear-bridge-next/bridge.env` (the bridge's own
  config, which is where to re-read it from after a rebuild). With it, sidebar
  Linear status comes from the bridge's webhook projection in one batched call;
  without it the server silently falls back to one Bifrost round trip per issue
  per viewer, which is slow enough to be visible. Unset is a supported state, so
  nothing fails loudly when it is missing.
- **Memory limits** — applied with `systemctl set-property`, persisted under
  `/etc/systemd/system.control/<unit>.d/`. These _override_ the values committed
  in the unit files, so check the live value with
  `systemctl show <unit> -p MemoryHigh -p MemoryMax` rather than trusting the
  repo copy.
- **`gh` authentication** — `deploy.sh` downloads artifacts as the `ubuntu` user
  via `gh run download`; verify with `gh auth status`.
- **Traefik / Docker Swarm routing** — each domain is served by an
  `alpine/socat` swarm service (`t3-proxy`, `bkt3-proxy`, `expbkt3-proxy`) on the
  `bk-dev` network carrying the Traefik router labels, fronted by
  `beknown-dev_traefik`. There is no nginx or caddy on this host. Each
  environment's `proxy.sh` recreates its service idempotently.

## Common operations

Check what is deployed:

```bash
systemctl status t3-bkmain-deploy.timer
journalctl -u t3-bkmain-deploy.service -n 20 --no-pager
cat /home/ubuntu/.t3/bkt3-dev/deployed-sha
git ls-remote origin bkmain
```

Ship a fork change: **stage it on `expbkmain` first**, verify it running at
`https://expbkt3.dev.beknown.live`, then open a PR against `bkmain`, let CI
verify it, and merge. The timer deploys within a minute of the merge commit's
run turning green.

```bash
git push origin <topic-branch>:refs/heads/expbkmain   # or --force-with-lease
```

This applies to ordinary features, not only to upstream merges and risky
refactors. bkt3 hosts the team's live coding sessions, so a regression there
interrupts real work — and the failures that matter most (migrations meeting an
existing database, startup ordering, provider process lifecycle) only surface on
a real deploy. expbkt3 is disposable: it is reset from `bkmain` between
experiments.

After the `bkmain` PR merges, reset `expbkmain` from `bkmain` so the next
experiment starts from production.

Update the upstream mirror and `t3.dev`: see
[`deploy/t3/README.md`](../../deploy/t3/README.md#branch-maintenance).

Merging a fresh upstream nightly into the fork — mirror sync, measuring the
conflict surface before staffing the work, resolution rules, and the post-merge
CI failures that recur every time — is the
[`merge-upstream`](../../.agents/skills/merge-upstream/SKILL.md) skill. Note that
`t3main` being current does **not** mean the `main` mirror is: the two steps are
routinely half-done, and fork branches merge from `origin/main`, never `t3main`.

## Fork customization boundaries

Fork-specific code is marked with `T3-CUSTOM(expbkt3)` comments so upstream
merges stay tractable; see
[expbkt3 customization boundaries](./expbkt3-customizations.md).
