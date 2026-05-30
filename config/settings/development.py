from .base import *

DEBUG = True

CORS_ALLOW_ALL_ORIGINS = True

EMAIL_BACKEND = 'django.core.mail.backends.console.EmailBackend'

# Suppress the django.request WARNING spam for intentional 4xx responses
# (e.g. failed login returns 401 — that's expected, not an error)
LOGGING = {
    'version': 1,
    'disable_existing_loggers': False,
    'handlers': {
        'console': {
            'class': 'logging.StreamHandler',
        },
    },
    'loggers': {
        'django.request': {
            'handlers': ['console'],
            'level': 'ERROR',   # Only show 5xx — skip 4xx warnings like 401/403
            'propagate': False,
        },
    },
}

