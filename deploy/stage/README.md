# Stage T3 Code deployment

> **T3-CUSTOM(stage):** This directory is an isolated deployment unit and does
> not modify upstream release infrastructure.

`stage` is the fresh-cut line of the Beknown fork. It was cut on 2026-09-27
from upstream `main` (`de251fc29`) and re-applies only the fork features the
team still uses, each behind the smallest possible seam, so upstream can be
merged in often and cheaply. It runs on a copy of bkt3's database to prove it
can one day replace `bkmain`.

- Domain: `https://stagebkt3.dev.beknown.live`
- Branch: `stage`
- Worktree: `/home/ubuntu/repos/t3code-stage`
- systemd service: `t3-stage.service`
- Private server: `10.31.39.131:18086`
- Persistent state: `/home/ubuntu/.t3/stage-dev`
- Swarm proxy: `stage-proxy`
- Automatic deployment timer: `t3-stage-deploy.timer`
- Workflow: `.github/workflows/deploy-stage.yml` (artifact `stage-<sha>`)

## First installation

```bash
sudo install -m 0644 deploy/stage/t3-stage.service /etc/systemd/system/
sudo install -m 0644 deploy/stage/t3-stage-deploy.service /etc/systemd/system/
sudo install -m 0644 deploy/stage/t3-stage-deploy.timer /etc/systemd/system/
sudo install -m 0644 deploy/tmpfiles/t3-tmp.conf /etc/tmpfiles.d/t3-tmp.conf
sudo systemd-tmpfiles --create /etc/tmpfiles.d/t3-tmp.conf
sudo systemctl daemon-reload
sudo systemctl enable --now t3-stage-deploy.timer
deploy/stage/proxy.sh
```

Host-only drop-ins (not in the repository) mirror expbkt3's:
`/etc/systemd/system/t3-stage.service.d/{clerk,bridge}.conf` and
`/etc/systemd/system/t3-stage-deploy.service.d/{github,alert}.conf`.

## Manual deployment

```bash
cd /home/ubuntu/repos/t3code-stage
./deploy/stage/deploy.sh
```

Deploy installs the GitHub-built artifact for the exact branch SHA; nothing is
built on the host.
