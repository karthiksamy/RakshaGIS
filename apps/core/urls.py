from django.urls import path
from rest_framework.routers import DefaultRouter
from .views import BasemapConfigViewSet, BrandingConfigView

router = DefaultRouter()
router.register('basemaps', BasemapConfigViewSet, basename='basemap')

urlpatterns = router.urls + [
    path('branding/', BrandingConfigView.as_view(), name='branding'),
]
