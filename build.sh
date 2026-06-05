#!/bin/bash
# RakshaGIS build / setup script
# Usage: ./build.sh [--data-dir /path] [--save-images] [--load-images /path]
#
# MULTI-PROJECT SAFETY
#   This script is safe to run on a dedicated server that already hosts other
#   Docker projects.  It:
#     • uses project name "rakshagis" (COMPOSE_PROJECT_NAME) so all containers,
#       networks, and volumes are namespaced and cannot collide with others
#     • NEVER runs docker system prune, docker volume prune, or docker rmi on
#       images it did not build
#     • detects whether required images (postgres, redis, nginx, onlyoffice…)
#       are already cached locally; if so, skips pulling — it does NOT use
#       another project's running containers, it only reuses the cached image
#     • detects port 80 conflicts and offers a configurable host port
#     • filters all container existence checks by COMPOSE_PROJECT_NAME so a
#       service named "db" in another project is never confused with ours
set -e

# ── Dynamic sudo wrapping for Docker and System Actions ─────────────────────────
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

mkdir_p_safe() {
  local dir="$1"
  if [[ ! -d "$dir" ]]; then
    if ! mkdir -p "$dir" 2>/dev/null; then
      echo "    Access restricted. Using sudo to create directory: $dir"
      sudo mkdir -p "$dir"
    fi
  fi
}

chmod_safe() {
  local mode="$1"
  local path="$2"
  if ! chmod "$mode" "$path" 2>/dev/null; then
    sudo chmod "$mode" "$path"
  fi
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_DATA_DIR="/RakshaGIS"

# ── Project isolation ──────────────────────────────────────────────────────────
# All Docker resources created by this project are prefixed "rakshagis_".
# This prevents collisions with any other Docker Compose project on the host.
export COMPOSE_PROJECT_NAME=rakshagis

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
  echo "  --import-osm        Download India OSM data and import into local tile server"
  echo "                      Requires internet once. Import takes 2-4 hours."
  echo "  --port PORT         Host port for the web UI nginx (default: 80)."
  echo "                      Use when port 80 is already occupied by another project."
  echo "  -h, --help          Show this help"
  echo ""
}

# Parse arguments
DATA_DIR=""
SAVE_IMAGES=false
LOAD_IMAGES_DIR=""
NO_BUILD=false
FORCE_BUILD=false
IMPORT_OSM=false
HOST_PORT=""      # override for nginx host port (default 80)

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
    --import-osm)
      IMPORT_OSM=true; shift ;;
    --port)
      HOST_PORT="$2"; shift 2 ;;
    -h|--help)
      usage; exit 0 ;;
    *)
      echo "Unknown option: $1"; usage; exit 1 ;;
  esac
done

print_banner

BOLD='\033[1m'; CYAN='\033[0;36m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'; RED='\033[0;31m'; RESET='\033[0m'

# ── Multi-project safety check ────────────────────────────────────────────────
echo -e "${BOLD}>>> Environment check${RESET}"

# Confirm Docker is available
if ! command -v docker &>/dev/null; then
  echo -e "  ${RED}✗ Docker not found. Please install Docker Engine first.${RESET}"
  exit 1
fi
echo -e "  ${GREEN}✓ Docker found:${RESET} $(docker --version)"

# List other running Compose projects so the operator can see the landscape
OTHER_PROJECTS=$(docker ps --format '{{.Label "com.docker.compose.project"}}' 2>/dev/null \
  | sort -u | grep -v "^$" | grep -v "^rakshagis$" || true)
if [[ -n "$OTHER_PROJECTS" ]]; then
  echo ""
  echo -e "  ${YELLOW}Other Docker Compose projects currently running on this host:${RESET}"
  while IFS= read -r proj; do
    echo "    • $proj"
  done <<< "$OTHER_PROJECTS"
  echo ""
  echo -e "  ${CYAN}RakshaGIS runs as project 'rakshagis' — fully isolated via${RESET}"
  echo "  COMPOSE_PROJECT_NAME, separate networks (rakshagis_raksha-net /rakshagis_raksha-edge),"
  echo "  and volume names prefixed rakshagis_. No other project's resources will"
  echo "  be touched, removed, or restarted."
