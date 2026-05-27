#!/bin/bash
# RakshaGIS build / setup script
# Usage: ./build.sh [--data-dir /path] [--save-images] [--load-images /path]
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_DATA_DIR="/RakshaGIS"

print_banner() {
  echo ""
  echo "╔══════════════════════════════════════════════════════╗"
  echo "║            RakshaGIS — Build & Setup                ║"
  echo "╚══════════════════════════════════════════════════════╝"
  echo ""
}

usage() {
  echo "Usage: $0 [OPTIONS]"
  echo ""
  echo "  Production setup (default) — builds images, detects GPU, starts all services."
  echo "  For local development:  $0 --dev   (uses DEBUG=True, port 8000, no Nginx)"
  echo ""
  echo "Options:"
  echo "  --dev               Run development setup (delegates to setup-dev.sh)"
  echo "  --data-dir  DIR     Set data directory (default: $DEFAULT_DATA_DIR)"
  echo "  --save-images       Save all Docker images as tarballs in data-dir/images/"
  echo "  --load-images DIR   Load Docker images from tarballs in DIR"
  echo "  --no-build          Skip Docker image build (use existing images)"
  echo "  -h, --help          Show this help"
  echo ""
}

# Parse arguments
DATA_DIR=""
SAVE_IMAGES=false
LOAD_IMAGES_DIR=""
NO_BUILD=false
FORCE_BUILD=false

while [[ $# -gt 0 ]]; do
  case $1 in
    --dev)
      echo "Delegating to setup-dev.sh..."
      exec "$(dirname "$0")/setup-dev.sh"
      ;;
    --data-dir)
      DATA_DIR="$2"; shift 2 ;;
    --save-images)
      SAVE_IMAGES=true; shift ;;
    --load-images)
      LOAD_IMAGES_DIR="$2"; shift 2 ;;
    --no-build)
      NO_BUILD=true; shift ;;
    --force-build)
      FORCE_BUILD=true; shift ;;
    -h|--help)
      usage; exit 0 ;;
    *)
      echo "Unknown option: $1"; usage; exit 1 ;;
  esac
done

print_banner

# ── GPU detection ─────────────────────────────────────────────────────────────
BOLD='\033[1m'; CYAN='\033[0;36m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'; RED='\033[0;31m'; RESET='\033[0m'

_detect_nvidia_gpu() {
  command -v nvidia-smi &>/dev/null && nvidia-smi --query-gpu=name --format=csv,noheader &>/dev/null
}

GPU_MODE="cpu"        # cpu | nvidia
GPU_PROFILE_SUFFIX="" # "" for CPU, "-gpu" for NVIDIA

echo -e "${BOLD}>>> GPU Detection${RESET}"
if _detect_nvidia_gpu; then
  GPU_NAMES=$(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -3)
  echo -e "  ${GREEN}NVIDIA GPU detected:${RESET}"
  while IFS= read -r g; do echo "    • $g"; done <<< "$GPU_NAMES"
  echo ""
  echo -e "  ${CYAN}Which compute mode do you want for AI backends?${RESET}"
  echo "  [1] CPU only    — works on any machine, slower inference"
  echo "  [2] NVIDIA GPU  — faster inference (requires NVIDIA Container Toolkit)"
  echo ""
  read -rp "  Your choice [1]: " GPU_CHOICE
  case "${GPU_CHOICE:-1}" in
    2)
      GPU_MODE="nvidia"
      GPU_PROFILE_SUFFIX="-gpu"
      echo -e "  ${GREEN}✓ NVIDIA GPU mode selected${RESET}"
      # Verify NVIDIA Container Toolkit is installed
      if ! docker run --rm --gpus all nvidia/cuda:12.0-base-ubuntu22.04 nvidia-smi &>/dev/null 2>&1; then
        echo ""
        echo -e "  ${YELLOW}⚠  NVIDIA Container Toolkit not detected.${RESET}"
        echo "     Install it before starting GPU containers:"
        echo "     https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html"
        echo ""
        echo "  Falling back to CPU mode for now (you can switch later)."
        GPU_MODE="cpu"
        GPU_PROFILE_SUFFIX=""
      else
        echo -e "  ${GREEN}✓ NVIDIA Container Toolkit verified${RESET}"
      fi
      ;;
    *)
      GPU_MODE="cpu"
      GPU_PROFILE_SUFFIX=""
      echo -e "  ${GREEN}✓ CPU mode selected${RESET}"
      ;;
  esac
