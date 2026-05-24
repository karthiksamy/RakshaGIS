#!/bin/bash
# RakshaGIS — Development Docker Setup (WSL2 / local machine)
set -e

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║   RakshaGIS — Dev Setup                  ║"
echo "╚══════════════════════════════════════════╝"
echo ""

read -rp "  Data directory [$(pwd)/data]: " DATA_DIR
DATA_DIR="${DATA_DIR:-$(pwd)/data}"
DATA_DIR="${DATA_DIR%/}"

mkdir -p \
    "$DATA_DIR/postgres" \
    "$DATA_DIR/redis" \
    "$DATA_DIR/media/gis_data" \
    "$DATA_DIR/staticfiles" \
    "$DATA_DIR/logs"
echo "  ✓ Directories created at $DATA_DIR"

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

OLLAMA_BASE_URL=http://ollama:11434
OLLAMA_MODEL=llama3

DJANGO_SETTINGS_MODULE=config.settings.development
ENV

chmod 600 .env
echo "  ✓ .env written"

echo ""
echo "  Building images..."
docker compose build --quiet

echo "  Starting DB and Redis first..."
docker compose up -d db redis
echo "  Waiting 15s for PostgreSQL to initialise..."
sleep 15

echo "  Running migrations..."
docker compose -f docker-compose.yml -f docker-compose.dev.yml run --rm web python manage.py migrate

echo ""
read -rp "  Create superuser? [Y/n]: " CREATE_SUPER
if [[ "${CREATE_SUPER,,}" != "n" ]]; then
    docker compose -f docker-compose.yml -f docker-compose.dev.yml run --rm web python manage.py createsuperuser
fi

echo "  Starting all services (dev mode, no Nginx)..."
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d

echo ""
echo "  ✓ Dev environment running"
echo "  App:      http://localhost:8000"
echo "  Admin:    http://localhost:8000/admin/"
echo "  API docs: http://localhost:8000/api/docs/"
echo "  Data:     $DATA_DIR"
echo ""
echo "  Useful dev commands:"
echo "    make dc-logs     — follow logs"
echo "    make dc-shell    — Django shell"
echo "    make dc-migrate  — run migrations"
