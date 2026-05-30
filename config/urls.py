from django.contrib import admin
from django.urls import path, include, re_path
from django.conf import settings
from django.conf.urls.static import static
from django.views.generic import TemplateView
from django.http import FileResponse, Http404
from drf_spectacular.views import SpectacularAPIView, SpectacularSwaggerView
from rest_framework_simplejwt.views import TokenObtainPairView, TokenRefreshView
import os


def spa_index(request):
    """Serve the Vite-built index.html for all SPA routes."""
    index_path = os.path.join(settings.BASE_DIR, 'static', 'frontend', 'index.html')
    if not os.path.exists(index_path):
        # Fallback to templates/index.html during development before first build
        return TemplateView.as_view(template_name='index.html')(request)
    return FileResponse(open(index_path, 'rb'), content_type='text/html')

urlpatterns = [
    path('admin/', admin.site.urls),

    # Auth
    path('api/auth/token/', TokenObtainPairView.as_view(), name='token_obtain_pair'),
    path('api/auth/token/refresh/', TokenRefreshView.as_view(), name='token_refresh'),

    # API docs (Swagger UI)
    path('api/schema/', SpectacularAPIView.as_view(), name='schema'),
    path('api/docs/', SpectacularSwaggerView.as_view(url_name='schema'), name='swagger-ui'),

    # Prometheus metrics
    path('metrics/', include('django_prometheus.urls')),

    # App routes
    path('api/accounts/', include('apps.accounts.urls')),
    path('api/gis/', include('apps.gis_layers.urls')),
    path('api/gis/', include('apps.core.urls')),
    path('api/core/', include('apps.core.urls')),
    path('api/projects/', include('apps.survey_projects.urls')),
    path('api/documents/', include('apps.documents.urls')),
    path('api/workflow/', include('apps.workflow.urls')),
    path('api/ai/', include('apps.ai_assistant.urls')),
    path('api/dashboard/', include('apps.dashboard.urls')),
    path('api/reports/', include('apps.reports.urls')),
    path('api/backups/', include('apps.backups.urls')),
    path('api/external/', include('apps.external_data.urls')),

    # React SPA catch-all — must be last; serves Vite-built index.html for any non-API path
    re_path(r'^(?!api/|admin/|static/|media/|metrics/).*$', spa_index, name='frontend'),
] + static(settings.MEDIA_URL, document_root=settings.MEDIA_ROOT)
