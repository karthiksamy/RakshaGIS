from rest_framework.routers import DefaultRouter
from .views import OrganisationViewSet, UserViewSet

router = DefaultRouter()
router.register('organisations', OrganisationViewSet, basename='organisation')
router.register('users', UserViewSet, basename='user')

urlpatterns = router.urls