else
  echo "  No NVIDIA GPU found — CPU mode will be used."
fi
echo ""

# ── AI Backend Detection ──────────────────────────────────────────────────────
# For each backend: local binary/port → Docker running → Docker stopped → install
# Priority: local install wins; then existing Docker container; then fresh Docker install.
echo -e "${BOLD}>>> AI Backend Detection${RESET}"
printf "  %-14s %-42s %s\n" "Backend" "Status" "URL"
printf "  %-14s %-42s %s\n" "-------" "------" "---"

# ── Detection helpers ─────────────────────────────────────────────────────────
# Check if a compose service container is currently running (uses Docker labels)
_svc_running() {
  docker ps \
    --filter "label=com.docker.compose.service=$1" \
    --format "{{.ID}}" 2>/dev/null | grep -q .
}
# Check if a compose service container exists at all (running OR stopped)
_svc_exists() {
  docker ps -a \
    --filter "label=com.docker.compose.service=$1" \
    --format "{{.ID}}" 2>/dev/null | grep -q .
}
# Check if a URL responds
_port_up() { curl -sf --connect-timeout 2 "$1" &>/dev/null; }

# These variables are built up as we detect each backend:
DOCKER_PROFILES=""    # --profile flags for ALL Docker-managed backends
START_PROFILES=""     # --profile flags for backends that need `docker compose up`
AI_BACKENDS_DOCKER="" # base names of Docker-managed backends → saved to .env
OLLAMA_MODEL_VAL="llama3.2"

# ── Ollama ────────────────────────────────────────────────────────────────────
OLLAMA_PROF="docker-ollama${GPU_PROFILE_SUFFIX}"
OLLAMA_SVC="ollama${GPU_PROFILE_SUFFIX}"
printf "  %-14s " "Ollama:"
if command -v ollama &>/dev/null && _port_up "http://localhost:11434/api/tags"; then
  OLLAMA_MODEL_VAL=$(curl -s http://localhost:11434/api/tags | python3 -c \
    "import sys,json; ms=json.load(sys.stdin).get('models',[]); \
     print(ms[0]['name'].split(':')[0] if ms else 'llama3.2')" 2>/dev/null || echo "llama3.2")
  printf "${GREEN}✓ local binary running${RESET}                  "
  printf "http://localhost:11434  (model: %s)\n" "$OLLAMA_MODEL_VAL"
  OLLAMA_BASE_URL_VAL="http://host.docker.internal:11434"
elif _svc_running "$OLLAMA_SVC"; then
  printf "${GREEN}✓ Docker container running${RESET}               "
  printf "http://ollama:11434\n"
  OLLAMA_BASE_URL_VAL="http://ollama:11434"
  DOCKER_PROFILES="$DOCKER_PROFILES --profile $OLLAMA_PROF"
elif _svc_exists "$OLLAMA_SVC"; then
  printf "${YELLOW}▶ Docker container stopped — restarting${RESET}  "
  printf "http://ollama:11434\n"
  OLLAMA_BASE_URL_VAL="http://ollama:11434"
  DOCKER_PROFILES="$DOCKER_PROFILES --profile $OLLAMA_PROF"
  START_PROFILES="$START_PROFILES --profile $OLLAMA_PROF"
else
  printf "${RED}✗ not found — installing Docker (%s)${RESET}" "${GPU_MODE^^}"
  printf "          http://ollama:11434\n"
  OLLAMA_BASE_URL_VAL="http://ollama:11434"
  DOCKER_PROFILES="$DOCKER_PROFILES --profile $OLLAMA_PROF"
  START_PROFILES="$START_PROFILES --profile $OLLAMA_PROF"
fi

