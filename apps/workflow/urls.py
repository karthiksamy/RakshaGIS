from django.urls import path
from rest_framework.routers import DefaultRouter
from .views import WorkflowStepViewSet, AuditLogViewSet, NotificationViewSet, BulkTransitionView, MapActivityLogViewSet

router = DefaultRouter()
router.register('steps', WorkflowStepViewSet, basename='workflow-step')
router.register('audit', AuditLogViewSet, basename='audit-log')
router.register('notifications', NotificationViewSet, basename='notification')
router.register('map-activity', MapActivityLogViewSet, basename='map-activity')

urlpatterns = router.urls + [
    path('bulk-transition/', BulkTransitionView.as_view(), name='bulk-transition'),
]
