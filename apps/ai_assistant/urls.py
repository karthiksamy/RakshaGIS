from rest_framework.routers import DefaultRouter
from .views import ChatSessionViewSet, AITaskViewSet, LLMConfigViewSet

router = DefaultRouter()
router.register('chat', ChatSessionViewSet, basename='chat-session')
router.register('tasks', AITaskViewSet, basename='ai-task')
router.register('llm-configs', LLMConfigViewSet, basename='llm-config')

urlpatterns = router.urls
