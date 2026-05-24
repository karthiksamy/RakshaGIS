#!/bin/bash
# RakshaGIS — Production Docker Setup
# Run once on any machine that has Docker installed.
set -e

BOLD='\033[1m'; CYAN='\033[0;36m'; GREEN='\033[0;32m'; RESET='\033[0m'

echo ""
echo -e "${BOLD}╔══════════════════════════════════════════╗${RESET}"
echo -e "${BOLD}║   RakshaGIS — Production Setup Wizard   ║${RESET}"
echo -e "${BOLD}╚══════════════════════════════════════════╝${RESET}"
echo ""

# ── Data directory ─────────────────────────────────────────────────
echo -e "${CYAN}Where should all application data be stored?${RESET}"
echo "  Examples:"
echo "    /data/rakshagis          (recommended — dedicated drive)"
echo "    /mnt/storage/rakshagis   (external / NAS mount)"
echo "    /opt/rakshagis/data      (local disk)"
echo ""
read -rp "  Data directory: " DATA_DIR
DATA_DIR="${DATA_DIR%/}"   # strip trailing slash

[[ -z "$DATA_DIR" ]] && { echo "Error: path cannot be empty."; exit 1; }

# ── Server address ─────────────────────────────────────────────────
read -rp "  Server IP or domain name [$(hostname -I | awk '{print $1}')]: " SERVER_HOST
SERVER_HOST="${SERVER_HOST:-$(hostname -I | awk '{print $1}')}"

# ── Ollama model ───────────────────────────────────────────────────
echo ""
echo -e "${CYAN}Which Ollama model to use for AI features?${RESET}"
echo "  Options: llama3  mistral  gemma2  deepseek-r1:7b  phi3"
read -rp "  Model [llama3]: " OLLAMA_MODEL
OLLAMA_MODEL="${OLLAMA_MODEL:-llama3}"

# ── Create folder structure ────────────────────────────────────────
echo ""
echo -e "  Creating data directories at ${BOLD}$DATA_DIR${RESET}..."
mkdir -p \
    "$DATA_DIR/postgres" \
    "$DATA_DIR/redis" \
    "$DATA_DIR/media/gis_data" \
    "$DATA_DIR/staticfiles" \
    "$DATA_DIR/logs" \
    "$DATA_DIR/ollama"
echo -e "  ${GREEN}✓ Directories created${RESET}"

# ── Generate secrets ───────────────────────────────────────────────
SECRET_KEY=$(python3 -c "import secrets; print(secrets.token_urlsafe(50))")
DB_PASS=$(python3 -c "import secrets; print(secrets.token_urlsafe(20))")

# ── Write .env ─────────────────────────────────────────────────────
cat > .env <<ENV
DEBUG=False
SECRET_KEY=${SECRET_KEY}
ALLOWED_HOSTS=${SERVER_HOST},localhost,127.0.0.1

# Host path — Docker Compose maps this to /data inside containers
DATA_DIR=${DATA_DIR}

DB_NAME=rakshagis
DB_USER=raksha
DB_PASSWORD=${DB_PASS}
DB_HOST=db
DB_PORT=5432

REDIS_URL=redis://redis:6379/0
CELERY_BROKER_URL=redis://redis:6379/1

OLLAMA_BASE_URL=http://ollama:11434
OLLAMA_MODEL=${OLLAMA_MODEL}

DJANGO_SETTINGS_MODULE=config.settings.production
ENV

chmod 600 .env
echo -e "  ${GREEN}✓ .env written${RESET}"

# ── Build and start ────────────────────────────────────────────────
echo ""
echo "  Building Docker images (first run may take a few minutes)..."
docker compose build --quiet

echo "  Starting all services..."
docker compose up -d

echo ""
echo "  Waiting for the web container to finish migrations..."
docker compose logs -f web &
LOGS_PID=$!
# Wait until gunicorn is listening
until docker compose exec -T web sh -c "python -c 'import socket; s=socket.socket(); s.connect((\"0.0.0.0\",8000))'" 2>/dev/null; do
    sleep 3
done
kill $LOGS_PID 2>/dev/null; wait $LOGS_PID 2>/dev/null || true

# ── Superuser ──────────────────────────────────────────────────────
echo ""
echo -e "${CYAN}Create the administrator account:${RESET}"
docker compose exec web python manage.py createsuperuser

# ── Pull Ollama model ──────────────────────────────────────────────
echo ""
echo "  Pulling Ollama model '${OLLAMA_MODEL}'..."
docker compose exec ollama ollama pull "${OLLAMA_MODEL}" || \
    echo "  (Ollama pull can be done later: docker compose exec ollama ollama pull ${OLLAMA_MODEL})"

# ── Done ───────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}╔══════════════════════════════════════════╗${RESET}"
echo -e "${BOLD}║   Setup complete!                        ║${RESET}"
echo -e "${BOLD}╚══════════════════════════════════════════╝${RESET}"
echo ""
echo -e "  App:       ${CYAN}http://${SERVER_HOST}${RESET}"
echo -e "  Admin:     ${CYAN}http://${SERVER_HOST}/admin/${RESET}"
echo -e "  API docs:  ${CYAN}http://${SERVER_HOST}/api/docs/${RESET}"
echo -e "  Data:      ${BOLD}${DATA_DIR}${RESET}"
echo ""
echo "  Useful commands:"
echo "    docker compose ps               — service status"
echo "    docker compose logs -f web      — Django logs"
echo "    docker compose exec web bash    — open shell"
echo "    docker compose down             — stop everything"
