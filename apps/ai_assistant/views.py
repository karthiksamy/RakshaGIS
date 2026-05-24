import os

from django.conf import settings
from django.http import FileResponse, Http404
from rest_framework import viewsets, permissions, status
from rest_framework.decorators import action
from rest_framework.response import Response

from .models import ChatSession, ChatMessage, AITask
from .serializers import (
    ChatSessionSerializer, ChatMessageSerializer,
    ChatInputSerializer, AITaskSerializer,
)
from .services import OllamaService


class ChatSessionViewSet(viewsets.ModelViewSet):
    serializer_class = ChatSessionSerializer
    permission_classes = [permissions.IsAuthenticated]

    def get_queryset(self):
        return ChatSession.objects.filter(user=self.request.user).prefetch_related('messages')

    def perform_create(self, serializer):
        serializer.save(user=self.request.user)

    @action(detail=True, methods=['post'])
    def chat(self, request, pk=None):
        session = self.get_object()
        serializer = ChatInputSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)

        user_message = serializer.validated_data['message']

        ChatMessage.objects.create(session=session, role=ChatMessage.USER, content=user_message)

        history = list(session.messages.values('role', 'content').order_by('timestamp'))
        ollama_messages = [
            {'role': msg['role'].lower(), 'content': msg['content']}
            for msg in history
        ]

        service = OllamaService()
        try:
            reply = service.chat(ollama_messages)
        except Exception as exc:
            return Response({'detail': f'AI service unavailable: {exc}'}, status=status.HTTP_503_SERVICE_UNAVAILABLE)

        assistant_msg = ChatMessage.objects.create(session=session, role=ChatMessage.ASSISTANT, content=reply)

        session.save(update_fields=['updated_at'])

        return Response(ChatMessageSerializer(assistant_msg).data)


class AITaskViewSet(viewsets.ReadOnlyModelViewSet):
    serializer_class = AITaskSerializer
    permission_classes = [permissions.IsAuthenticated]

    def get_queryset(self):
        user = self.request.user
        if user.role in ('SUPERADMIN', 'PDDE_VIEWER', 'DEO_ADMIN'):
            return AITask.objects.select_related('requested_by').all()
        return AITask.objects.select_related('requested_by').filter(requested_by=user)

    @action(detail=False, methods=['post'], url_path='generate-report/(?P<project_pk>[^/.]+)')
    def generate_report(self, request, project_pk=None):
        from apps.ai_assistant.tasks import generate_project_report

        task = AITask.objects.create(
            task_type=AITask.REPORT_GENERATION,
            requested_by=request.user,
            input_data={'project_id': project_pk},
        )
        generate_project_report.delay(task.id)
        return Response({'task_id': task.id, 'detail': 'Report generation queued.'})

    @action(detail=False, methods=['get'])
    def health(self, request):
        service = OllamaService()
        available = service.is_available()
        return Response({
            'ollama_available': available,
            'model': service.model,
            'base_url': service.base_url,
        })

    @action(detail=True, methods=['get'], url_path='download-report')
    def download_report(self, request, pk=None):
        """Download the generated report text file for a DONE report-generation task."""
        task = self.get_object()
        if task.task_type != AITask.REPORT_GENERATION:
            return Response({'detail': 'Not a report task.'}, status=status.HTTP_400_BAD_REQUEST)
        if task.status != AITask.DONE:
            return Response({'detail': f'Report not ready. Status: {task.status}'}, status=status.HTTP_409_CONFLICT)

        rel_path = (task.result or {}).get('file_rel_path')
        if not rel_path:
            return Response({'detail': 'Report file path not recorded.'}, status=status.HTTP_404_NOT_FOUND)

        abs_path = os.path.join(settings.MEDIA_ROOT, rel_path)
        if not os.path.exists(abs_path):
            raise Http404

        return FileResponse(
            open(abs_path, 'rb'),
            as_attachment=True,
            filename=os.path.basename(abs_path),
            content_type='text/plain; charset=utf-8',
        )
