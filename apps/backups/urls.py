from rest_framework.routers import DefaultRouter
from .views import BackupJobViewSet, BackupScheduleViewSet

router = DefaultRouter()
router.register('jobs', BackupJobViewSet, basename='backup-job')
router.register('schedules', BackupScheduleViewSet, basename='backup-schedule')

urlpatterns = router.urls
