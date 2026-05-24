from rest_framework.routers import DefaultRouter
from .views import BasemapConfigViewSet

router = DefaultRouter()
router.register('basemaps', BasemapConfigViewSet, basename='basemap')

urlpatterns = router.urls
