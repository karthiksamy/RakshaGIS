from django.urls import path
from rest_framework.routers import DefaultRouter
from .views import BasemapConfigViewSet, BrandingConfigView, TerrainConfigView, export_map, map_styles, print_pdf, watermark_file

router = DefaultRouter()
router.register('basemaps', BasemapConfigViewSet, basename='basemap')

urlpatterns = router.urls + [
    path('branding/', BrandingConfigView.as_view(), name='branding'),
    path('terrain-config/', TerrainConfigView.as_view(), name='terrain-config'),
    path('export-map/', export_map, name='export-map'),
    path('map-styles/', map_styles, name='map-styles'),
    path('print-pdf/', print_pdf, name='print-pdf'),
    path('watermark-file/', watermark_file, name='watermark-file'),
]
