from rest_framework.routers import DefaultRouter
from .views import RevenuePortalConnectorViewSet, ParcelRevenueLinkViewSet

router = DefaultRouter()
router.register('connectors', RevenuePortalConnectorViewSet, basename='revenue-connector')
router.register('links',      ParcelRevenueLinkViewSet,      basename='revenue-link')

urlpatterns = router.urls
