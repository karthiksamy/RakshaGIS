from rest_framework.routers import DefaultRouter
from .views import (
    ExternalDatabaseViewSet, ExternalLayerViewSet,
    GISServerConnectionViewSet, GISServerLayerViewSet,
)

router = DefaultRouter()
router.register('databases',       ExternalDatabaseViewSet,    basename='external-db')
router.register('layers',          ExternalLayerViewSet,       basename='external-layer')
router.register('gis-servers',     GISServerConnectionViewSet, basename='gis-server')
router.register('gis-server-layers', GISServerLayerViewSet,    basename='gis-server-layer')

urlpatterns = router.urls
