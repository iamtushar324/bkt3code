#!/usr/bin/env bash
# Reverse-proxy registration for the bkt3 domain. Idempotent: run it to create
# the swarm service or to reapply the Traefik labels after a change.
set -euo pipefail

SERVICE_NAME="bkt3-proxy"
NETWORK_NAME="bk-dev"
TARGET_ADDRESS="10.31.39.131:18083"

labels=(
  --label-add "traefik.enable=true"
  --label-add "traefik.http.services.bkt3.loadbalancer.server.port=18083"
  --label-add "traefik.http.routers.bkt3.entrypoints=web"
  --label-add 'traefik.http.routers.bkt3.rule=Host(`bkt3.dev.beknown.live`)'
  --label-add "traefik.http.routers.bkt3.middlewares=bkt3-https-redirect"
  --label-add "traefik.http.middlewares.bkt3-https-redirect.redirectscheme.scheme=https"
  --label-add "traefik.http.middlewares.bkt3-https-redirect.redirectscheme.permanent=true"
  --label-add "traefik.http.routers.bkt3-secure.entrypoints=websecure"
  --label-add 'traefik.http.routers.bkt3-secure.rule=Host(`bkt3.dev.beknown.live`)'
  --label-add "traefik.http.routers.bkt3-secure.tls.certresolver=le"
)

if sudo docker service inspect "$SERVICE_NAME" >/dev/null 2>&1; then
  sudo docker service update \
    --force \
    "${labels[@]}" \
    --args "tcp-listen:18083,fork,reuseaddr tcp:$TARGET_ADDRESS" \
    "$SERVICE_NAME"
else
  sudo docker service create \
    --name "$SERVICE_NAME" \
    --network "$NETWORK_NAME" \
    "${labels[@]/--label-add/--label}" \
    alpine/socat:latest \
    "tcp-listen:18083,fork,reuseaddr" \
    "tcp:$TARGET_ADDRESS"
fi
