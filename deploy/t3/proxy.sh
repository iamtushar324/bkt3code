#!/usr/bin/env bash
# Reverse-proxy registration for the t3.dev domain. Idempotent: run it to create
# the swarm service or to reapply the Traefik labels after a change.
set -euo pipefail

SERVICE_NAME="t3-proxy"
NETWORK_NAME="bk-dev"
TARGET_ADDRESS="10.31.39.131:18082"

labels=(
  --label-add "traefik.enable=true"
  --label-add "traefik.http.services.t3.loadbalancer.server.port=18082"
  --label-add "traefik.http.routers.t3.entrypoints=web"
  --label-add 'traefik.http.routers.t3.rule=Host(`t3.dev.beknown.live`)'
  --label-add "traefik.http.routers.t3.middlewares=t3-https-redirect"
  --label-add "traefik.http.middlewares.t3-https-redirect.redirectscheme.scheme=https"
  --label-add "traefik.http.middlewares.t3-https-redirect.redirectscheme.permanent=true"
  --label-add "traefik.http.routers.t3-secure.entrypoints=websecure"
  --label-add 'traefik.http.routers.t3-secure.rule=Host(`t3.dev.beknown.live`)'
  --label-add "traefik.http.routers.t3-secure.tls.certresolver=le"
)

if sudo docker service inspect "$SERVICE_NAME" >/dev/null 2>&1; then
  sudo docker service update \
    --force \
    "${labels[@]}" \
    --args "tcp-listen:18082,fork,reuseaddr tcp:$TARGET_ADDRESS" \
    "$SERVICE_NAME"
else
  sudo docker service create \
    --name "$SERVICE_NAME" \
    --network "$NETWORK_NAME" \
    "${labels[@]/--label-add/--label}" \
    alpine/socat:latest \
    "tcp-listen:18082,fork,reuseaddr" \
    "tcp:$TARGET_ADDRESS"
fi
