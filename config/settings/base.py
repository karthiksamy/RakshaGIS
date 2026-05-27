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
]

MIDDLEWARE = [
    'django_prometheus.middleware.PrometheusBeforeMiddleware',
    'django.middleware.security.SecurityMiddleware',
    'corsheaders.middleware.CorsMiddleware',
    'django.contrib.sessions.middleware.SessionMiddleware',
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
}

# Email (set EMAIL_BACKEND to smtp for production; console for local dev)
EMAIL_BACKEND = env('EMAIL_BACKEND', default='django.core.mail.backends.console.EmailBackend')
EMAIL_HOST = env('EMAIL_HOST', default='')
EMAIL_PORT = env.int('EMAIL_PORT', default=587)
EMAIL_USE_TLS = env.bool('EMAIL_USE_TLS', default=True)
EMAIL_HOST_USER = env('EMAIL_HOST_USER', default='')
EMAIL_HOST_PASSWORD = env('EMAIL_HOST_PASSWORD', default='')
DEFAULT_FROM_EMAIL = env('DEFAULT_FROM_EMAIL', default='noreply@rakshagis.in')

OLLAMA_LOCAL_URL = env('OLLAMA_LOCAL_URL', default='http://localhost:11434')
# host.docker.internal resolves to the Docker Desktop host on Windows/Mac/WSL2
OLLAMA_HOST_URL  = env('OLLAMA_HOST_URL',  default='http://host.docker.internal:11434')
OLLAMA_DOCKER_URL = env('OLLAMA_DOCKER_URL', default='http://ollama:11434')
# Kept for backwards-compat; services.py auto-detects which URL to use at runtime.
OLLAMA_BASE_URL = env('OLLAMA_BASE_URL', default='http://ollama:11434')
OLLAMA_MODEL = env('OLLAMA_MODEL', default='llama3.2')
