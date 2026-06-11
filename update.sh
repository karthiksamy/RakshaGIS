#!/bin/bash
# RakshaGIS quick update — apply code changes WITHOUT the full build.sh.
#
# The web/celery containers bind-mount the project source (.:/app), so Python
# changes only need a container restart. Frontend changes need the Vite build
# + sync to DATA_DIR/staticfiles (served by nginx) + collectstatic.
#
# Usage:
#   ./update.sh             backend restart + frontend rebuild (default)
#   ./update.sh backend     restart web/celery only  (~5 s, Python changes)
#   ./update.sh frontend    rebuild React bundle only (~1-2 min, .tsx changes)
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export COMPOSE_PROJECT_NAME=rakshagis
MODE="${1:-all}"

# Sudo-wrap docker when the user is not in the docker group (same as build.sh)
DOCKER_NEED_SUDO=false
if ! docker ps &>/dev/null && sudo docker ps &>/dev/null; then
  DOCKER_NEED_SUDO=true
fi
docker() {
  if [[ "$DOCKER_NEED_SUDO" == true ]]; then sudo docker "$@"; else command docker "$@"; fi
}

DATA_DIR=$(grep "^DATA_DIR=" "$SCRIPT_DIR/.env" 2>/dev/null | cut -d= -f2- | tr -d '\r"' )
if [[ -z "$DATA_DIR" ]]; then
  echo "✗ DATA_DIR not found in .env — run ./build.sh once first."
  exit 1
fi

update_backend() {
  echo ">>> Restarting web + celery (source is bind-mounted — no image rebuild needed)..."
  docker restart rakshagis-web-1 rakshagis-celery-1
  echo "    ✓ Backend restarted. (Run migrations separately if models changed:"
  echo "      docker exec rakshagis-web-1 python manage.py migrate)"
}

update_frontend() {
  if ! command -v node &>/dev/null; then
    echo "✗ Node.js not found on host — cannot build frontend."
    exit 1
  fi
  cd "$SCRIPT_DIR/frontend"

  # Skip npm install when package.json / lockfile unchanged (same as build.sh)
  NPM_HASH_FILE="$SCRIPT_DIR/.npm-hash"
  NPM_HASH=$(sha256sum package.json package-lock.json 2>/dev/null | sha256sum | cut -d' ' -f1)
  if [[ "$(cat "$NPM_HASH_FILE" 2>/dev/null)" != "$NPM_HASH" ]] || \
     [[ ! -f node_modules/vite/dist/node/cli.js ]]; then
    echo ">>> Installing npm dependencies..."
    npm install
    echo "$NPM_HASH" > "$NPM_HASH_FILE"
  fi

  # Cesium asset cache — avoid re-copying 14 MB on every code change (build.sh logic)
  CESIUM_VER=$(node -p "require('./package.json').dependencies.cesium.replace(/^[^0-9]*/,'')" 2>/dev/null || echo "unknown")
  CESIUM_CACHE="$SCRIPT_DIR/.cesium-build"
  CESIUM_VER_FILE="$CESIUM_CACHE/.version"
  echo ">>> Building frontend (vite)..."
  if [[ -f "$CESIUM_VER_FILE" ]] && [[ "$(cat "$CESIUM_VER_FILE")" == "$CESIUM_VER" ]] \
     && [[ -f "$CESIUM_CACHE/cesium/Cesium.js" ]]; then
    SKIP_CESIUM_COPY=1 node_modules/.bin/vite build
    DATA_DIR="$DATA_DIR" node deploy.cjs
    cp -r "$CESIUM_CACHE/cesium" "$SCRIPT_DIR/staticfiles/cesium"
  else
    DATA_DIR="$DATA_DIR" npm run build
    mkdir -p "$CESIUM_CACHE"
    rm -rf "$CESIUM_CACHE/cesium"
    cp -r "$SCRIPT_DIR/staticfiles/cesium" "$CESIUM_CACHE/cesium"
    echo "$CESIUM_VER" > "$CESIUM_VER_FILE"
  fi
  cd "$SCRIPT_DIR"

  # Sync Vite output to DATA_DIR/staticfiles so nginx serves the new assets
  if [[ "$SCRIPT_DIR/staticfiles" != "$DATA_DIR/staticfiles" ]]; then
    echo ">>> Syncing built assets → ${DATA_DIR}/staticfiles/ ..."
    mkdir -p "$DATA_DIR/staticfiles" 2>/dev/null || sudo mkdir -p "$DATA_DIR/staticfiles"
    if command -v rsync &>/dev/null; then
      rsync -a "$SCRIPT_DIR/staticfiles/" "$DATA_DIR/staticfiles/" 2>/dev/null || \
        sudo rsync -a "$SCRIPT_DIR/staticfiles/" "$DATA_DIR/staticfiles/"
    else
      cp -rp "$SCRIPT_DIR/staticfiles/." "$DATA_DIR/staticfiles/" 2>/dev/null || \
        sudo cp -rp "$SCRIPT_DIR/staticfiles/." "$DATA_DIR/staticfiles/"
    fi
  fi

  echo ">>> collectstatic..."
  docker exec rakshagis-web-1 python manage.py collectstatic --no-input \
    || docker compose run --rm web python manage.py collectstatic --no-input

  # Keep build.sh's change-detection hash in sync so it skips this build next run
  FE_HASH=$(find "$SCRIPT_DIR/frontend/src" \
      "$SCRIPT_DIR/frontend/package.json" "$SCRIPT_DIR/frontend/vite.config"* \
      "$SCRIPT_DIR/frontend/tsconfig"* \
      -type f 2>/dev/null | sort | xargs sha256sum 2>/dev/null | sha256sum | cut -d' ' -f1)
  echo "$FE_HASH" > "$SCRIPT_DIR/.frontend-hash"

  echo "    ✓ Frontend deployed. Hard-refresh the browser (Ctrl+Shift+R)."
}

case "$MODE" in
  backend)  update_backend ;;
  frontend) update_frontend ;;
  all)      update_frontend; update_backend ;;
  *) echo "Usage: $0 [backend|frontend|all]"; exit 1 ;;
esac
echo "✓ Done."
