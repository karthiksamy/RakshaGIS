from django.urls import path
from rest_framework.routers import DefaultRouter
from .views import (
    BasemapConfigViewSet, BrandingConfigView, TerrainConfigView,
    TerrainExportGeoTIFFView, DEMAnalysisView, ElevationLookupView,
    DroneDatasetViewSet, LidarUploadView,
    export_map, map_styles, print_pdf, watermark_file,
    start_export, export_status, export_download,
    sentinel2_tile,
)

router = DefaultRouter()
router.register('basemaps', BasemapConfigViewSet, basename='basemap')
router.register('drone-datasets', DroneDatasetViewSet, basename='drone-dataset')

urlpatterns = router.urls + [
    path('branding/', BrandingConfigView.as_view(), name='branding'),
    path('terrain-config/', TerrainConfigView.as_view(), name='terrain-config'),
    path('elevation/', ElevationLookupView.as_view(), name='elevation-lookup'),
    path('terrain/export-geotiff/', TerrainExportGeoTIFFView.as_view(), name='terrain-export-geotiff'),
    path('terrain/dem-analysis/',   DEMAnalysisView.as_view(),          name='terrain-dem-analysis'),
    path('terrain/lidar-upload/',   LidarUploadView.as_view(),          name='terrain-lidar-upload'),
    path('export-map/', export_map, name='export-map'),
    path('map-styles/', map_styles, name='map-styles'),
    path('print-pdf/', print_pdf, name='print-pdf'),
    path('watermark-file/', watermark_file, name='watermark-file'),
    # Async data export
    path('export/start/', start_export, name='export-start'),
    path('export/status/<uuid:task_uuid>/', export_status, name='export-status'),
    path('export/download/<uuid:task_uuid>/', export_download, name='export-download'),
    # Sentinel-2 tile proxy (serves cached tiles or fetches live)
    path('sentinel2-tiles/<int:pk>/<int:z>/<int:x>/<int:y>/', sentinel2_tile, name='sentinel2-tile'),
]
