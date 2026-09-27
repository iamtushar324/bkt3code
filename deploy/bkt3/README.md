# Beknown `bkmain` deployment

This deployment serves the Beknown-maintained T3 Code branch at
`https://bkt3.dev.beknown.live` without changing the upstream-style deployment at
`https://t3.dev.beknown.live`.

## Isolation

- Branch: `bkmain`
- Worktree: `/home/ubuntu/repos/t3code-bkmain`
- systemd service: `t3-bkmain.service`
- Server address: `10.31.39.131:18083`
- Persistent state: `/home/ubuntu/.t3/bkt3-dev`
- Swarm proxy: `bkt3-proxy`
- Automatic deployment timer: `t3-bkmain-deploy.timer`
- Web build: experimental control-center and MCP surfaces enabled

`start.sh` refuses to run unless the worktree is currently on `bkmain`.

## Manual deployment

```bash
cd /home/ubuntu/repos/t3code-bkmain
./deploy/bkt3/deploy.sh
```

The deployment script fetches and fast-forwards `bkmain`, finds the successful
GitHub Actions run for that exact SHA, verifies and installs its SHA-addressed
web/server artifact, restarts the service, and waits for the local endpoint to
become healthy. If the health check fails it restores the previous artifact and
restarts again. Dependency installation, tests, and application builds run in
GitHub Actions; they do not run on the shared dev server.

The checked-in systemd unit sets idle provider sessions to terminate after ten
minutes with `T3CODE_PROVIDER_SESSION_INACTIVITY_MS=600000`. Artifact deployment
does not install unit files. After changing `t3-bkmain.service`, install it and
reload systemd before the next drained restart:

```bash
sudo install -m 0644 deploy/bkt3/t3-bkmain.service /etc/systemd/system/t3-bkmain.service
sudo systemctl daemon-reload
```

> Deploying bkt3 from a session hosted **on** bkt3 kills that session. Agent
> worktrees under `/home/ubuntu/.t3/bkt3-dev/worktrees/` run as children of
> `t3-bkmain.service`, which this script restarts — interrupting every in-flight
> turn on the instance. Trigger a manual bkt3 deploy from the `t3.dev` instance
> or from a human shell.

## Temporary files

`start.sh` exports `TMPDIR=<base-dir>/tmp` so the service and every agent session
beneath it write scratch files to the root filesystem. `/tmp` is a RAM-backed
tmpfs sized at 50% of RAM, mounted with `usrquota`, and systemd caps each user at
80% of it; once `ubuntu` reaches that cap, writes fail with `EDQUOT` and commands
exit 1 with no output at all.

Those directories live on a disk that runs close to full, so
`deploy/tmpfiles/t3-tmp.conf` expires their contents after seven days. Like unit
files, it is not installed by artifact deployment:

```bash
sudo install -m 0644 deploy/tmpfiles/t3-tmp.conf /etc/tmpfiles.d/t3-tmp.conf
sudo systemd-tmpfiles --create /etc/tmpfiles.d/t3-tmp.conf
```

The same applies to the `t3.dev` and `expbkt3` deployments, whose `start.sh`
scripts carry the identical export. Snap-confined Chromium (agent-browser,
browser-use) ignores `TMPDIR` and still writes under `/tmp/snap-private-tmp`;
that space is not covered here.

## Reverse proxy

```bash
./deploy/bkt3/proxy.sh
```

Idempotent registration of the `bkt3-proxy` swarm service that routes
`bkt3.dev.beknown.live` to `10.31.39.131:18083`.

## Automatic CI/CD

`.github/workflows/deploy-bkt3.yml` validates, typechecks, tests, and builds pull
requests and pushes targeting `bkmain`, then uploads the `bkt3-<sha>` deployment
artifact that the host installs.

On the server, `t3-bkmain-deploy.timer` checks the current `origin/bkmain` head once
per minute. It deploys only when the GitHub Actions run for that exact commit has
finished successfully. This avoids storing production SSH or Tailscale credentials
in the public repository and prevents an older workflow run from deploying over a
newer commit. The last successfully deployed commit is recorded separately from the
worktree HEAD, so pushes made directly from the server are still rebuilt and
restarted after CI passes. Local commits that have not been pushed are never
replaced by the deployment watcher.

The root `.gitmodules` entry describes the nested gitlink already present in the
vendored Alchemy reference. It lets GitHub Actions clean credentials safely without
initializing or changing that vendored submodule.
