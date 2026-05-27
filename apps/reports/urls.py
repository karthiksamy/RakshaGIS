from rest_framework.routers import DefaultRouter
from .views import ReportScheduleViewSet

router = DefaultRouter()
router.register('schedules', ReportScheduleViewSet, basename='report-schedule')

urlpatterns = router.urls
