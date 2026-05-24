from .base import *

DEBUG = False

CORS_ALLOWED_ORIGINS = env.list('CORS_ALLOWED_ORIGINS', default=[])

# STATIC_ROOT and MEDIA_ROOT inherit from base.py (DATA_DIR-based).
# Override only if you need a path outside DATA_DIR.
if env('STATIC_ROOT', default=''):
    STATIC_ROOT = env('STATIC_ROOT')
if env('MEDIA_ROOT', default=''):
    MEDIA_ROOT = env('MEDIA_ROOT')

# Security
SECURE_HSTS_SECONDS = 31536000
SECURE_HSTS_INCLUDE_SUBDOMAINS = True
SECURE_SSL_REDIRECT = env.bool('SECURE_SSL_REDIRECT', default=False)
SESSION_COOKIE_SECURE = True
CSRF_COOKIE_SECURE = True
SECURE_BROWSER_XSS_FILTER = True
SECURE_CONTENT_TYPE_NOSNIFF = True

# GDAL / GEOS — auto-detected on a properly installed Ubuntu system.
# Set these in .env only if Django cannot find the libraries automatically.
_gdal_path = env('GDAL_LIBRARY_PATH', default='')
_geos_path = env('GEOS_LIBRARY_PATH', default='')
if _gdal_path:
    GDAL_LIBRARY_PATH = _gdal_path
if _geos_path:
    GEOS_LIBRARY_PATH = _geos_path

LOGGING = {
    'version': 1,
    'disable_existing_loggers': False,
    'formatters': {
        'verbose': {
            'format': '{levelname} {asctime} {module} {process:d} {message}',
            'style': '{',
        },
    },
    'handlers': {
        'file': {
            'level': 'WARNING',
            'class': 'logging.handlers.RotatingFileHandler',
            'filename': env('LOG_FILE', default=str(BASE_DIR / 'logs' / 'django.log')),
            'maxBytes': 10 * 1024 * 1024,  # 10 MB
            'backupCount': 5,
            'formatter': 'verbose',
        },
        'console': {
            'level': 'INFO',
            'class': 'logging.StreamHandler',
            'formatter': 'verbose',
        },
    },
    'root': {
        'handlers': ['file', 'console'],
        'level': 'INFO',
    },
    'loggers': {
        'django.security': {
            'handlers': ['file'],
            'level': 'WARNING',
            'propagate': False,
        },
    },
}
