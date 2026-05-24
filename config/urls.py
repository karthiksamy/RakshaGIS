from django.contrib import admin
from django.urls import path, include
from django.conf import settings
from django.conf.urls.static import static
from django.views.generic import TemplateView
from drf_spectacular.views import SpectacularAPIView, SpectacularSwaggerView
from rest_framework_simplejwt.views import TokenObtainPairView, TokenRefreshView

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
    path('api/gis/', include('apps.core.urls')),          # basemaps at /api/gis/basemaps/
    path('api/projects/', include('apps.survey_projects.urls')),
    path('api/documents/', include('apps.documents.urls')),
    path('api/workflow/', include('apps.workflow.urls')),
    path('api/ai/', include('apps.ai_assistant.urls')),

    # React SPA catch-all — must be last
    path('', TemplateView.as_view(template_name='index.html'), name='frontend'),
] + static(settings.MEDIA_URL, document_root=settings.MEDIA_ROOT)

# In development, also serve the SPA for any non-API path
handler404 = 'django.views.defaults.page_not_found'