else
  echo -e "  ${GREEN}✓ No other Compose projects currently running.${RESET}"
fi

# ── Port conflict check ───────────────────────────────────────────────────────
# If the operator did not pass --port, auto-detect whether port 80 is free.
# If it is occupied by a different project, prompt for an alternative port.
if [[ -z "$HOST_PORT" ]]; then
  if ss -tlnp 2>/dev/null | grep -q ':80 ' || \
     netstat -tlnp 2>/dev/null | grep -q ':80 '; then
    # Port 80 in use — find out who by checking if it is our own nginx
    NGINX_OWNER=$(docker ps --format '{{.Ports}}\t{{.Label "com.docker.compose.project"}}' 2>/dev/null \
      | grep "0.0.0.0:80->" | awk '{print $2}' | head -1)
    if [[ "$NGINX_OWNER" == "rakshagis" ]]; then
      HOST_PORT=80
      echo -e "  ${GREEN}✓ Port 80 already held by RakshaGIS nginx — OK.${RESET}"
    else
      echo ""
      echo -e "  ${YELLOW}⚠  Port 80 is already in use${RESET} (by: ${NGINX_OWNER:-unknown process})."
      echo "  RakshaGIS nginx cannot bind to port 80 without displacing it."
      echo "  Enter a different host port for the RakshaGIS web UI (e.g. 8080, 8090, 9080),"
      echo "  or press Enter to use 8080:"
      read -rp "  Host port [8080]: " PORT_CHOICE
      HOST_PORT="${PORT_CHOICE:-8080}"
      echo -e "  ${CYAN}✓ Using port ${HOST_PORT} for RakshaGIS.${RESET}"
    fi
  else
    HOST_PORT=80
    echo -e "  ${GREEN}✓ Port 80 is free.${RESET}"
  fi
fi

# Write the chosen port into the project .env so docker compose picks it up,
# and patch docker-compose.yml's nginx port binding at compose runtime via
# the RAKSHAGIS_HTTP_PORT env var (see docker-compose.yml nginx ports section).
_upsert_env_early() { local key=$1 val=$2 file="$SCRIPT_DIR/.env"
  if [[ -f "$file" ]]; then
    grep -q "^${key}=" "$file" \
      && sed -i "s|^${key}=.*|${key}=${val}|" "$file" \
      || echo "${key}=${val}" >> "$file"
  fi
  # Also export for the remainder of this script session
  export "${key}=${val}"
}
# Export immediately so docker compose commands in this script use the right port
export RAKSHAGIS_HTTP_PORT="${HOST_PORT}"
export RAKSHAGIS_HTTPS_PORT="${HTTPS_PORT:-443}"
echo ""

