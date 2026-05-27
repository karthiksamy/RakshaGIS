from django.urls import path
from rest_framework.routers import DefaultRouter
from .views import StateViewSet, DistrictViewSet, TalukViewSet, VillageViewSet, RevenueMapViewSet, HeatmapView

router = DefaultRouter()
router.register('states', StateViewSet, basename='state')
router.register('districts', DistrictViewSet, basename='district')
router.register('taluks', TalukViewSet, basename='taluk')
router.register('villages', VillageViewSet, basename='village')
router.register('revenue-maps', RevenueMapViewSet, basename='revenue-map')

urlpatterns = router.urls + [
    path('heatmap/', HeatmapView.as_view(), name='gis-heatmap'),
]
