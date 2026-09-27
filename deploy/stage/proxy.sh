#!/usr/bin/env bash
# T3-CUSTOM(stage): Isolated reverse-proxy registration for the stage domain.
set -euo pipefail

SERVICE_NAME="stage-proxy"
NETWORK_NAME="bk-dev"
TARGET_ADDRESS="10.31.39.131:18086"
# A page load fans out across many JS chunks; socat's default backlog of 5
# overflows during that burst and leaves clients with asset 502s/timeouts.
LISTEN_ADDRESS="tcp-listen:18086,fork,reuseaddr,backlog=1024"

labels=(
  --label-add "traefik.enable=true"
  --label-add "traefik.http.services.stagebkt3.loadbalancer.server.port=18086"
  --label-add "traefik.http.routers.stagebkt3.entrypoints=web"
  --label-add 'traefik.http.routers.stagebkt3.rule=Host(`stagebkt3.dev.beknown.live`)'
  --label-add "traefik.http.routers.stagebkt3.middlewares=stagebkt3-https-redirect"
  --label-add "traefik.http.middlewares.stagebkt3-https-redirect.redirectscheme.scheme=https"
  --label-add "traefik.http.middlewares.stagebkt3-https-redirect.redirectscheme.permanent=true"
  --label-add "traefik.http.routers.stagebkt3-secure.entrypoints=websecure"
  --label-add 'traefik.http.routers.stagebkt3-secure.rule=Host(`stagebkt3.dev.beknown.live`)'
  --label-add "traefik.http.routers.stagebkt3-secure.tls.certresolver=le"
)

if sudo docker service inspect "$SERVICE_NAME" >/dev/null 2>&1; then
  sudo docker service update \
    --force \
    "${labels[@]}" \
    --args "$LISTEN_ADDRESS tcp:$TARGET_ADDRESS" \
    "$SERVICE_NAME"
else
  sudo docker service create \
    --name "$SERVICE_NAME" \
    --network "$NETWORK_NAME" \
    "${labels[@]/--label-add/--label}" \
    alpine/socat:latest \
    "$LISTEN_ADDRESS" \
    "tcp:$TARGET_ADDRESS"
fi