# ── GPU detection ─────────────────────────────────────────────────────────────

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
# Both helpers filter by BOTH the service name AND the RakshaGIS project name so
# a container named "db" or "redis" in any *other* Compose project on this host
# is never confused with ours.
_svc_running() {
  docker ps \
    --filter "label=com.docker.compose.project=${COMPOSE_PROJECT_NAME}" \
    --filter "label=com.docker.compose.service=$1" \
    --format "{{.ID}}" 2>/dev/null | grep -q .
}
_svc_exists() {
  docker ps -a \
    --filter "label=com.docker.compose.project=${COMPOSE_PROJECT_NAME}" \
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

# Function to detect SSD vs HDD type
detect_drive_type() {
  local dev="$1"
  if [[ -z "$dev" ]]; then
    echo "Unknown"
    return
  fi
  
  if [[ "$dev" == /dev/mapper/* ]]; then
    local real_dev
    real_dev=$(readlink -f "$dev" 2>/dev/null)
    if [[ -n "$real_dev" ]]; then
      dev="$real_dev"
    fi
  fi
  
  local base_dev
  base_dev=$(basename "$dev" 2>/dev/null)
  if [[ "$base_dev" =~ ^nvme ]]; then
    base_dev=$(echo "$base_dev" | sed -E 's/p[0-9]+.*$//')
  elif [[ "$base_dev" =~ ^mmcblk ]]; then
    base_dev=$(echo "$base_dev" | sed -E 's/p[0-9]+.*$//')
  else
    base_dev=$(echo "$base_dev" | sed -E 's/[0-9]+.*$//')
  fi
  
  if [[ -f "/sys/block/${base_dev}/queue/rotational" ]]; then
    local rot
    rot=$(cat "/sys/block/${base_dev}/queue/rotational" 2>/dev/null)
    if [[ "$rot" == "0" ]]; then
      echo "SSD"
    elif [[ "$rot" == "1" ]]; then
      echo "HDD"
    else
      echo "Unknown"
    fi
  else
    echo "Unknown"
  fi
}

# ── Step 1: Determine data directory ─────────────────────────────────────────
DATA_DIR_IS_NEW=false
if [[ -z "$DATA_DIR" ]]; then
  # Check if already set in .env (existing install — skip interactive selection)
  if [[ -f "$SCRIPT_DIR/.env" ]]; then
    EXISTING=$(grep "^DATA_DIR=" "$SCRIPT_DIR/.env" | cut -d= -f2)
    if [[ -n "$EXISTING" ]]; then
      DATA_DIR="$EXISTING"
      echo "Using existing DATA_DIR from .env: $DATA_DIR"
    fi
  fi

  if [[ -z "$DATA_DIR" ]]; then
    DATA_DIR_IS_NEW=true
    echo -e "${BOLD}>>> Configure Storage Location${RESET}"
    echo "  RakshaGIS stores ALL its data (database, media, AI models, map tiles,"
    echo "  and Docker image archives) under ONE directory you choose now."
    echo "  This does NOT change Docker's data-root — all other Docker applications"
    echo "  on this host remain completely unaffected."
    echo ""
    echo "  Scanning available drives..."
    echo ""

    # Build numbered list of physical partitions, sorted by free space (largest first)
    declare -a _MNT_LIST=()
    _IDX=1
    printf "  %-4s %-30s %-6s %-9s %-9s %-9s\n" "No." "Mount Point" "Type" "Total" "Used" "Free"
    printf "  %-4s %-30s %-6s %-9s %-9s %-9s\n" "---" "-----------" "----" "-----" "----" "----"
    while IFS= read -r _dfline; do
      _dev=$(echo "$_dfline"  | awk '{print $1}')
      _sz=$(echo "$_dfline"   | awk '{print $2}')
      _used=$(echo "$_dfline" | awk '{print $3}')
      _avail=$(echo "$_dfline"| awk '{print $4}')
      _mnt=$(echo "$_dfline"  | awk '{print $6}')
      _type=$(detect_drive_type "$_dev")
      _MNT_LIST+=("$_mnt")
      printf "  [%-2s] %-30s %-6s %-9s %-9s %-9s\n" \
        "$_IDX" "$_mnt" "$_type" "$_sz" "$_used" "$_avail"
      _IDX=$((_IDX + 1))
    done < <(df -h 2>/dev/null | grep -E '^/dev/' | sort -k4 -rh)
    _CUSTOM_IDX="$_IDX"
    printf "  [%-2s] Enter a custom path\n" "$_CUSTOM_IDX"
    echo ""
    echo -e "  ${CYAN}RakshaGIS will create a 'RakshaGIS' subfolder on the selected drive.${RESET}"
    echo ""

    while true; do
      read -rp "  Select storage drive [1]: " _CHOICE
      _CHOICE="${_CHOICE:-1}"
      if [[ "$_CHOICE" =~ ^[0-9]+$ ]]; then
        if [[ "$_CHOICE" -ge 1 && "$_CHOICE" -le "${#_MNT_LIST[@]}" ]]; then
          _BASE="${_MNT_LIST[$((_CHOICE - 1))]}"
          _BASE="${_BASE%/}"        # strip trailing slash from root "/"
          DATA_DIR="${_BASE}/RakshaGIS"
          echo -e "\n  ${GREEN}✓ RakshaGIS data will be stored at: ${BOLD}${DATA_DIR}${RESET}\n"
          break
        elif [[ "$_CHOICE" -eq "$_CUSTOM_IDX" ]]; then
          read -rp "  Enter full path (e.g. /mnt/data/RakshaGIS): " _CUSTOM
          DATA_DIR="${_CUSTOM:-$DEFAULT_DATA_DIR}"
          echo -e "\n  ${GREEN}✓ RakshaGIS data will be stored at: ${BOLD}${DATA_DIR}${RESET}\n"
          break
        fi
      fi
      echo -e "  ${RED}Invalid — enter a number between 1 and ${_CUSTOM_IDX}.${RESET}"
    done
  fi
fi

# Clean trailing slash from DATA_DIR
DATA_DIR="${DATA_DIR%/}"

# Ensure DATA_DIR is absolute
if [[ "$DATA_DIR" != /* ]]; then
  DATA_DIR="$SCRIPT_DIR/$DATA_DIR"
fi

echo "Data directory: $DATA_DIR"

# ── Portable deployment prompt (only on a fresh install) ─────────────────────
# Ask once whether to archive Docker images under DATA_DIR/images/ so the whole
# deployment can be transferred to another system without internet access.
if [[ "$DATA_DIR_IS_NEW" == true && "$SAVE_IMAGES" == false ]]; then
  echo ""
  echo -e "  ${CYAN}Portable / offline deployment${RESET}"
  echo "  Saving Docker images as .tar archives under ${DATA_DIR}/images/ lets"
  echo "  you copy this entire directory to another system and install offline"
  echo "  (no internet pull required on the target machine)."
  echo "  Recommended when the target environment is air-gapped or has slow internet."
  read -rp "  Save Docker images for portable deployment? [Y/n]: " _PORTABLE
  if [[ "${_PORTABLE,,}" != "n" ]]; then
    SAVE_IMAGES=true
    echo -e "  ${GREEN}✓ Docker images will be archived to ${DATA_DIR}/images/${RESET}"
  else
    echo "  (Skipping — re-run with --save-images later to add portability)"
  fi
  echo ""
fi

# ── Step 2: Create data directory structure ───────────────────────────────────
echo ""
echo ">>> Creating data directories..."
for sub in postgres redis staticfiles media logs prometheus grafana backups images certbot/conf certbot/www models/ollama models/localai models/llamacpp models/anythingllm; do
  mkdir_p_safe "$DATA_DIR/$sub"
done

# Change permissions so both host user and container services can write
echo ">>> Setting directory permissions..."
for sub in postgres redis staticfiles media logs prometheus grafana backups images certbot/conf certbot/www models/ollama models/localai models/llamacpp models/anythingllm; do
  chmod_safe 777 "$DATA_DIR/$sub"
done

echo "    ✓ Data directories created"

# ── Auto-detect pre-saved image archives (new-system deployment) ──────────────
# If someone copied DATA_DIR from another machine, offer to load the saved images
# instead of pulling from the internet — useful for offline / air-gapped systems.
if [[ -z "$LOAD_IMAGES_DIR" ]] && [[ -d "$DATA_DIR/images" ]]; then
  _TAR_COUNT=$(find "$DATA_DIR/images" -maxdepth 1 -name "*.tar" 2>/dev/null | wc -l)
  if [[ "$_TAR_COUNT" -gt 0 ]]; then
    echo ""
    echo -e "  ${CYAN}Found ${_TAR_COUNT} Docker image archive(s) in ${DATA_DIR}/images/${RESET}"
    echo "  These appear to be from a previous or source installation."
    echo "  Loading them avoids pulling from the internet."
    read -rp "  Load pre-saved images now? [Y/n]: " _LOAD_CHOICE
    if [[ "${_LOAD_CHOICE,,}" != "n" ]]; then
      LOAD_IMAGES_DIR="$DATA_DIR/images"
      echo -e "  ${GREEN}✓ Will load images from ${LOAD_IMAGES_DIR}${RESET}"
    fi
    echo ""
  fi
fi

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

# Compose project name — all containers/networks/volumes are prefixed with this.
# Changing it renames all resources; leave it as-is unless you know what you are doing.
COMPOSE_PROJECT_NAME=rakshagis

# Host port for the nginx web UI (change if port 80 is occupied by another project)
RAKSHAGIS_HTTP_PORT=${HOST_PORT}
RAKSHAGIS_HTTPS_PORT=443

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
ONLYOFFICE_JWT_SECRET=$(openssl rand -base64 32 | tr -d '=+/')
# Internal base URL so OnlyOffice container fetches documents via nginx
ONLYOFFICE_INTERNAL_BASE_URL=http://nginx
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
  _upsert_env AI_BACKEND_GPU             "${GPU_MODE}"
  _upsert_env AI_BACKENDS                "${AI_BACKENDS_DOCKER}"
  _upsert_env RAKSHAGIS_HTTP_PORT        "${HOST_PORT}"
  _upsert_env COMPOSE_PROJECT_NAME       "rakshagis"
  # Add OnlyOffice secrets/config if not already set
  grep -q "^ONLYOFFICE_JWT_SECRET=" "$ENV_FILE" || \
    echo "ONLYOFFICE_JWT_SECRET=$(openssl rand -base64 32 | tr -d '=+/')" >> "$ENV_FILE"
  grep -q "^ONLYOFFICE_INTERNAL_BASE_URL=" "$ENV_FILE" || \
    echo "ONLYOFFICE_INTERNAL_BASE_URL=http://nginx" >> "$ENV_FILE"
  echo "    ✓ Updated .env (DATA_DIR + AI backend URLs + GPU settings + HTTP port)"
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

# ── Step 6: Pull dependency images (only if not already present locally) ─────
# Skipped when --load-images is supplied (offline deployment from tarballs).
if [[ -z "$LOAD_IMAGES_DIR" ]]; then
  echo ""
  echo ">>> Checking dependency images..."

  # Map service name → expected image (must match docker-compose.yml)
  declare -A SVC_IMAGE=(
    [db]="postgis/postgis:16-3.4"
    [redis]="redis:7-alpine"
    [nginx]="nginx:1.27-alpine"
    [pg_tileserv]="pramsey/pg_tileserv:latest"
    [prometheus]="prom/prometheus:v2.55.1"
    [grafana]="grafana/grafana:11.4.2"
    [onlyoffice]="onlyoffice/documentserver:8.2.2"
    [osm-tiles]="overv/openstreetmap-tile-server:2.3.0"
  )
  [[ "$OLLAMA_BASE_URL_VAL" == "http://ollama:11434" ]] && \
    SVC_IMAGE["ollama${GPU_PROFILE_SUFFIX}"]="ollama/ollama:latest"

  MISSING_SVCS=""
  for svc in "${!SVC_IMAGE[@]}"; do
    img="${SVC_IMAGE[$svc]}"
    if docker image inspect "$img" &>/dev/null; then
      echo "    ✓ $img already present — skip pull"
    else
      echo "    ↓ $img not found — will pull"
      MISSING_SVCS="$MISSING_SVCS $svc"
    fi
  done

  if [[ -n "$MISSING_SVCS" ]]; then
    echo ""
    echo "    Pulling missing images:$MISSING_SVCS"
    # shellcheck disable=SC2086
    docker compose $ALL_PROFILE_FLAGS pull --ignore-pull-failures $MISSING_SVCS
    echo "    ✓ Missing images pulled"
  else
    echo "    ✓ All dependency images already present — no pull needed"
  fi
else
  echo ""
  echo "    ✓ Skipping image pull (using loaded images from $LOAD_IMAGES_DIR)"
fi

# ── Step 7: Save Docker images to data dir (for offline deployment) ──────────
if [[ "$SAVE_IMAGES" == true ]]; then
  IMAGES_DIR="$DATA_DIR/images"
  echo ""
  mkdir_p_safe "$IMAGES_DIR"
  chmod_safe 777 "$IMAGES_DIR"

  IMAGES=(
    "postgis/postgis:16-3.4"
    "redis:7-alpine"
    "nginx:1.27-alpine"
    "pramsey/pg_tileserv:latest"
    "overv/openstreetmap-tile-server:2.3.0"
    "onlyoffice/documentserver:8.2.2"
    "prom/prometheus:v2.55.1"
    "grafana/grafana:11.4.2"
  )
  # Include Ollama only if using Docker-managed Ollama
  [[ "$OLLAMA_BASE_URL_VAL" == "http://ollama:11434" ]] && \
    IMAGES+=("ollama/ollama:latest")

  for img in "${IMAGES[@]}"; do
    safe_name=$(echo "$img" | tr '/:' '_')
    echo "    Saving: $img"
    docker save "$img" -o "$IMAGES_DIR/${safe_name}.tar" 2>/dev/null && echo "      ✓ Saved" || echo "      ⚠ Skipped (image not pulled)"
  done

  # Save app image (explicitly named rakshagis:web in docker-compose.yml)
  APP_IMG_NAME="rakshagis:web"
  if docker inspect "$APP_IMG_NAME" &>/dev/null; then
    echo "    Saving app image: $APP_IMG_NAME"
    docker save "$APP_IMG_NAME" -o "$IMAGES_DIR/rakshagis_app.tar"
    echo "      ✓ Saved"
  else
    echo "      ⚠ App image not found (hasn't been built yet)"
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
# Note: makemigrations is skipped here because the bind mount (.:./app) causes
# permission issues with the container user (raksha) on WSL2/Docker Desktop.
# Migrations are auto-created by entrypoint.sh when services start.
# If you have custom models, create migrations on the host:
#   python manage.py makemigrations
echo "    Running migrations..."
docker compose run --rm web python manage.py migrate --no-input || {
  echo "    ⚠ Migration failed. Ensure makemigrations has been run on the host."
  echo "      If you added new models, run: python manage.py makemigrations"
  exit 1
}
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

# ── Step 8b: Import India OSM data into local tile server ────────────────────
# Run once with:  ./build.sh --import-osm
# Requires internet access to download ~800 MB from Geofabrik.
# After this step the tile server runs completely offline.
# Disk space required: ~20 GB under DATA_DIR/tiles/
if [[ "$IMPORT_OSM" == true ]]; then
  echo ""
  echo -e "${BOLD}>>> Local OSM Tile Server — India data import${RESET}"
  OSM_DIR="$DATA_DIR/tiles"
  PBF_FILE="$OSM_DIR/india-latest.osm.pbf"
  OSM_DATA_DIR="$OSM_DIR/osm-data"
  OSM_CACHE_DIR="$OSM_DIR/tile-cache"
  mkdir_p_safe "$OSM_DATA_DIR"
  mkdir_p_safe "$OSM_CACHE_DIR"
  chmod_safe 777 "$OSM_DATA_DIR"
  chmod_safe 777 "$OSM_CACHE_DIR"

  # Download India extract from Geofabrik (one-time, requires internet)
  if [[ -f "$PBF_FILE" ]]; then
    echo "    India PBF already present: $PBF_FILE"
    echo "    Delete it to re-download."
  else
    echo "    Downloading India OSM extract from Geofabrik (~800 MB)..."
    echo "    Source: https://download.geofabrik.de/asia/india-latest.osm.pbf"
    if command -v wget &>/dev/null; then
      wget --progress=bar:force \
           --continue \
           -O "$PBF_FILE" \
           "https://download.geofabrik.de/asia/india-latest.osm.pbf"
    elif command -v curl &>/dev/null; then
      curl -L --continue-at - --progress-bar \
           -o "$PBF_FILE" \
           "https://download.geofabrik.de/asia/india-latest.osm.pbf"
    else
      echo "    ✖ Neither wget nor curl found. Please download manually:"
      echo "      https://download.geofabrik.de/asia/india-latest.osm.pbf"
      echo "      Save to: $PBF_FILE"
      echo "    Then re-run:  ./build.sh --import-osm"
      exit 1
    fi
    echo "    ✓ Download complete: $PBF_FILE"
  fi

  echo ""
  echo "    Importing OSM data into the tile server database..."
  echo "    ⏳ This takes 2-4 hours on first run. Please be patient."
  echo "    (CPU: 4 threads, PostGIS inside the tile server container)"
  echo ""
  docker run --rm \
    -v "$PBF_FILE:/data/region.osm.pbf:ro" \
    -v "$OSM_DATA_DIR:/data/database" \
    -v "$OSM_CACHE_DIR:/data/tiles" \
    --shm-size="1g" \
    -e THREADS=4 \
    -e UPDATES=disabled \
    overv/openstreetmap-tile-server:2.3.0 \
    import

  echo ""
  echo -e "  ${GREEN}✓ OSM import complete.${RESET}"
  echo "    Starting the tile server (profile: osm)..."
  docker compose --profile osm up -d osm-tiles
  echo "    The local tile server will serve India map tiles at /osm-tiles/{z}/{x}/{y}.png"
  echo "    In the application: Settings → Basemaps → activate 'Local OSM (Offline)'"
  echo ""
fi

# ── Step 9: Build frontend (skip when source files unchanged) ────────────────
if command -v node &> /dev/null && [[ -d "$SCRIPT_DIR/frontend" ]]; then
  echo ""
  echo ">>> Checking React frontend..."

  FE_HASH_FILE="$SCRIPT_DIR/.frontend-hash"
  # Hash: src files + package.json + vite config (excludes node_modules/staticfiles)
  FE_HASH=$(find "$SCRIPT_DIR/frontend/src" \
      "$SCRIPT_DIR/frontend/package.json" "$SCRIPT_DIR/frontend/vite.config"* \
      "$SCRIPT_DIR/frontend/tsconfig"* \
      -type f 2>/dev/null | sort | xargs sha256sum 2>/dev/null | sha256sum | cut -d' ' -f1)

  FE_NEEDS_BUILD=true
  if [[ -f "$FE_HASH_FILE" ]] && [[ "$(cat "$FE_HASH_FILE" 2>/dev/null)" == "$FE_HASH" ]]; then
    # Verify the actual build output exists (outDir is ../staticfiles, not frontend/dist)
    if [[ -f "$SCRIPT_DIR/staticfiles/index.html" ]]; then
      FE_NEEDS_BUILD=false
    fi
  fi

  if [[ "$FE_NEEDS_BUILD" == true ]]; then
    echo "    Frontend source changed — rebuilding..."
    cd "$SCRIPT_DIR/frontend"

    # ── Skip npm install when package.json / lockfile unchanged ──────────────
    NPM_HASH_FILE="$SCRIPT_DIR/.npm-hash"
    NPM_HASH=$(sha256sum package.json package-lock.json 2>/dev/null | sha256sum | cut -d' ' -f1)
    if [[ "$(cat "$NPM_HASH_FILE" 2>/dev/null)" != "$NPM_HASH" ]] || [[ ! -d node_modules ]]; then
      echo "    Installing npm dependencies..."
      npm install --silent
      echo "$NPM_HASH" > "$NPM_HASH_FILE"
    else
      echo "    npm deps unchanged — skipping install"
    fi

    # ── Cesium asset cache: avoid re-copying 14 MB on every app-code change ──
    # Cesium assets live in staticfiles/cesium/ but emptyOutDir wipes that dir.
    # We keep a persistent copy in .cesium-build/ keyed by the cesium npm version.
    CESIUM_VER=$(node -p "require('./package.json').dependencies.cesium" 2>/dev/null || echo "unknown")
    CESIUM_CACHE="$SCRIPT_DIR/.cesium-build"
    CESIUM_VER_FILE="$CESIUM_CACHE/.version"
    CESIUM_CACHED=false
    if [[ -f "$CESIUM_VER_FILE" ]] && [[ "$(cat "$CESIUM_VER_FILE")" == "$CESIUM_VER" ]] \
       && [[ -f "$CESIUM_CACHE/cesium/Cesium.js" ]]; then
      CESIUM_CACHED=true
    fi

    if [[ "$CESIUM_CACHED" == true ]]; then
      echo "    Cesium assets cached (v${CESIUM_VER}) — skipping copy"
      SKIP_CESIUM_COPY=1 node_modules/.bin/vite build
      node deploy.cjs
      # Restore cached cesium into the freshly emptied staticfiles/
      cp -r "$CESIUM_CACHE/cesium" "$SCRIPT_DIR/staticfiles/cesium"
    else
      echo "    Cesium version changed or not cached — full build"
      npm run build
      # Save cesium assets to persistent cache for next build
      mkdir -p "$CESIUM_CACHE"
      rm -rf "$CESIUM_CACHE/cesium"
      cp -r "$SCRIPT_DIR/staticfiles/cesium" "$CESIUM_CACHE/cesium"
      echo "$CESIUM_VER" > "$CESIUM_VER_FILE"
    fi

    cd "$SCRIPT_DIR"
    docker compose run --rm web python manage.py collectstatic --no-input
    echo "$FE_HASH" > "$FE_HASH_FILE"
    echo "    ✓ Frontend built and static files collected"
  else
    echo "    ✓ Frontend source unchanged — skipping build"
    echo "      (Delete .frontend-hash or modify src/ to force a rebuild)"
  fi
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
ACCESS_URL="http://localhost"
[[ "${HOST_PORT}" != "80" ]] && ACCESS_URL="http://localhost:${HOST_PORT}"

echo "╔══════════════════════════════════════════════════════════╗"
echo "║                RakshaGIS Setup Complete                 ║"
echo "╠══════════════════════════════════════════════════════════╣"
printf "║  Project name    : %-35s║\n" "rakshagis  (COMPOSE_PROJECT_NAME)"
printf "║  Data directory  : %-35s║\n" "${DATA_DIR}"
printf "║  HTTP port       : %-35s║\n" "${HOST_PORT}"
printf "║  Compute mode    : %-35s║\n" "${GPU_MODE^^}"
printf "║  AI backends     : %-35s║\n" "${AI_BACKENDS_DOCKER:-local only}"
echo "║  Default login   : admin / admin123                     ║"
printf "║  Access URL      : %-35s║\n" "${ACCESS_URL}"
echo "╠══════════════════════════════════════════════════════════╣"
echo "║  Use './RakshaGIS.sh start|stop|restart|status'         ║"
echo "║  Go to Settings → AI Config to activate a backend       ║"
echo "╠══════════════════════════════════════════════════════════╣"
echo "║  Multi-project isolation: all resources are prefixed    ║"
echo "║  'rakshagis_' — other projects on this host are safe.   ║"
echo "╠══════════════════════════════════════════════════════════╣"
echo "║  OFFLINE TILE SERVER (one-time, needs internet):        ║"
echo "║    ./build.sh --import-osm                              ║"
echo "║    Downloads India OSM (~800 MB), import ~2-4 hrs       ║"
echo "║    After import: fully offline India base map           ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""
