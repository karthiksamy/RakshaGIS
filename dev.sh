#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# RakshaGIS — Hot-reload Development Server
#
# Use this instead of ./build.sh for day-to-day coding.
# Changes to .tsx / .ts / .py files are reflected instantly — NO rebuild needed.
#
#   First time (or after requirements.txt / Dockerfile changes):
#     ./build.sh
#
#   Every other time:
#     ./dev.sh          → opens at http://localhost:5173
#
# What this script does:
#   1. Starts backend Docker services (db, redis, Django, celery, pg_tileserv)
#      using the dev compose override (DEBUG=True, live source mount)
#   2. Starts Vite dev server on your host with HMR + API proxy → Django
#   3. You open http://localhost:5173 — not :8000
#
# Keyboard shortcuts while running:
#   Ctrl+C  — stops Vite dev server (Docker backend keeps running)
#   ./dev.sh stop  — stops all Docker backend containers
# ─────────────────────────────────────────────────────────────────────────────
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export COMPOSE_PROJECT_NAME=rakshagis

BOLD='\033[1m'; GREEN='\033[0;32m'; CYAN='\033[0;36m'
YELLOW='\033[0;33m'; RED='\033[0;31m'; RESET='\033[0m'

# ── Handle stop command ───────────────────────────────────────────────────────
if [[ "${1:-}" == "stop" ]]; then
  echo -e "${YELLOW}Stopping RakshaGIS dev backend…${RESET}"
  docker compose -f "$SCRIPT_DIR/docker-compose.yml" \
                 -f "$SCRIPT_DIR/docker-compose.dev.yml" \
                 stop web celery db redis pg_tileserv 2>/dev/null || true
  echo -e "${GREEN}✓ Stopped.${RESET}"
  exit 0
fi

echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║         RakshaGIS — Hot-reload Dev Mode             ║"
echo "╚══════════════════════════════════════════════════════╝"
echo ""

# ── Require .env ─────────────────────────────────────────────────────────────
if [[ ! -f "$SCRIPT_DIR/.env" ]]; then
  echo -e "${RED}✗ .env not found.${RESET}"
  echo "  Run ./build.sh once to create it, then use ./dev.sh for daily work."
  exit 1
fi

# Make sure DEBUG=True is set (dev mode requires it for runserver + static serving)
if ! grep -q "^DEBUG=True" "$SCRIPT_DIR/.env" 2>/dev/null; then
  echo -e "${YELLOW}⚠  Switching .env to DEBUG=True for dev mode…${RESET}"
  sed -i 's/^DEBUG=.*/DEBUG=True/' "$SCRIPT_DIR/.env"
fi

# ── Step 1: Start backend services ───────────────────────────────────────────
echo -e "${BOLD}>>> Starting backend services…${RESET}"

CORE_SERVICES="db redis web celery pg_tileserv"

docker compose \
  -f "$SCRIPT_DIR/docker-compose.yml" \
  -f "$SCRIPT_DIR/docker-compose.dev.yml" \
  up -d $CORE_SERVICES

echo -e "  ${GREEN}✓ Backend services started${RESET}"
echo    "    Django API : http://localhost:8000"
echo    "    pg_tileserv: http://localhost:7800"
echo ""

# ── Step 2: Wait for Django to be ready ──────────────────────────────────────
echo -n "  Waiting for Django"
ATTEMPTS=0
until curl -sf "http://localhost:8000/api/" > /dev/null 2>&1; do
  sleep 1
  echo -n "."
  ATTEMPTS=$((ATTEMPTS + 1))
  if [[ $ATTEMPTS -gt 30 ]]; then
    echo ""
    echo -e "  ${YELLOW}⚠  Django is taking longer than usual.${RESET}"
    echo    "     Check logs: docker compose logs -f web"
    break
  fi
done
echo -e "  ${GREEN}✓${RESET}"
echo ""

# ── Step 3: Ensure npm deps are installed ─────────────────────────────────────
cd "$SCRIPT_DIR/frontend"

NPM_HASH_FILE="$SCRIPT_DIR/.npm-hash"
NPM_HASH=$(sha256sum package.json package-lock.json 2>/dev/null | sha256sum | cut -d' ' -f1)
if [[ "$(cat "$NPM_HASH_FILE" 2>/dev/null)" != "$NPM_HASH" ]] || [[ ! -d node_modules ]]; then
  echo -e "${BOLD}>>> Installing npm dependencies…${RESET}"
  npm install --silent
  echo "$NPM_HASH" > "$NPM_HASH_FILE"
  echo -e "  ${GREEN}✓ Done${RESET}"
  echo ""
fi

# ── Step 4: Start Vite dev server ─────────────────────────────────────────────
echo -e "${BOLD}>>> Starting Vite dev server…${RESET}"
echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║                                                          ║"
echo "║   Open your browser at:  http://localhost:5173          ║"
echo "║                                                          ║"
echo "║   React/TS changes → instant HMR (no rebuild needed)   ║"
echo "║   Python changes   → Django auto-reloads                ║"
echo "║                                                          ║"
echo "║   Ctrl+C to stop Vite  (backend keeps running)         ║"
echo "║   ./dev.sh stop        to stop Docker backend           ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""

exec npm run dev
