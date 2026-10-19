# Beknown `bkmain` deployment

This deployment serves the Beknown-maintained T3 Code branch at
`https://bkt3.dev.beknown.live` without changing the upstream-style deployment at
`https://t3.dev.beknown.live`.

## Isolation

- Branch: `bkmain`
- Worktree: `/home/ubuntu/repos/t3code-nextbkt3`
- systemd service: `t3-nextbkt3.service`
- Server address: `10.31.39.131:18087`
- Persistent state: `/home/ubuntu/.t3/nextbkt3-dev`
- Swarm proxy: `bkt3-proxy`
- Automatic deployment timer: `t3-bkmain-deploy.timer`
- Web build: experimental control-center and MCP surfaces enabled

`start.sh` refuses to run unless the worktree is currently on `bkmain`.

The `nextbkt3` names are historical: production moved on 2026-10-09 from the old
bkmain line to the `stage` code, on a cleaned copy of the old database. The old
server is kept as a backup at `bkt3-bkp.dev.beknown.live`
(`t3-bkmain.service`, `/home/ubuntu/repos/t3code-bkmain` frozen at `7c0b134a7`,
port 18083, state `/home/ubuntu/.t3/bkt3-dev`). Nothing deploys to it. Never run
these scripts from that checkout, and never move it off `7c0b134a7`: a restart
on newer code would migrate the backup database.

## Manual deployment

```bash
cd /home/ubuntu/repos/t3code-nextbkt3
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
does not install unit files. After changing `t3-nextbkt3.service`, install it and
reload systemd before the next drained restart:

```bash
sudo install -m 0644 deploy/bkt3/t3-nextbkt3.service /etc/systemd/system/t3-nextbkt3.service
sudo systemctl daemon-reload
```

> Deploying bkt3 from a session hosted **on** bkt3 kills that session. Agent
> worktrees under `/home/ubuntu/.t3/nextbkt3-dev/worktrees/` run as children of
> `t3-nextbkt3.service`, which this script restarts — interrupting every in-flight
> turn on the instance. Trigger a manual bkt3 deploy from the `t3.dev` instance
> or from a human shell.

## Product analytics

bkt3 sends product events to the company PostHog project. The
server reads these variables:

| Variable                    | Meaning                                                                           | Default                    |
| --------------------------- | --------------------------------------------------------------------------------- | -------------------------- |
| `T3CODE_TELEMETRY_ENABLED`  | Set `false` to send nothing.                                                      | `true`                     |
| `T3CODE_POSTHOG_KEY`        | PostHog project API key. Without a key, telemetry is off.                         | none                       |
| `T3CODE_POSTHOG_HOST`       | PostHog ingestion host.                                                           | `https://us.i.posthog.com` |
| `T3CODE_ANALYTICS_INSTANCE` | Name of this instance, sent as the PostHog `instance` group (for example `bkt3`). | `unknown`                  |

The fork has no built-in key, so it never sends to the upstream maintainers'
project. Never commit the key. Production keeps the values in
`/home/ubuntu/.t3/nextbkt3-dev/posthog.env` (mode `600`, owner `ubuntu`), which
sets `T3CODE_POSTHOG_KEY`, `T3CODE_POSTHOG_HOST` and
`T3CODE_ANALYTICS_INSTANCE=bkt3`.

The existing drop-in `/etc/systemd/system/t3-nextbkt3.service.d/clerk.conf` sets
`Environment=T3CODE_TELEMETRY_ENABLED=false`. To turn analytics on, add a second
drop-in named `zz-analytics.conf`. systemd reads drop-ins in name order, so this
one comes after `clerk.conf` and its value replaces the `false`:

```ini
# /etc/systemd/system/t3-nextbkt3.service.d/zz-analytics.conf
[Service]
EnvironmentFile=-/home/ubuntu/.t3/nextbkt3-dev/posthog.env
Environment=T3CODE_TELEMETRY_ENABLED=true
```

```bash
sudo systemctl daemon-reload
sudo systemctl show t3-nextbkt3 -p Environment   # expect T3CODE_TELEMETRY_ENABLED=true
```

The new environment takes effect at the next restart of the service. To turn
analytics off again, remove `zz-analytics.conf`, reload systemd and restart.
Provider and agent processes never inherit these variables: the server masks
them when it builds a provider's environment.

Events carry ids, enums, numbers and booleans only. Free text (titles, prompts,
messages, paths, branches, errors) is dropped by the allowlist in
`apps/server/src/telemetry/analyticsProperties.ts`. An event with a known user
is sent as that user's `environment_users.primary_email`.

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
`bkt3.dev.beknown.live` to `10.31.39.131:18087`.

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
