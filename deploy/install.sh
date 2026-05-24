#!/bin/bash
# RakshaGIS Production Server Setup
# Run as root on Ubuntu 22.04 / 24.04
# Usage: sudo bash install.sh

set -e

APP_USER="raksha"
APP_DIR="/opt/rakshagis"
REPO_DIR="$APP_DIR/RakshaGIS"
VENV_DIR="$REPO_DIR/.venv"
LOGS_DIR="$APP_DIR/logs"
PG_PORT=5432

echo "======================================"
echo " RakshaGIS — Production Setup"
echo "======================================"

# ── System packages ────────────────────────────────────────────────
echo "[1/8] Installing system packages..."
apt-get update -qq
apt-get install -y \
    python3 python3-pip python3-venv \
    postgresql postgresql-contrib \
    postgresql-16-postgis-3 postgresql-16-postgis-3-scripts \
    gdal-bin libgdal-dev libgeos-dev libproj-dev binutils \
    nginx \
    redis-server \
    git \
    curl

systemctl enable --now postgresql redis-server

# ── Application user ───────────────────────────────────────────────
echo "[2/8] Creating application user '$APP_USER'..."
id -u $APP_USER &>/dev/null || useradd --system --no-create-home $APP_USER

# ── Directory structure ────────────────────────────────────────────
echo "[3/8] Creating directory structure..."
mkdir -p "$LOGS_DIR" "$APP_DIR/media" "$REPO_DIR/staticfiles"
chown -R $APP_USER:$APP_USER "$APP_DIR"
chmod 750 "$APP_DIR"

# ── PostgreSQL database ────────────────────────────────────────────
echo "[4/8] Setting up PostgreSQL database..."
DB_PASS=$(python3 -c "import secrets; print(secrets.token_urlsafe(20))")
sudo -u postgres psql -p $PG_PORT <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '$APP_USER') THEN
    CREATE ROLE $APP_USER WITH LOGIN PASSWORD '$DB_PASS';
  END IF;
END \$\$;
CREATE DATABASE IF NOT EXISTS rakshagis OWNER $APP_USER;
\c rakshagis
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS postgis_topology;
GRANT ALL PRIVILEGES ON DATABASE rakshagis TO $APP_USER;
SQL
echo "  Database password: $DB_PASS  (save this — it will not be shown again)"

# ── .env file ──────────────────────────────────────────────────────
echo "[5/8] Creating .env file..."
SECRET_KEY=$(python3 -c "import secrets; print(secrets.token_urlsafe(50))")
SERVER_IP=$(hostname -I | awk '{print $1}')
cat > "$REPO_DIR/.env" <<ENV
DEBUG=False
SECRET_KEY=$SECRET_KEY
ALLOWED_HOSTS=$SERVER_IP,localhost

DB_NAME=rakshagis
DB_USER=$APP_USER
DB_PASSWORD=$DB_PASS
DB_HOST=localhost
DB_PORT=$PG_PORT

REDIS_URL=redis://localhost:6379/0
CELERY_BROKER_URL=redis://localhost:6379/1

OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=llama3

DJANGO_SETTINGS_MODULE=config.settings.production
ENV
chown $APP_USER:$APP_USER "$REPO_DIR/.env"
chmod 600 "$REPO_DIR/.env"
echo "  .env created at $REPO_DIR/.env"

# ── Python dependencies ────────────────────────────────────────────
echo "[6/8] Installing Python packages..."
sudo -u $APP_USER python3 -m venv "$VENV_DIR"
sudo -u $APP_USER "$VENV_DIR/bin/pip" install --upgrade pip -q
sudo -u $APP_USER "$VENV_DIR/bin/pip" install -r "$REPO_DIR/requirements.txt" -q

# ── Django setup ───────────────────────────────────────────────────
echo "[7/8] Running Django migrate and collectstatic..."
sudo -u $APP_USER bash -c "
    cd $REPO_DIR
    DJANGO_SETTINGS_MODULE=config.settings.production .venv/bin/python manage.py migrate --no-input
    DJANGO_SETTINGS_MODULE=config.settings.production .venv/bin/python manage.py collectstatic --no-input
"
echo "  Creating superuser..."
sudo -u $APP_USER bash -c "
    cd $REPO_DIR
    DJANGO_SETTINGS_MODULE=config.settings.production .venv/bin/python manage.py createsuperuser
"

# ── systemd services ───────────────────────────────────────────────
echo "[8/8] Configuring systemd and Nginx..."
cp "$REPO_DIR/deploy/gunicorn.service" /etc/systemd/system/rakshagis.service
cp "$REPO_DIR/deploy/celery.service"   /etc/systemd/system/rakshagis-celery.service
systemctl daemon-reload
systemctl enable --now rakshagis rakshagis-celery

# ── Nginx ──────────────────────────────────────────────────────────
cp "$REPO_DIR/deploy/nginx.conf" /etc/nginx/sites-available/rakshagis
ln -sf /etc/nginx/sites-available/rakshagis /etc/nginx/sites-enabled/rakshagis
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

echo ""
echo "======================================"
echo " Setup complete!"
echo "======================================"
echo " App:      http://$SERVER_IP"
echo " Admin:    http://$SERVER_IP/admin/"
echo " API docs: http://$SERVER_IP/api/docs/"
echo " Logs:     $LOGS_DIR"
echo ""
echo " Services:"
systemctl is-active rakshagis && echo "  ✓ rakshagis (gunicorn)"  || echo "  ✗ rakshagis"
systemctl is-active rakshagis-celery && echo "  ✓ rakshagis-celery" || echo "  ✗ rakshagis-celery"
systemctl is-active nginx && echo "  ✓ nginx" || echo "  ✗ nginx"