# ── LocalAI ───────────────────────────────────────────────────────────────────
LOCALAI_PROF="localai${GPU_PROFILE_SUFFIX}"
printf "  %-14s " "LocalAI:"
if _port_up "http://localhost:8080/v1/models"; then
  printf "${GREEN}✓ local service on :8080${RESET}                 "
  printf "http://localhost:8080\n"
  LOCALAI_BASE_URL_VAL="http://host.docker.internal:8080"
elif _svc_running "$LOCALAI_PROF"; then
  printf "${GREEN}✓ Docker container running${RESET}               "
  printf "http://localai:8080\n"
  LOCALAI_BASE_URL_VAL="http://localai:8080"
  DOCKER_PROFILES="$DOCKER_PROFILES --profile $LOCALAI_PROF"
  AI_BACKENDS_DOCKER="$AI_BACKENDS_DOCKER localai"
elif _svc_exists "$LOCALAI_PROF"; then
  printf "${YELLOW}▶ Docker container stopped — restarting${RESET}  "
  printf "http://localai:8080\n"
  LOCALAI_BASE_URL_VAL="http://localai:8080"
  DOCKER_PROFILES="$DOCKER_PROFILES --profile $LOCALAI_PROF"
  START_PROFILES="$START_PROFILES --profile $LOCALAI_PROF"
  AI_BACKENDS_DOCKER="$AI_BACKENDS_DOCKER localai"
else
  printf "${RED}✗ not found — installing Docker (%s)${RESET}" "${GPU_MODE^^}"
  printf "          http://localai:8080\n"
  LOCALAI_BASE_URL_VAL="http://localai:8080"
  DOCKER_PROFILES="$DOCKER_PROFILES --profile $LOCALAI_PROF"
  START_PROFILES="$START_PROFILES --profile $LOCALAI_PROF"
  AI_BACKENDS_DOCKER="$AI_BACKENDS_DOCKER localai"
fi

# ── LlamaCpp ──────────────────────────────────────────────────────────────────
LLAMACPP_PROF="llamacpp${GPU_PROFILE_SUFFIX}"
printf "  %-14s " "LlamaCpp:"
if command -v llama-server &>/dev/null || _port_up "http://localhost:8081/v1/models"; then
  printf "${GREEN}✓ local service on :8081${RESET}                 "
  printf "http://localhost:8081\n"
  LLAMACPP_BASE_URL_VAL="http://host.docker.internal:8081"
elif _svc_running "$LLAMACPP_PROF"; then
  printf "${GREEN}✓ Docker container running${RESET}               "
  printf "http://llamacpp:8081\n"
  LLAMACPP_BASE_URL_VAL="http://llamacpp:8081"
  DOCKER_PROFILES="$DOCKER_PROFILES --profile $LLAMACPP_PROF"
  AI_BACKENDS_DOCKER="$AI_BACKENDS_DOCKER llamacpp"
elif _svc_exists "$LLAMACPP_PROF"; then
  printf "${YELLOW}▶ Docker container stopped — restarting${RESET}  "
  printf "http://llamacpp:8081\n"
  LLAMACPP_BASE_URL_VAL="http://llamacpp:8081"
  DOCKER_PROFILES="$DOCKER_PROFILES --profile $LLAMACPP_PROF"
  START_PROFILES="$START_PROFILES --profile $LLAMACPP_PROF"
  AI_BACKENDS_DOCKER="$AI_BACKENDS_DOCKER llamacpp"
else
  printf "${RED}✗ not found — installing Docker (%s)${RESET}" "${GPU_MODE^^}"
  printf "          http://llamacpp:8081\n"
  LLAMACPP_BASE_URL_VAL="http://llamacpp:8081"
  DOCKER_PROFILES="$DOCKER_PROFILES --profile $LLAMACPP_PROF"
  START_PROFILES="$START_PROFILES --profile $LLAMACPP_PROF"
  AI_BACKENDS_DOCKER="$AI_BACKENDS_DOCKER llamacpp"
fi

# ── AnythingLLM ───────────────────────────────────────────────────────────────
ANYTHINGLLM_PROF="anythingllm${GPU_PROFILE_SUFFIX}"
printf "  %-14s " "AnythingLLM:"
if _port_up "http://localhost:3001/api/health"; then
  printf "${GREEN}✓ local service on :3001${RESET}                 "
  printf "http://localhost:3001\n"
  ANYTHINGLLM_BASE_URL_VAL="http://host.docker.internal:3001/api/v1/openai"
