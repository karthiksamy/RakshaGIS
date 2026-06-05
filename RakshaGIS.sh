#!/bin/bash
# RakshaGIS Service Manager
# Usage: ./RakshaGIS.sh [start|stop|restart|status|logs|backup|update|info]
set -e

# ── Dynamic sudo wrapping for Docker ─────────────────────────────────────────
DOCKER_NEED_SUDO=false
if command -v docker &>/dev/null; then
  if ! docker ps &>/dev/null; then
    if sudo docker ps &>/dev/null; then
      DOCKER_NEED_SUDO=true
    fi
  fi
fi

docker() {
  if [[ "$1" == "--version" ]] || [[ "$1" == "version" ]]; then
    command docker "$@"
    return
  fi
  if [[ "$DOCKER_NEED_SUDO" == true ]]; then
    sudo docker "$@"
  else
    command docker "$@"
  fi
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

BOLD='\033[1m'; GREEN='\033[0;32m'; CYAN='\033[0;36m'; YELLOW='\033[0;33m'; RED='\033[0;31m'; RESET='\033[0m'

# ── Load settings from .env ───────────────────────────────────────────────────
if [[ -f "$SCRIPT_DIR/.env" ]]; then
  DATA_DIR=$(grep         "^DATA_DIR="           "$SCRIPT_DIR/.env" | cut -d= -f2 | tr -d '\r')
  AI_BACKEND_GPU=$(grep   "^AI_BACKEND_GPU="     "$SCRIPT_DIR/.env" | cut -d= -f2 | tr -d '\r')
  AI_BACKENDS=$(grep      "^AI_BACKENDS="        "$SCRIPT_DIR/.env" | cut -d= -f2 | tr -d '\r')
fi
DATA_DIR="${DATA_DIR:-/RakshaGIS}"
AI_BACKEND_GPU="${AI_BACKEND_GPU:-cpu}"

# GPU profile suffix: "" for CPU, "-gpu" for NVIDIA
GPU_SUFFIX=""
[[ "$AI_BACKEND_GPU" == "nvidia" ]] && GPU_SUFFIX="-gpu"

COMPOSE="docker compose"

# Core services always started/stopped
CORE_SERVICES="db redis web celery nginx pg_tileserv"
# Optional monitoring services
MONITOR_SERVICES="prometheus grafana"

# ── Runtime AI backend detection ─────────────────────────────────────────────
# Re-detect on every invocation so start/stop/restart always matches actual state.
# Priority: local binary/port → Docker running → Docker stopped → not present.
_svc_running() {
  docker ps \
    --filter "label=com.docker.compose.service=$1" \
    --format "{{.ID}}" 2>/dev/null | grep -q .
}
_svc_exists() {
  docker ps -a \
    --filter "label=com.docker.compose.service=$1" \
    --format "{{.ID}}" 2>/dev/null | grep -q .
}
_port_up() { curl -sf --connect-timeout 2 "$1" &>/dev/null; }

DOCKER_PROFILES=""   # --profile flags for ALL Docker-managed backends
START_PROFILES=""    # --profile flags for backends that need `docker compose up`

# ── Ollama ─────────────────────────────────────────────────────────────────
OLLAMA_PROF="docker-ollama${GPU_SUFFIX}"
if command -v ollama &>/dev/null && _port_up "http://localhost:11434/api/tags"; then
  OLLAMA_STATUS="local (host)"
elif _svc_running "$OLLAMA_PROF"; then
  OLLAMA_STATUS="Docker running"
  DOCKER_PROFILES="$DOCKER_PROFILES --profile $OLLAMA_PROF"
elif _svc_exists "$OLLAMA_PROF"; then
  OLLAMA_STATUS="Docker stopped"
  DOCKER_PROFILES="$DOCKER_PROFILES --profile $OLLAMA_PROF"
  START_PROFILES="$START_PROFILES --profile $OLLAMA_PROF"
else
  OLLAMA_STATUS="not installed"
fi

# ── LocalAI ────────────────────────────────────────────────────────────────
LOCALAI_PROF="localai${GPU_SUFFIX}"
if _port_up "http://localhost:8080/v1/models"; then
  LOCALAI_STATUS="local (:8080)"
elif _svc_running "$LOCALAI_PROF"; then
  LOCALAI_STATUS="Docker running"
  DOCKER_PROFILES="$DOCKER_PROFILES --profile $LOCALAI_PROF"
elif _svc_exists "$LOCALAI_PROF"; then
  LOCALAI_STATUS="Docker stopped"
  DOCKER_PROFILES="$DOCKER_PROFILES --profile $LOCALAI_PROF"
  START_PROFILES="$START_PROFILES --profile $LOCALAI_PROF"
else
  LOCALAI_STATUS="not installed"
fi

# ── LlamaCpp ───────────────────────────────────────────────────────────────
LLAMACPP_PROF="llamacpp${GPU_SUFFIX}"
if command -v llama-server &>/dev/null || _port_up "http://localhost:8081/v1/models"; then
  LLAMACPP_STATUS="local (:8081)"
elif _svc_running "$LLAMACPP_PROF"; then
  LLAMACPP_STATUS="Docker running"
  DOCKER_PROFILES="$DOCKER_PROFILES --profile $LLAMACPP_PROF"
elif _svc_exists "$LLAMACPP_PROF"; then
  LLAMACPP_STATUS="Docker stopped"
  DOCKER_PROFILES="$DOCKER_PROFILES --profile $LLAMACPP_PROF"
  START_PROFILES="$START_PROFILES --profile $LLAMACPP_PROF"
else
  LLAMACPP_STATUS="not installed"
fi

# ── AnythingLLM ────────────────────────────────────────────────────────────
ANYTHINGLLM_PROF="anythingllm${GPU_SUFFIX}"
if _port_up "http://localhost:3001/api/health"; then
  ANYTHINGLLM_STATUS="local (:3001)"
elif _svc_running "$ANYTHINGLLM_PROF"; then
  ANYTHINGLLM_STATUS="Docker running"
  DOCKER_PROFILES="$DOCKER_PROFILES --profile $ANYTHINGLLM_PROF"
elif _svc_exists "$ANYTHINGLLM_PROF"; then
  ANYTHINGLLM_STATUS="Docker stopped"
  DOCKER_PROFILES="$DOCKER_PROFILES --profile $ANYTHINGLLM_PROF"
  START_PROFILES="$START_PROFILES --profile $ANYTHINGLLM_PROF"
else
  ANYTHINGLLM_STATUS="not installed"
fi

# Combined: all Docker profiles needed for stop/restart/status
ALL_PROFILE_FLAGS="$DOCKER_PROFILES"

# ── Helpers ───────────────────────────────────────────────────────────────────
print_banner() {
  echo ""
  echo "╔══════════════════════════════════════════════════════╗"
  echo "║              RakshaGIS Service Manager              ║"
  echo "╚══════════════════════════════════════════════════════╝"
  echo ""
}

print_info() {
  echo "  Storage location : $DATA_DIR"
  echo "  Compose file     : $SCRIPT_DIR/docker-compose.yml"
  echo "  AI compute mode  : ${AI_BACKEND_GPU^^}"
  echo "  Ollama           : $OLLAMA_STATUS"
  echo "  LocalAI          : $LOCALAI_STATUS"
  echo "  LlamaCpp         : $LLAMACPP_STATUS"
  echo "  AnythingLLM      : $ANYTHINGLLM_STATUS"
  echo ""

  if [[ -d "$DATA_DIR" ]]; then
    DISK_USAGE=$(du -sh "$DATA_DIR" 2>/dev/null | cut -f1)
    DISK_FREE=$(df -h "$DATA_DIR" 2>/dev/null | tail -1 | awk '{print $4}')
    echo "  Disk usage : $DISK_USAGE used  |  $DISK_FREE free"
    echo ""
    echo "  ── Storage breakdown ──"
    for subdir in postgres redis staticfiles media logs models prometheus grafana backups images; do
      if [[ -d "$DATA_DIR/$subdir" ]]; then
        SZ=$(du -sh "$DATA_DIR/$subdir" 2>/dev/null | cut -f1)
        printf "  %-18s %s\n" "$subdir:" "$SZ"
      fi
    done
  else
    echo "  ⚠ Data directory not found. Run ./build.sh first."
  fi
  echo ""
}

do_status() {
  echo "  ── Service Status ──────────────────────────────────"
  # shellcheck disable=SC2086
  $COMPOSE $ALL_PROFILE_FLAGS ps --format "table {{.Name}}\t{{.Status}}\t{{.Ports}}" 2>/dev/null || \
    $COMPOSE $ALL_PROFILE_FLAGS ps
  echo ""

  WEB_STATUS=$($COMPOSE ps web --format "{{.Status}}" 2>/dev/null | head -1)
  if echo "$WEB_STATUS" | grep -q "Up"; then
    HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" http://localhost/ 2>/dev/null || echo "000")
    if [[ "$HTTP_CODE" == "200" || "$HTTP_CODE" == "302" ]]; then
      echo -e "  ${GREEN}✓ Web: Responding at http://localhost (HTTP $HTTP_CODE)${RESET}"
    else
      echo -e "  ${YELLOW}⚠ Web: HTTP $HTTP_CODE at http://localhost${RESET}"
    fi
  fi
  echo ""
}

do_start() {
  echo -e "${BOLD}>>> Starting RakshaGIS${RESET}"
  echo "  Compute mode : ${AI_BACKEND_GPU^^}"
  echo "  Ollama       : $OLLAMA_STATUS"
  echo "  LocalAI      : $LOCALAI_STATUS"
  echo "  LlamaCpp     : $LLAMACPP_STATUS"
  echo "  AnythingLLM  : $ANYTHINGLLM_STATUS"
  echo ""

  echo ">>> Starting core services (db · redis · web · celery · nginx · pg_tileserv)…"
  $COMPOSE up -d $CORE_SERVICES
  echo -e "  ${GREEN}✓ Core services started${RESET}"

  # Start Docker-managed AI backends that are not already running
  if [[ -n "$START_PROFILES" ]]; then
    echo ">>> Starting Docker AI backends (${AI_BACKEND_GPU^^})…"
    # shellcheck disable=SC2086
    $COMPOSE $START_PROFILES up -d
    echo -e "  ${GREEN}✓ Docker AI backends started${RESET}"
  else
    echo "  (All AI backends already running or using local installations)"
  fi

  # Monitoring (optional)
  echo ""
  read -r -p "  Start monitoring services (Prometheus / Grafana)? [y/N]: " MON
  if [[ "${MON,,}" == "y" ]]; then
    echo ">>> Starting monitoring…"
    $COMPOSE up -d $MONITOR_SERVICES
    echo -e "  ${GREEN}✓ Monitoring started${RESET}"
  fi

  # ── Wait for the web service to actually serve HTTP ──────────────────────
  # On Windows/WSL2 boot the web container runs migrations + collectstatic before
  # it starts accepting requests.  Poll until we get an HTTP response so the
  # operator isn't greeted with a "login failed" screen.
  echo ""
  echo -n ">>> Waiting for web service"
  _WEB_ATTEMPTS=0
  _WEB_MAX=90   # 90 × 2 s = 3 minutes
  _WEB_OK=false
  while [[ "$_WEB_ATTEMPTS" -lt "$_WEB_MAX" ]]; do
    HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 3 http://localhost/ 2>/dev/null || echo "000")
    if [[ "$HTTP_CODE" == "200" || "$HTTP_CODE" == "302" || "$HTTP_CODE" == "301" ]]; then
      _WEB_OK=true
      break
    fi
    # Also check if the container exited (crash loop)
    WEB_STATE=$($COMPOSE ps web --format "{{.Status}}" 2>/dev/null | head -1)
    if echo "$WEB_STATE" | grep -qi "exited\|error"; then
      echo ""
      echo -e "  ${RED}✗ Web container exited unexpectedly.${RESET}"
      echo "    Check logs:  ./RakshaGIS.sh logs web"
      return 1
    fi
    _WEB_ATTEMPTS=$((_WEB_ATTEMPTS + 1))
    echo -n "."
    sleep 2
  done
  echo ""

  if [[ "$_WEB_OK" == "true" ]]; then
    echo -e "  ${GREEN}✓ RakshaGIS is ready at http://localhost${RESET}"
  else
    echo -e "  ${YELLOW}⚠  Web service is still starting up (migrations may still be running).${RESET}"
    echo "    Check status:  ./RakshaGIS.sh logs web"
    echo "    Try again in a moment:  http://localhost"
  fi
  echo "  Admin: http://localhost/admin/"
  echo ""
  echo -e "  ${CYAN}Go to Settings → AI Config to activate an AI backend.${RESET}"
  echo ""
}

do_stop() {
  echo ">>> Stopping all services…"
  # shellcheck disable=SC2086
  $COMPOSE $ALL_PROFILE_FLAGS stop
  echo -e "  ${GREEN}✓ All services stopped (containers preserved)${RESET}"
}

do_restart() {
  echo ">>> Restarting core services…"
  $COMPOSE restart $CORE_SERVICES
  if [[ -n "$DOCKER_PROFILES" ]]; then
    echo ">>> Restarting Docker AI backends…"
    # shellcheck disable=SC2086
    $COMPOSE $DOCKER_PROFILES restart
  fi
  echo -e "  ${GREEN}✓ Services restarted${RESET}"
}

do_logs() {
  SERVICE="${1:-web}"
  echo ">>> Logs for: $SERVICE (Ctrl+C to exit)"
  echo ""
  $COMPOSE logs -f --tail=100 "$SERVICE"
}

do_backup() {
  BACKUP_DIR="$DATA_DIR/backups"
  TIMESTAMP=$(date +%Y%m%d_%H%M%S)
  BACKUP_FILE="$BACKUP_DIR/rakshagis_backup_${TIMESTAMP}.sql.gz"

  if [[ ! -d "$BACKUP_DIR" ]]; then
    if ! mkdir -p "$BACKUP_DIR" 2>/dev/null; then
      sudo mkdir -p "$BACKUP_DIR"
      sudo chmod 777 "$BACKUP_DIR"
    fi
  fi
  echo ">>> Creating database backup…"

  DB_NAME=$($COMPOSE exec -T web sh -c 'echo $DB_NAME' 2>/dev/null || echo "rakshagis")
  DB_USER=$($COMPOSE exec -T web sh -c 'echo $DB_USER' 2>/dev/null || echo "raksha")

  if ! touch "$BACKUP_FILE" 2>/dev/null; then
    local temp_backup="/tmp/$(basename "$BACKUP_FILE")"
    $COMPOSE exec -T db pg_dump -U "$DB_USER" "$DB_NAME" | gzip > "$temp_backup"
    sudo mv "$temp_backup" "$BACKUP_FILE"
    sudo chmod 644 "$BACKUP_FILE"
  else
    $COMPOSE exec -T db pg_dump -U "$DB_USER" "$DB_NAME" | gzip > "$BACKUP_FILE"
  fi
  echo -e "  ${GREEN}✓ Backup saved: $BACKUP_FILE${RESET}"
  if [[ -f "$BACKUP_FILE" ]]; then
    echo "    Size: $(du -sh "$BACKUP_FILE" 2>/dev/null | cut -f1 || echo "unknown")"
  else
    echo "    Size: $(sudo du -sh "$BACKUP_FILE" 2>/dev/null | cut -f1 || echo "unknown")"
  fi
}

do_update() {
  echo ">>> Pulling latest images…"
  PULL_SVCS="db redis nginx pg_tileserv prometheus grafana"
  # Add Ollama image only if managed via Docker (not using a local host install)
  [[ "$OLLAMA_STATUS" != "local (host)" ]] && PULL_SVCS="$PULL_SVCS ollama"
  # shellcheck disable=SC2086
  $COMPOSE $ALL_PROFILE_FLAGS pull --ignore-pull-failures $PULL_SVCS 2>/dev/null || true

  echo ">>> Rebuilding app image…"
  $COMPOSE build web

  echo ">>> Restarting all services…"
  # shellcheck disable=SC2086
  $COMPOSE $ALL_PROFILE_FLAGS up -d --remove-orphans

  echo ">>> Running migrations…"
  $COMPOSE exec web python manage.py makemigrations --no-input
  $COMPOSE exec web python manage.py migrate --no-input

  echo -e "  ${GREEN}✓ Update complete${RESET}"
}

# ── Main ──────────────────────────────────────────────────────────────────────

print_banner
print_info

COMMAND="${1:-status}"

case "$COMMAND" in
  start)   do_start ;;
  stop)    do_stop ;;
  restart) do_restart ;;
  status)  do_status ;;
  logs)    do_logs "${2:-web}" ;;
  backup)  do_backup ;;
  update)  do_update ;;
  info)    ;; # already printed by print_info above
  *)
    echo "Usage: $0 {start|stop|restart|status|logs [service]|backup|update|info}"
    echo ""
    echo "  start    — Start all services (core + AI backends + optional monitoring)"
    echo "  stop     — Stop all running services"
    echo "  restart  — Restart all services"
    echo "  status   — Show service status + storage info"
    echo "  logs     — Tail logs (default: web;  pass service name as 2nd arg)"
    echo "  backup   — Create PostgreSQL database backup"
    echo "  update   — Pull latest images, rebuild app, run migrations, restart"
    echo "  info     — Show storage location and disk usage"
    echo ""
    exit 1
    ;;
esac
