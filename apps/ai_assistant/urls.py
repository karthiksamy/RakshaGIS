from rest_framework.routers import DefaultRouter
from .views import ChatSessionViewSet, AITaskViewSet

router = DefaultRouter()
router.register('chat', ChatSessionViewSet, basename='chat-session')
router.register('tasks', AITaskViewSet, basename='ai-task')

urlpatterns = router.urls