elif _svc_running "$ANYTHINGLLM_PROF"; then
  printf "${GREEN}✓ Docker container running${RESET}               "
  printf "http://anythingllm:3001\n"
  ANYTHINGLLM_BASE_URL_VAL="http://anythingllm:3001/api/v1/openai"
  DOCKER_PROFILES="$DOCKER_PROFILES --profile $ANYTHINGLLM_PROF"
  AI_BACKENDS_DOCKER="$AI_BACKENDS_DOCKER anythingllm"
elif _svc_exists "$ANYTHINGLLM_PROF"; then
  printf "${YELLOW}▶ Docker container stopped — restarting${RESET}  "
  printf "http://anythingllm:3001\n"
  ANYTHINGLLM_BASE_URL_VAL="http://anythingllm:3001/api/v1/openai"
  DOCKER_PROFILES="$DOCKER_PROFILES --profile $ANYTHINGLLM_PROF"
  START_PROFILES="$START_PROFILES --profile $ANYTHINGLLM_PROF"
  AI_BACKENDS_DOCKER="$AI_BACKENDS_DOCKER anythingllm"
else
  printf "${RED}✗ not found — installing Docker (%s)${RESET}" "${GPU_MODE^^}"
  printf "          http://anythingllm:3001\n"
  ANYTHINGLLM_BASE_URL_VAL="http://anythingllm:3001/api/v1/openai"
  DOCKER_PROFILES="$DOCKER_PROFILES --profile $ANYTHINGLLM_PROF"
  START_PROFILES="$START_PROFILES --profile $ANYTHINGLLM_PROF"
  AI_BACKENDS_DOCKER="$AI_BACKENDS_DOCKER anythingllm"
fi

AI_BACKENDS_DOCKER="${AI_BACKENDS_DOCKER# }"  # trim leading space
echo ""

# Combined profile flags used by pull / save / status commands
ALL_PROFILE_FLAGS="$DOCKER_PROFILES"

# ── Step 1: Determine data directory ─────────────────────────────────────────
if [[ -z "$DATA_DIR" ]]; then
  # Check if already set in .env
  if [[ -f "$SCRIPT_DIR/.env" ]]; then
    EXISTING=$(grep "^DATA_DIR=" "$SCRIPT_DIR/.env" | cut -d= -f2)
    if [[ -n "$EXISTING" ]]; then
      DATA_DIR="$EXISTING"
      echo "Using existing DATA_DIR from .env: $DATA_DIR"
    fi
  fi

  if [[ -z "$DATA_DIR" ]]; then
    read -r -p "Enter data directory [$DEFAULT_DATA_DIR]: " USER_INPUT
    DATA_DIR="${USER_INPUT:-$DEFAULT_DATA_DIR}"
  fi
fi

echo "Data directory: $DATA_DIR"

# ── Step 2: Create data directory structure ───────────────────────────────────
echo ""
echo ">>> Creating data directories..."
mkdir -p "$DATA_DIR"/{postgres,redis,staticfiles,media,logs,prometheus,grafana,backups,images} \
         "$DATA_DIR"/certbot/{conf,www} \
         "$DATA_DIR"/models/{ollama,localai,llamacpp,anythingllm}
chmod 777 "$DATA_DIR"/staticfiles "$DATA_DIR"/media "$DATA_DIR"/logs

echo "    ✓ Data directories created"

# ── Step 3: Generate / update .env ──────────────────────────────────────────
ENV_FILE="$SCRIPT_DIR/.env"

if [[ ! -f "$ENV_FILE" ]]; then
  echo ""
  echo ">>> Creating .env file..."

  read -r -s -p "Enter PostgreSQL password [press Enter for auto-generated]: " DB_PASS
  echo ""
  if [[ -z "$DB_PASS" ]]; then
    DB_PASS=$(openssl rand -base64 20 | tr -d '=+/' | head -c 24)
    echo "    Auto-generated DB password."
  fi

  SECRET_KEY=$(openssl rand -base64 50 | tr -d '\n')

  cat > "$ENV_FILE" <<EOF
