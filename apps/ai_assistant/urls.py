from django.urls import path
from rest_framework.routers import DefaultRouter
from .views import ChatSessionViewSet, AITaskViewSet, LLMConfigViewSet, EmbeddingViewSet, BoundaryExtractionViewSet

router = DefaultRouter()
router.register('chat', ChatSessionViewSet, basename='chat-session')
router.register('tasks', AITaskViewSet, basename='ai-task')
router.register('llm-configs', LLMConfigViewSet, basename='llm-config')
router.register('rag', EmbeddingViewSet, basename='rag')
router.register('vision', BoundaryExtractionViewSet, basename='vision')

urlpatterns = router.urls
