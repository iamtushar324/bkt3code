# Upstream-style `t3.dev` deployment

This deployment serves near-upstream T3 Code at `https://t3.dev.beknown.live`.
It is the instance that hosts most agent sessions, and it is deliberately kept
free of Beknown feature flags.

## Isolation

- Branch: `t3main` (upstream `main` plus `.github/workflows/deploy-t3.yml` and a
  `.gitmodules` entry)
- Worktree: `/home/ubuntu/repos/t3code`
- systemd service: `t3-beknown.service`
- Server address: `10.31.39.131:18082`
- Persistent state: `/home/ubuntu/.t3/beknown-dev`
- Swarm proxy: `t3-proxy`
- Automatic deployment timer: `t3-beknown-deploy.timer`
- Web build: no fork flags

`start.sh` refuses to run unless the worktree is currently on `t3main`.

## Why the tooling lives on `bkmain`

`main` is a byte-pure mirror of upstream `pingdotgg/t3code`, and `t3main` adds
only two small files to it: the deploy workflow and a `.gitmodules` entry that
declares the vendored alchemy gitlink so `actions/checkout` can clean
credentials (`bkmain` carries the same entry). Everything else — these scripts,
the unit files, this README — is fork-owned and therefore lives in the `bkmain`
worktree. The
installed units call into `/home/ubuntu/repos/t3code-bkmain/deploy/t3/`, and
those scripts operate on `/home/ubuntu/repos/t3code` (override with
`T3_REPO_DIR` when testing).

`deploy/t3/deploy-t3.yml` is the source of truth for the workflow file that is
committed to `t3main`.

## Branch maintenance

`main` tracks upstream and is never deployed. Upstream syncs target a released
nightly commit so the source SHA and displayed version move together. Refuse to
sync an upstream tip until it has a matching nightly tag:

```bash
git -C /home/ubuntu/repos/t3code fetch upstream main --tags
nightly_tag="$(git -C /home/ubuntu/repos/t3code tag \
  --points-at upstream/main --list 'v*-nightly.*' --sort=-version:refname | head -1)"
test -n "$nightly_tag" || { echo "upstream/main has no nightly release yet"; exit 1; }
echo "Syncing $nightly_tag at $(git -C /home/ubuntu/repos/t3code rev-parse upstream/main)"
git push origin upstream/main:refs/heads/main          # refresh the pure mirror
git -C /home/ubuntu/repos/t3code checkout t3main
git -C /home/ubuntu/repos/t3code merge origin/main     # never force-push t3main
git -C /home/ubuntu/repos/t3code push origin t3main
```

A push to `main` alone deploys nothing. `t3.dev` moves only when `t3main` moves.
The t3 and expbkt3 workflows independently resolve the nightly tag at the
integrated upstream tip and align package versions in the CI workspace before
building. They fail rather than publish an artifact with a stale stable version.

## First installation

Run these from `/home/ubuntu/repos/t3code-bkmain`, and only **after** this
directory exists there — the units reference
`/home/ubuntu/repos/t3code-bkmain/deploy/t3/`, which only appears once the
change has merged to `bkmain` and bkt3 has deployed it. Installing the units
earlier leaves `t3-beknown.service` pointing at a missing `start.sh`, so the
next restart would take t3.dev down.

```bash
test -x /home/ubuntu/repos/t3code-bkmain/deploy/t3/start.sh || echo "NOT MERGED YET — stop"
sudo install -m 0644 deploy/t3/t3-beknown.service /etc/systemd/system/
sudo install -m 0644 deploy/t3/t3-beknown-deploy.service /etc/systemd/system/
sudo install -m 0644 deploy/t3/t3-beknown-deploy.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now t3-beknown.service t3-beknown-deploy.timer
deploy/t3/proxy.sh
```

## Manual deployment

```bash
/home/ubuntu/repos/t3code-bkmain/deploy/t3/deploy.sh
```

The deploy script accepts an optional expected commit SHA. It fetches and
fast-forwards `t3main`, finds the successful GitHub Actions run for that exact
SHA, verifies and installs its SHA-addressed web/server artifact, restarts the
service, and waits for the private health endpoint. On a failed health check it
restores the previous artifact and restarts again. Dependency installation,
tests, and application builds run in GitHub Actions; they do not run on the
shared dev server.

> Restarting `t3-beknown.service` kills every agent session hosted on this
> instance — sessions with worktrees under `/home/ubuntu/.t3/beknown-dev/` run
> as its children. Deploying t3 from a session on **this** instance therefore
> ends that session; run it from a bkt3 session or a human shell, and expect the
> automatic timer to interrupt in-flight turns when `t3main` moves.