DEBUG=False
SECRET_KEY=${SECRET_KEY}
ALLOWED_HOSTS=localhost,127.0.0.1

# Host path — mapped to /data inside containers
DATA_DIR=${DATA_DIR}

DB_NAME=rakshagis
DB_USER=raksha
DB_PASSWORD=${DB_PASS}
DB_HOST=db
DB_PORT=5432

REDIS_URL=redis://redis:6379/0
CELERY_BROKER_URL=redis://redis:6379/1

# Ollama — auto-configured by build.sh based on local vs Docker detection
OLLAMA_BASE_URL=${OLLAMA_BASE_URL_VAL}
OLLAMA_LOCAL_URL=http://host.docker.internal:11434
OLLAMA_DOCKER_URL=http://ollama:11434
OLLAMA_MODEL=${OLLAMA_MODEL_VAL}

# AI backends — URLs auto-configured by build.sh detection
LOCALAI_BASE_URL=${LOCALAI_BASE_URL_VAL}
LLAMACPP_BASE_URL=${LLAMACPP_BASE_URL_VAL}
ANYTHINGLLM_BASE_URL=${ANYTHINGLLM_BASE_URL_VAL}

# AI compute mode: cpu | nvidia  (set by build.sh GPU detection)
AI_BACKEND_GPU=${GPU_MODE}
# Space-separated list of Docker-managed AI backends (RakshaGIS.sh uses this)
AI_BACKENDS=${AI_BACKENDS_DOCKER}

DJANGO_SETTINGS_MODULE=config.settings.production

GRAFANA_PASSWORD=$(openssl rand -base64 12 | tr -d '=+/')
EOF
  echo "    ✓ .env created"
else
  # Update DATA_DIR and Ollama settings in existing .env
  _upsert_env() { local key=$1 val=$2
    grep -q "^${key}=" "$ENV_FILE" \
      && sed -i "s|^${key}=.*|${key}=${val}|" "$ENV_FILE" \
      || echo "${key}=${val}" >> "$ENV_FILE"
  }
  _upsert_env DATA_DIR            "${DATA_DIR}"
  _upsert_env OLLAMA_BASE_URL     "${OLLAMA_BASE_URL_VAL}"
  _upsert_env OLLAMA_LOCAL_URL    "http://host.docker.internal:11434"
  _upsert_env OLLAMA_DOCKER_URL   "http://ollama:11434"
  _upsert_env OLLAMA_MODEL        "${OLLAMA_MODEL_VAL}"
  _upsert_env LOCALAI_BASE_URL    "${LOCALAI_BASE_URL_VAL}"
  _upsert_env LLAMACPP_BASE_URL   "${LLAMACPP_BASE_URL_VAL}"
  _upsert_env ANYTHINGLLM_BASE_URL "${ANYTHINGLLM_BASE_URL_VAL}"
  _upsert_env AI_BACKEND_GPU      "${GPU_MODE}"
  _upsert_env AI_BACKENDS         "${AI_BACKENDS_DOCKER}"
  echo "    ✓ Updated .env (DATA_DIR + AI backend URLs + GPU settings)"
fi

