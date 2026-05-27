#!/bin/sh
set -e

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

# Only the web (gunicorn) container runs migrate + collectstatic.
# The celery container just waits for the DB and starts the worker.
case "$1" in
    gunicorn)
        echo "==> Creating any missing migrations..."
        python manage.py makemigrations --no-input
        echo "==> Running migrations..."
        python manage.py migrate --no-input
        echo "==> Collecting static files..."
        python manage.py collectstatic --no-input
        echo "==> Seeding basemaps..."
        python manage.py seed_basemaps
        echo "==> Initialising folder structure..."
        python manage.py init_folders
        ;;
esac

exec "$@"
