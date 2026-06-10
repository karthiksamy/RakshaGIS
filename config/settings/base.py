import os
import environ
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent.parent

env = environ.Env(DEBUG=(bool, False))
environ.Env.read_env(BASE_DIR / '.env')

SECRET_KEY = env('SECRET_KEY')
DEBUG = env('DEBUG')
ALLOWED_HOSTS = env.list('ALLOWED_HOSTS', default=['localhost', '127.0.0.1'])

INSTALLED_APPS = [
    # Daphne must be first — required by daphne.E001 system check
    'daphne',

    'django.contrib.admin',
    'django.contrib.auth',
    'django.contrib.contenttypes',
    'django.contrib.sessions',
    'django.contrib.messages',
    'django.contrib.staticfiles',
    'django.contrib.gis',

    # Monitoring
    'django_prometheus',

    # Third party
    'rest_framework',
    'rest_framework_gis',
    'corsheaders',
    'django_filters',
    'drf_spectacular',

    # Project apps
    'apps.core',
    'apps.accounts',
    'apps.gis_layers',
    'apps.survey_projects',
    'apps.documents',
    'apps.workflow',
    'apps.ai_assistant',
    'apps.dashboard',
    'apps.reports',
    'apps.collaboration',
    'apps.backups',
    'apps.external_data',

    # Django Channels
    'channels',
]

ASGI_APPLICATION = 'config.asgi.application'

CHANNEL_LAYERS = {
    'default': {
        'BACKEND': 'channels_redis.core.RedisChannelLayer',
        'CONFIG': {
            'hosts': [env('REDIS_URL', default='redis://redis:6379/2')],
            'capacity': 1500,
            'expiry': 60,
        },
    },
}

MIDDLEWARE = [
    'django_prometheus.middleware.PrometheusBeforeMiddleware',
    'django.middleware.security.SecurityMiddleware',
    'corsheaders.middleware.CorsMiddleware',
    'django.contrib.sessions.middleware.SessionMiddleware',
    'apps.documents.middleware.StripOnlyOfficeAuthorizationMiddleware',
    'django.middleware.common.CommonMiddleware',
    'django.middleware.csrf.CsrfViewMiddleware',
    'django.contrib.auth.middleware.AuthenticationMiddleware',
    'django.contrib.messages.middleware.MessageMiddleware',
    'django.middleware.clickjacking.XFrameOptionsMiddleware',
    'django_prometheus.middleware.PrometheusAfterMiddleware',
]

ROOT_URLCONF = 'config.urls'

TEMPLATES = [
    {
        'BACKEND': 'django.template.backends.django.DjangoTemplates',
        'DIRS': [BASE_DIR / 'templates'],
        'APP_DIRS': True,
        'OPTIONS': {
            'context_processors': [
                'django.template.context_processors.debug',
                'django.template.context_processors.request',
                'django.contrib.auth.context_processors.auth',
                'django.contrib.messages.context_processors.messages',
            ],
        },
    },
]

WSGI_APPLICATION = 'config.wsgi.application'
ASGI_APPLICATION = 'config.asgi.application'

DATABASES = {
    'default': {
        'ENGINE': 'django.contrib.gis.db.backends.postgis',
        'NAME': env('DB_NAME', default='rakshagis'),
        'USER': env('DB_USER', default='raksha'),
        'PASSWORD': env('DB_PASSWORD', default='raksha123'),
        'HOST': env('DB_HOST', default='localhost'),
        'PORT': env('DB_PORT', default='5432'),
    }
}

AUTH_USER_MODEL = 'accounts.User'

AUTH_PASSWORD_VALIDATORS = [
    {'NAME': 'django.contrib.auth.password_validation.UserAttributeSimilarityValidator'},
    {'NAME': 'django.contrib.auth.password_validation.MinimumLengthValidator'},
    {'NAME': 'django.contrib.auth.password_validation.CommonPasswordValidator'},
    {'NAME': 'django.contrib.auth.password_validation.NumericPasswordValidator'},
]

LANGUAGE_CODE = 'en-us'
TIME_ZONE = 'Asia/Kolkata'
USE_I18N = True
USE_TZ = True

