#!/usr/bin/env bash
# T3-CUSTOM(expbkt3): Isolated reverse-proxy registration for the experimental domain.
set -euo pipefail

SERVICE_NAME="expbkt3-proxy"
NETWORK_NAME="bk-dev"
TARGET_ADDRESS="10.31.39.131:18085"
# A page load fans out across many JS chunks; socat's default backlog of 5
# overflows during that burst and leaves clients with asset 502s/timeouts.
LISTEN_ADDRESS="tcp-listen:18085,fork,reuseaddr,backlog=1024"

labels=(
  --label-add "traefik.enable=true"
  --label-add "traefik.http.services.expbkt3.loadbalancer.server.port=18085"
  --label-add "traefik.http.routers.expbkt3.entrypoints=web"
  --label-add 'traefik.http.routers.expbkt3.rule=Host(`expbkt3.dev`)'
  --label-add "traefik.http.routers.expbkt3.middlewares=expbkt3-https-redirect"
  --label-add "traefik.http.middlewares.expbkt3-https-redirect.redirectscheme.scheme=https"
  --label-add "traefik.http.middlewares.expbkt3-https-redirect.redirectscheme.permanent=true"
  --label-add "traefik.http.routers.expbkt3-secure.entrypoints=websecure"
  --label-add 'traefik.http.routers.expbkt3-secure.rule=Host(`expbkt3.dev`)'
  --label-add "traefik.http.routers.expbkt3-secure.tls.certresolver=le"
  --label-add "traefik.http.routers.expbkt3-fallback.entrypoints=web"
  --label-add 'traefik.http.routers.expbkt3-fallback.rule=Host(`expbkt3.dev.beknown.live`)'
  --label-add "traefik.http.routers.expbkt3-fallback.middlewares=expbkt3-fallback-https-redirect"
  --label-add "traefik.http.middlewares.expbkt3-fallback-https-redirect.redirectscheme.scheme=https"
  --label-add "traefik.http.middlewares.expbkt3-fallback-https-redirect.redirectscheme.permanent=true"
  --label-add "traefik.http.routers.expbkt3-fallback-secure.entrypoints=websecure"
  --label-add 'traefik.http.routers.expbkt3-fallback-secure.rule=Host(`expbkt3.dev.beknown.live`)'
  --label-add "traefik.http.routers.expbkt3-fallback-secure.tls.certresolver=le"
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
