#!/bin/bash
# RakshaGIS — Development Docker Setup (WSL2 / local machine)
set -e

BOLD='\033[1m'; GREEN='\033[0;32m'; CYAN='\033[0;36m'; RESET='\033[0m'

echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║          RakshaGIS — Dev Setup                      ║"
echo "╚══════════════════════════════════════════════════════╝"
echo ""

read -rp "  Data directory [$(pwd)/data]: " DATA_DIR
DATA_DIR="${DATA_DIR:-$(pwd)/data}"
DATA_DIR="${DATA_DIR%/}"

mkdir -p \
    "$DATA_DIR/postgres" \
    "$DATA_DIR/redis" \
    "$DATA_DIR/media/gis_data" \
    "$DATA_DIR/staticfiles" \
    "$DATA_DIR/logs" \
    "$DATA_DIR/models/ollama" \
    "$DATA_DIR/models/localai" \
    "$DATA_DIR/models/llamacpp" \
    "$DATA_DIR/models/anythingllm"
echo "  ✓ Directories created at $DATA_DIR"

# ── GPU detection ─────────────────────────────────────────────────────────────
_detect_nvidia_gpu() {
  command -v nvidia-smi &>/dev/null && nvidia-smi --query-gpu=name --format=csv,noheader &>/dev/null
}

GPU_MODE="cpu"
GPU_PROFILE_SUFFIX=""

echo ""
echo -e "${BOLD}>>> GPU Detection${RESET}"
if _detect_nvidia_gpu; then
  GPU_NAMES=$(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -3)
  echo -e "  ${GREEN}NVIDIA GPU detected:${RESET}"
  while IFS= read -r g; do echo "    • $g"; done <<< "$GPU_NAMES"
  echo ""
  echo "  [1] CPU only   — works on any machine, slower inference"
  echo "  [2] NVIDIA GPU — faster inference (requires NVIDIA Container Toolkit)"
  read -rp "  Choose compute mode [1]: " GPU_CHOICE
  if [[ "${GPU_CHOICE:-1}" == "2" ]]; then
    if docker run --rm --gpus all nvidia/cuda:12.0-base-ubuntu22.04 nvidia-smi &>/dev/null 2>&1; then
      GPU_MODE="nvidia"
      GPU_PROFILE_SUFFIX="-gpu"
      echo -e "  ${GREEN}✓ NVIDIA GPU mode selected${RESET}"
    else
      echo "  ⚠ NVIDIA Container Toolkit not detected — falling back to CPU."
    fi
  else
    echo -e "  ${GREEN}✓ CPU mode selected${RESET}"
  fi
else
  echo "  No NVIDIA GPU found — CPU mode will be used."
fi
echo ""

# ── AI Backend Detection ──────────────────────────────────────────────────────
_port_up() { curl -sf --connect-timeout 2 "$1" &>/dev/null; }

# Ollama: prefer local install over Docker
if command -v ollama &>/dev/null && _port_up "http://localhost:11434/api/tags"; then
  OLLAMA_BASE_URL_VAL="http://host.docker.internal:11434"
  OLLAMA_PROF_FLAG=""
  echo ">>> Ollama: local installation found — Docker Ollama will NOT start."
else
  OLLAMA_BASE_URL_VAL="http://ollama:11434"
  OLLAMA_PROF_FLAG="--profile docker-ollama${GPU_PROFILE_SUFFIX}"
  echo ">>> Ollama: no local install — Docker Ollama will start (${GPU_MODE^^} mode)."
fi

# All three AI backends always started; admin picks the active one in the UI.
AI_BACKENDS="localai llamacpp anythingllm"
AI_PROF_FLAGS=""
for backend in $AI_BACKENDS; do
  AI_PROF_FLAGS="$AI_PROF_FLAGS --profile ${backend}${GPU_PROFILE_SUFFIX}"
done
ALL_PROFILE_FLAGS="${OLLAMA_PROF_FLAG}${AI_PROF_FLAGS}"
echo ">>> AI backends: $AI_BACKENDS (${GPU_MODE^^})"
echo ""

# ── Write .env ────────────────────────────────────────────────────────────────
SECRET_KEY=$(python3 -c "import secrets; print(secrets.token_urlsafe(50))")

cat > .env <<ENV
DEBUG=True
SECRET_KEY=${SECRET_KEY}
ALLOWED_HOSTS=localhost,127.0.0.1,0.0.0.0

# Host path — mapped to /data inside containers
DATA_DIR=${DATA_DIR}

DB_NAME=rakshagis
DB_USER=raksha
DB_PASSWORD=raksha_dev_pass
DB_HOST=db
DB_PORT=5432

REDIS_URL=redis://redis:6379/0
CELERY_BROKER_URL=redis://redis:6379/1

OLLAMA_BASE_URL=${OLLAMA_BASE_URL_VAL}
OLLAMA_HOST_URL=http://host.docker.internal:11434
OLLAMA_DOCKER_URL=http://ollama:11434
OLLAMA_MODEL=llama3.2

LOCALAI_BASE_URL=http://localai:8080
LLAMACPP_BASE_URL=http://llamacpp:8081
ANYTHINGLLM_BASE_URL=http://anythingllm:3001/api/v1/openai

# AI compute mode — used by RakshaGIS.sh to pick correct profiles
AI_BACKEND_GPU=${GPU_MODE}
AI_BACKENDS=localai llamacpp anythingllm

DJANGO_SETTINGS_MODULE=config.settings.development
ENV

chmod 600 .env
echo "  ✓ .env written"

# ── Build & start ─────────────────────────────────────────────────────────────
echo ""
echo "  Building images…"
docker compose build --quiet

echo "  Starting DB and Redis first…"
docker compose up -d db redis
echo "  Waiting 15 s for PostgreSQL to initialise…"
sleep 15

echo "  Running migrations…"
docker compose -f docker-compose.yml -f docker-compose.dev.yml run --rm web python manage.py migrate

echo ""
read -rp "  Create superuser? [Y/n]: " CREATE_SUPER
if [[ "${CREATE_SUPER,,}" != "n" ]]; then
  docker compose -f docker-compose.yml -f docker-compose.dev.yml run --rm web python manage.py createsuperuser
fi

echo "  Starting all services (dev mode — no Nginx)…"
# shellcheck disable=SC2086
docker compose -f docker-compose.yml -f docker-compose.dev.yml $ALL_PROFILE_FLAGS up -d

echo ""
echo -e "  ${GREEN}✓ Dev environment running${RESET}"
echo "  App:      http://localhost:8000"
echo "  Admin:    http://localhost:8000/admin/"
echo "  API docs: http://localhost:8000/api/docs/"
echo "  Data:     $DATA_DIR"
echo ""
echo -e "  ${CYAN}AI backends started: $AI_BACKENDS${RESET}"
echo "  Go to Settings → AI Config to activate the backend you want to use."
echo ""
echo "  Useful dev commands:"
echo "    make dc-logs     — follow logs"
echo "    make dc-shell    — Django shell"
echo "    make dc-migrate  — run migrations"