STATIC_URL = '/static/'
STATICFILES_DIRS = [BASE_DIR / 'static']

# DATA_DIR is the single root for all persistent data:
#   - /data               inside Docker containers (mapped from host DATA_DIR)
#   - a local path        when running without Docker (set in .env)
DATA_DIR = env('DATA_DIR', default=str(BASE_DIR / 'data'))

MEDIA_URL = '/media/'
MEDIA_ROOT = os.path.join(DATA_DIR, 'media')
STATIC_ROOT = os.path.join(DATA_DIR, 'staticfiles')

# Allow GIS file uploads up to 200 MB
DATA_UPLOAD_MAX_MEMORY_SIZE = 524288000   # 500 MB
FILE_UPLOAD_MAX_MEMORY_SIZE = 10485760    # 10 MB — larger files stream to disk

DEFAULT_AUTO_FIELD = 'django.db.models.BigAutoField'

REST_FRAMEWORK = {
    'DEFAULT_AUTHENTICATION_CLASSES': [
        'apps.accounts.authentication.SessionAwareJWTAuthentication',
        'rest_framework.authentication.SessionAuthentication',
    ],
    'DEFAULT_PERMISSION_CLASSES': [
        'rest_framework.permissions.IsAuthenticated',
    ],
    'DEFAULT_FILTER_BACKENDS': [
        'django_filters.rest_framework.DjangoFilterBackend',
        'rest_framework.filters.SearchFilter',
        'rest_framework.filters.OrderingFilter',
    ],
    'DEFAULT_SCHEMA_CLASS': 'drf_spectacular.openapi.AutoSchema',
    'DEFAULT_PAGINATION_CLASS': 'rest_framework.pagination.PageNumberPagination',
    'PAGE_SIZE': 25,
}

SPECTACULAR_SETTINGS = {
    'TITLE': 'RakshaGIS API',
    'DESCRIPTION': 'Enterprise GIS and Survey Management Platform for DGDE',
    'VERSION': '1.0.0',
}

CELERY_BROKER_URL = env('CELERY_BROKER_URL', default='redis://localhost:6379/1')
CELERY_RESULT_BACKEND = env('REDIS_URL', default='redis://localhost:6379/0')
CELERY_TIMEZONE = TIME_ZONE

from celery.schedules import crontab
CELERY_BEAT_SCHEDULE = {
    'send-scheduled-reports': {
        'task': 'apps.reports.tasks.send_scheduled_reports',
        'schedule': crontab(hour=7, minute=0),
    },
    # Check backup schedules every hour
    'run-scheduled-backups': {
        'task': 'backups.run_scheduled_backups',
        'schedule': crontab(minute=0),  # top of every hour
    },
    # Rotate expired backup files daily at 03:00
    'rotate-old-backups': {
        'task': 'backups.rotate_old_backups',
        'schedule': crontab(hour=3, minute=0),
    },
    # Scan published survey areas for spatial overlaps (twice daily)
    'run-encroachment-scan': {
        'task': 'apps.workflow.tasks.run_encroachment_scan',
        'schedule': crontab(hour='6,14', minute=0),
    },
}

# Email (set EMAIL_BACKEND to smtp for production; console for local dev)
EMAIL_BACKEND = env('EMAIL_BACKEND', default='django.core.mail.backends.console.EmailBackend')
EMAIL_HOST = env('EMAIL_HOST', default='')
EMAIL_PORT = env.int('EMAIL_PORT', default=587)
EMAIL_USE_TLS = env.bool('EMAIL_USE_TLS', default=True)
EMAIL_HOST_USER = env('EMAIL_HOST_USER', default='')
EMAIL_HOST_PASSWORD = env('EMAIL_HOST_PASSWORD', default='')
DEFAULT_FROM_EMAIL = env('DEFAULT_FROM_EMAIL', default='noreply@rakshagis.in')

