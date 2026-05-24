from rest_framework.routers import DefaultRouter
from .views import WorkflowStepViewSet, AuditLogViewSet, NotificationViewSet

router = DefaultRouter()
router.register('steps', WorkflowStepViewSet, basename='workflow-step')
router.register('audit', AuditLogViewSet, basename='audit-log')
router.register('notifications', NotificationViewSet, basename='notification')

urlpatterns = router.urls
