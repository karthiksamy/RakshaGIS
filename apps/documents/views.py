import os

from django.http import FileResponse, Http404
from rest_framework import viewsets, permissions, status
from rest_framework.decorators import action
from rest_framework.response import Response
from django_filters.rest_framework import DjangoFilterBackend
from rest_framework.filters import SearchFilter

from apps.accounts.permissions import CanEditProject, org_queryset_filter
from .models import Document
from .serializers import DocumentSerializer


class DocumentViewSet(viewsets.ModelViewSet):
    serializer_class = DocumentSerializer
    filter_backends = [DjangoFilterBackend, SearchFilter]
    filterset_fields = ['project', 'category', 'ai_processed']
    search_fields = ['title']

    def get_queryset(self):
        return org_queryset_filter(
            self.request.user,
            Document.objects.select_related('project__organisation', 'uploaded_by'),
            org_field='project__organisation',
        )

    def get_permissions(self):
        if self.action in ['create', 'update', 'partial_update', 'destroy']:
            return [CanEditProject()]
        return [permissions.IsAuthenticated()]

    def perform_create(self, serializer):
        file = self.request.FILES.get('file')
        mime_type = ''
        file_size = 0
        if file:
            try:
                import magic
                mime_type = magic.from_buffer(file.read(2048), mime=True)
                file.seek(0)
            except Exception:
                pass
            file_size = file.size
        serializer.save(
            uploaded_by=self.request.user,
            mime_type=mime_type,
            file_size=file_size,
        )

    @action(detail=True, methods=['post'])
    def process_ai(self, request, pk=None):
        """Queue async AI text extraction + summarisation for this document."""
        document = self.get_object()
        if document.ai_processed:
            return Response({'detail': 'Already processed.'}, status=status.HTTP_200_OK)

        from apps.ai_assistant.tasks import process_document_ai
        from apps.ai_assistant.models import AITask

        task = AITask.objects.create(
            task_type=AITask.PDF_EXTRACTION,
            requested_by=request.user,
            input_data={'document_id': document.id},
        )
        process_document_ai.delay(task.id)
        return Response({'task_id': task.id, 'detail': 'AI processing queued.'})
