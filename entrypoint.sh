#!/bin/sh
set -e

# ── Pre-flight: ensure the log file is writable by this user ────────────────
LOG_DIR=/app/logs
LOG_FILE=$LOG_DIR/django.log
mkdir -p "$LOG_DIR"
# If the file exists but isn't writable, try to reset it; fail gracefully.
if [ -f "$LOG_FILE" ] && [ ! -w "$LOG_FILE" ]; then
    rm -f "$LOG_FILE" 2>/dev/null || true
fi
touch "$LOG_FILE" 2>/dev/null || true

echo "==> Waiting for PostgreSQL..."
until python -c "
import psycopg2, os, sys
try:
    psycopg2.connect(
        dbname=os.getenv('DB_NAME', 'rakshagis'),
        user=os.getenv('DB_USER', 'raksha'),
        password=os.getenv('DB_PASSWORD', ''),
        host=os.getenv('DB_HOST', 'db'),
        port=int(os.getenv('DB_PORT', 5432)),
    ).close()
    sys.exit(0)
except Exception as e:
    print(f'    not ready: {e}', flush=True)
    sys.exit(1)
" 2>&1; do
    sleep 2
done
echo "==> PostgreSQL ready."

# Only the web/daphne container runs schema management.
case "$1" in
    gunicorn|daphne)
        # ── makemigrations ──────────────────────────────────────────────────
        # Check whether any app has un-migrated model changes.
        # If so, generate the migration files automatically.
        # This requires write access to the bind-mounted source tree (apps/*/migrations/).
        # The Dockerfile creates user raksha with UID 1000 which matches the typical
        # host developer account so write access is available on Linux/WSL2.
        echo "==> Checking for model changes..."
        if python manage.py migrate --check --no-input 2>/dev/null; then
            # --check exits 0 when no unapplied migrations exist; run makemigrations
            # only if models have drifted from the migration state.
            :
        fi

        # Always run makemigrations so Django can detect and record new model fields.
        if python manage.py makemigrations --no-input; then
            echo "   Migrations up to date."
        else
            # Write failed — almost always a UID mismatch between container and host.
            echo ""
            echo "  !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
            echo "  !! makemigrations failed (likely a file-permission issue). !!"
            echo "  !! Fix: rebuild the web image so raksha UID matches yours. !!"
            echo "  !!   docker compose build web && docker compose up -d web  !!"
            echo "  !! OR generate migrations on the host:                     !!"
            echo "  !!   python manage.py makemigrations                       !!"
            echo "  !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
            echo ""
            # Do NOT abort — existing migrations may still be sufficient.
        fi

        # ── migrate ─────────────────────────────────────────────────────────
        echo "==> Running migrations..."
        python manage.py migrate --no-input

        # ── static files ────────────────────────────────────────────────────
        # Non-fatal: permission errors on stale files from a previous UID
        # must not prevent the server from starting. Frontend JS/CSS is
        # deployed independently via deploy.cjs + npm run build.
        echo "==> Collecting static files..."
        python manage.py collectstatic --no-input 2>&1 || \
            echo "  (collectstatic had errors — Django admin assets may be stale)"

        # ── seed / init ─────────────────────────────────────────────────────
        echo "==> Seeding basemaps..."
        python manage.py seed_basemaps

        echo "==> Initialising folder structure..."
        python manage.py init_folders
        ;;
esac

exec "$@"