ONLYOFFICE_JWT_SECRET = env('ONLYOFFICE_JWT_SECRET', default='')
# Internal base URL used by OnlyOffice container to reach Django/media.
# In Docker set this to http://nginx so OnlyOffice can fetch files via nginx.
# Leave empty to fall back to request.build_absolute_uri (good for local dev).
ONLYOFFICE_INTERNAL_BASE_URL = env('ONLYOFFICE_INTERNAL_BASE_URL', default='')

# ── C2PA content provenance signing ──────────────────────────────────────────
# Real, signed C2PA manifests are embedded into supported raster exports
# (PNG/JPEG/TIFF/WebP). Other formats fall back to the legacy provenance token.
C2PA_ENABLED = env.bool('C2PA_ENABLED', default=True)
C2PA_DIR = env('C2PA_DIR', default=str(BASE_DIR / 'data' / 'c2pa'))
# Provide a CA-issued ES256 signer for production; if blank a self-signed dev
# signer is generated once under C2PA_DIR.
C2PA_SIGN_CERT_PATH = env('C2PA_SIGN_CERT_PATH', default='')
C2PA_SIGN_KEY_PATH = env('C2PA_SIGN_KEY_PATH', default='')
# RFC-3161 timestamp authority URL; leave blank for air-gapped (no timestamp).
C2PA_TSA_URL = env('C2PA_TSA_URL', default='')
C2PA_CERT_ORG = env('C2PA_CERT_ORG', default='DGDE RakshaGIS')
C2PA_CERT_CN = env('C2PA_CERT_CN', default='RakshaGIS Provenance Signer')
C2PA_CERT_COUNTRY = env('C2PA_CERT_COUNTRY', default='IN')

OLLAMA_LOCAL_URL = env('OLLAMA_LOCAL_URL', default='http://localhost:11434')
# host.docker.internal resolves to the Docker Desktop host on Windows/Mac/WSL2
OLLAMA_HOST_URL  = env('OLLAMA_HOST_URL',  default='http://host.docker.internal:11434')
OLLAMA_DOCKER_URL = env('OLLAMA_DOCKER_URL', default='http://ollama:11434')
# Kept for backwards-compat; services.py auto-detects which URL to use at runtime.
OLLAMA_BASE_URL = env('OLLAMA_BASE_URL', default='http://ollama:11434')
OLLAMA_MODEL = env('OLLAMA_MODEL', default='llama3.2')

# AI compute mode — whether the AI backend is running on an NVIDIA GPU.
# AI_BACKEND_GPU accepts: true/false, gpu/cpu, 1/0, yes/no (set by docker-compose
# profile and .env). Vision pipelines (single-shot LLaVA + the Advanced AI Vision
# Pipeline) require GPU and are blocked in CPU mode. The classical CV pipeline
# runs on either CPU or GPU.
_ai_backend_gpu = str(env('AI_BACKEND_GPU', default='false')).strip().lower()
AI_GPU_ENABLED = _ai_backend_gpu in ('true', '1', 'yes', 'on', 'gpu', 'cuda', 'nvidia')

# Backup & Recovery
# BACKUP_ENCRYPTION_KEY: Fernet key (URL-safe base64, 32 bytes).
# Generate with: python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
# If not set, a key is auto-generated and stored in BACKUP_DIR/.backup_key
BACKUP_ENCRYPTION_KEY = env('BACKUP_ENCRYPTION_KEY', default='')
BACKUP_DIR = env('BACKUP_DIR', default=str(BASE_DIR / 'data' / 'backups'))
BACKUP_RETENTION_DAYS = env.int('BACKUP_RETENTION_DAYS', default=30)

# Cesium 3D terrain
# CESIUM_ION_TOKEN: optional free token from https://ion.cesium.com (for Cesium World Terrain)
# Leave empty to use local terrain server or flat (ellipsoid) terrain.
CESIUM_ION_TOKEN = env('CESIUM_ION_TOKEN', default='')
# TERRAIN_TILE_URL: URL of a quantized-mesh terrain tile server (e.g. http://terrain-server:8765)
# Served locally via the optional `terrain` Docker profile.  Leave empty to use ellipsoid.
TERRAIN_TILE_URL = env('TERRAIN_TILE_URL', default='')
