from rest_framework.routers import DefaultRouter
from .views import ExternalDatabaseViewSet, ExternalLayerViewSet

router = DefaultRouter()
router.register('databases', ExternalDatabaseViewSet, basename='external-db')
router.register('layers',    ExternalLayerViewSet,    basename='external-layer')

urlpatterns = router.urls
