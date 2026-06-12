from rest_framework import viewsets, permissions, status
from rest_framework.decorators import action
from rest_framework.response import Response
from django_filters.rest_framework import DjangoFilterBackend

from apps.accounts.permissions import IsSuperAdmin
from .models import ReportSchedule
from .serializers import ReportScheduleSerializer
from .tasks import send_scheduled_reports


class ReportScheduleViewSet(viewsets.ModelViewSet):
    serializer_class = ReportScheduleSerializer
    filter_backends = [DjangoFilterBackend]
    filterset_fields = ['organisation', 'frequency', 'report_type', 'is_active']

    def get_permissions(self):
        if self.action in ['list', 'retrieve']:
            return [permissions.IsAuthenticated()]
        return [IsSuperAdmin()]

    def get_queryset(self):
        from apps.accounts.permissions import org_queryset_filter
        user = self.request.user
        qs = ReportSchedule.objects.select_related('organisation', 'created_by').all()
        return org_queryset_filter(user, qs)

    def perform_create(self, serializer):
        serializer.save(created_by=self.request.user)

    @action(detail=True, methods=['post'], url_path='send-now')
    def send_now(self, request, pk=None):
        schedule = self.get_object()
        # Force this schedule due — otherwise a future next_run means
        # "Send Now" silently skips it.
        ReportSchedule.objects.filter(pk=schedule.pk).update(next_run=None)
        send_scheduled_reports.delay()
        return Response({'detail': f'Report "{schedule.name}" queued for sending.'})

    @action(detail=False, methods=['post'], url_path='run-all')
    def run_all(self, request):
        send_scheduled_reports.delay()
        return Response({'detail': 'All due reports queued for sending.'})