# ── Step 4: Load Docker images from tarballs (offline install) ───────────────
if [[ -n "$LOAD_IMAGES_DIR" ]]; then
  echo ""
  echo ">>> Loading Docker images from $LOAD_IMAGES_DIR..."
  for tar_file in "$LOAD_IMAGES_DIR"/*.tar; do
    if [[ -f "$tar_file" ]]; then
      echo "    Loading: $(basename "$tar_file")"
      docker load -i "$tar_file"
    fi
  done
  echo "    ✓ Images loaded"
fi

# ── Step 5: Build application image ─────────────────────────────────────────
cd "$SCRIPT_DIR"

# ── Builder selection ────────────────────────────────────────────────────────
# Docker Desktop on WSL2 creates a custom buildx builder (mybuilder) that
# cannot resolve WSL2 bind-mount paths, causing build failures.
# Fix: always reset to the 'default' builder and use the legacy build engine
# on WSL2. On a dedicated Linux server the detection returns false and the
# standard compose build is used unchanged.
IS_WSL=false
if grep -qi microsoft /proc/version 2>/dev/null || grep -qi wsl /proc/version 2>/dev/null; then
  IS_WSL=true
fi

_docker_build() {
  if [[ "$IS_WSL" == true ]]; then
    echo "    (WSL2 detected — resetting to default buildx builder)"
    # Reset any custom buildx builder (e.g. mybuilder set by Docker Desktop)
    docker buildx use default 2>/dev/null || true
    # Disable BuildKit to use the legacy builder which has no bind-mount issues
    DOCKER_BUILDKIT=0 COMPOSE_DOCKER_CLI_BUILD=0 docker compose build web
  else
    # Dedicated / bare-metal Linux: standard build, no special flags needed
    # Still reset buildx to default as a safety measure
    docker buildx use default 2>/dev/null || true
    docker compose build web
  fi
}

if [[ "$NO_BUILD" == false ]]; then
  BUILD_HASH_FILE="$SCRIPT_DIR/.build-hash"
  HASH_SOURCES=("$SCRIPT_DIR/Dockerfile")
  [[ -f "$SCRIPT_DIR/requirements.txt" ]] && HASH_SOURCES+=("$SCRIPT_DIR/requirements.txt")
  [[ -f "$SCRIPT_DIR/pyproject.toml" ]]   && HASH_SOURCES+=("$SCRIPT_DIR/pyproject.toml")
  CURRENT_HASH=$(cat "${HASH_SOURCES[@]}" 2>/dev/null | sha256sum | cut -d' ' -f1)

  NEEDS_BUILD=true
  if [[ "$FORCE_BUILD" == false ]] && [[ -f "$BUILD_HASH_FILE" ]]; then
    if [[ "$(cat "$BUILD_HASH_FILE" 2>/dev/null)" == "$CURRENT_HASH" ]]; then
      NEEDS_BUILD=false
    fi
  fi

  if [[ "$NEEDS_BUILD" == true ]]; then
    echo ""
    echo ">>> Building RakshaGIS Docker image..."
    [[ "$IS_WSL" == true ]] && echo "    (WSL2 detected — using legacy builder)"
    _docker_build
    echo "$CURRENT_HASH" > "$BUILD_HASH_FILE"
    echo "    ✓ Image built"
  else
    echo ""
    echo "    ✓ Dockerfile/requirements unchanged — skipping image build."
    echo "      (Use --force-build to rebuild anyway)"
  fi
fi

# ── Step 6: Pull all dependency images ──────────────────────────────────────
if [[ -z "$LOAD_IMAGES_DIR" ]]; then
  echo ""
  echo ">>> Pulling dependency images..."
  PULL_SERVICES="db redis nginx pg_tileserv prometheus grafana certbot"
  # Add Ollama image only if we're managing it via Docker (OLLAMA_BASE_URL points to Docker)
  [[ "$OLLAMA_BASE_URL_VAL" == "http://ollama:11434" ]] && \
    PULL_SERVICES="$PULL_SERVICES ollama${GPU_PROFILE_SUFFIX}"
  # shellcheck disable=SC2086
  docker compose $ALL_PROFILE_FLAGS pull --ignore-pull-failures $PULL_SERVICES
  echo "    ✓ Images pulled"
fi

# ── Step 7: Save Docker images to data dir (for offline deployment) ──────────
if [[ "$SAVE_IMAGES" == true ]]; then
  IMAGES_DIR="$DATA_DIR/images"
  echo ""
  echo ">>> Saving Docker images to $IMAGES_DIR..."
  mkdir -p "$IMAGES_DIR"

  IMAGES=(
    "postgis/postgis:16-3.4"
    "redis:7-alpine"
    "nginx:alpine"
    "pramsey/pg_tileserv:latest"
    "ollama/ollama:latest"
    "prom/prometheus:latest"
    "grafana/grafana:latest"
    "certbot/certbot:latest"
  )

  # Also save the built app image
  APP_IMAGE=$(docker compose config | grep "image:" | head -1 | awk '{print $2}' || echo "rakshagis-web")

  for img in "${IMAGES[@]}"; do
    safe_name=$(echo "$img" | tr '/:' '_')
    echo "    Saving: $img"
    docker save "$img" -o "$IMAGES_DIR/${safe_name}.tar" 2>/dev/null && echo "      ✓ Saved" || echo "      ⚠ Skipped (image not pulled)"
  done

  # Save app image
  APP_IMG_NAME=$(docker compose images web --format json 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(d[0]['Image'] if d else '')" 2>/dev/null || echo "")
  if [[ -n "$APP_IMG_NAME" ]]; then
    echo "    Saving app image: $APP_IMG_NAME"
    docker save "$APP_IMG_NAME" -o "$IMAGES_DIR/rakshagis_app.tar"
    echo "      ✓ Saved"
  fi

  echo "    ✓ All images saved to $IMAGES_DIR"
fi

# ── Step 8: Initialize database and seed data ────────────────────────────────
echo ""
echo ">>> Starting core services (db + redis) for migrations..."
docker compose up -d db redis
echo "    Waiting for database to be ready..."
sleep 8

echo ""
echo ">>> Running migrations and seeding data..."
docker compose run --rm web python manage.py makemigrations --no-input
docker compose run --rm web python manage.py migrate --no-input
docker compose run --rm web python manage.py seed_basemaps
docker compose run --rm web python manage.py init_folders

# Create superadmin if not exists
docker compose run --rm web python manage.py shell -c "
from django.contrib.auth import get_user_model
User = get_user_model()
if not User.objects.filter(username='admin').exists():
    User.objects.create_superuser('admin', 'admin@rakshagis.local', 'admin123', role='SUPERADMIN')
    print('Superadmin created: admin / admin123')
else:
    print('Superadmin already exists')
"

# ── Step 9: Build frontend ────────────────────────────────────────────────────
if command -v node &> /dev/null && [[ -d "$SCRIPT_DIR/frontend" ]]; then
  echo ""
  echo ">>> Building React frontend..."
  cd "$SCRIPT_DIR/frontend"
  npm install --silent
  npm run build
  cd "$SCRIPT_DIR"
  docker compose run --rm web python manage.py collectstatic --no-input
  echo "    ✓ Frontend built and static files collected"
else
  echo ""
  echo "    ⚠ Node.js not found — skipping frontend build."
  echo "      Run: cd frontend && npm install && npm run build"
  echo "      Then: docker compose run --rm web python manage.py collectstatic --no-input"
fi

# ── Step 10: Start all services ───────────────────────────────────────────────
echo ""
echo -e "${BOLD}>>> Starting all services...${RESET}"
echo "  Compute mode : ${GPU_MODE^^}"
[[ -n "$AI_BACKENDS_DOCKER" ]] \
  && echo "  AI (Docker)  : $AI_BACKENDS_DOCKER" \
  || echo "  AI (Docker)  : none (all using local installs)"

# Core application services (always started)
echo "  ▶ Starting core services (db · redis · web · celery · nginx · pg_tileserv)..."
docker compose up -d
echo -e "  ${GREEN}✓ Core services running${RESET}"

# Start only backends that are NOT already running (START_PROFILES built by detection)
if [[ -n "$START_PROFILES" ]]; then
  echo "  ▶ Starting Docker AI backends..."
  # shellcheck disable=SC2086
  docker compose $START_PROFILES up -d
  echo -e "  ${GREEN}✓ Docker AI backends started${RESET}"
else
  echo "  ✓ AI backends: all already running or using local installations"
fi

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║                RakshaGIS Setup Complete                 ║"
echo "╠══════════════════════════════════════════════════════════╣"
printf "║  Data directory  : %-35s║\n" "${DATA_DIR}"
printf "║  Compute mode    : %-35s║\n" "${GPU_MODE^^}"
printf "║  AI backends     : %-35s║\n" "${AI_BACKENDS_DOCKER:-local only}"
echo "║  Default login   : admin / admin123                     ║"
echo "║  Access URL      : http://localhost                     ║"
echo "╠══════════════════════════════════════════════════════════╣"
echo "║  Use './RakshaGIS.sh start|stop|restart|status'         ║"
echo "║  Go to Settings → AI Config to activate a backend       ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""
