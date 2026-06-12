from django.utils import timezone
from rest_framework import viewsets, permissions, status
from rest_framework.decorators import action
from rest_framework.response import Response
from django_filters.rest_framework import DjangoFilterBackend

from apps.accounts.permissions import IsAnyAdmin, IsSuperAdmin, org_queryset_filter
from .models import RevenuePortalConnector, ParcelRevenueLink
from .serializers import RevenuePortalConnectorSerializer, ParcelRevenueLinkSerializer
from .connectors import test_connector, cross_reference_parcel


class RevenuePortalConnectorViewSet(viewsets.ModelViewSet):
    """
    CRUD for revenue portal connectors.  Any admin can view; only superadmins
    can create/edit/delete.  Each admin sees connectors scoped to their org.
    """
    serializer_class = RevenuePortalConnectorSerializer
    filter_backends  = [DjangoFilterBackend]
    filterset_fields = ['portal_type', 'state', 'organisation', 'is_active', 'test_status']

    def get_permissions(self):
        if self.action in ['list', 'retrieve']:
            return [IsAnyAdmin()]
        return [IsSuperAdmin()]

    def get_queryset(self):
        if getattr(self, 'swagger_fake_view', False):
            return RevenuePortalConnector.objects.none()
        user = self.request.user
        qs   = RevenuePortalConnector.objects.select_related(
            'state', 'organisation', 'created_by'
        ).all()
        return org_queryset_filter(user, qs)

    def perform_create(self, serializer):
        serializer.save(created_by=self.request.user)

    # ── /test-connection ──────────────────────────────────────────────────────

    @action(detail=True, methods=['post'], url_path='test-connection',
            permission_classes=[IsAnyAdmin])
    def test_connection(self, request, pk=None):
        """Probe the remote endpoint synchronously and update test_status."""
        conn      = self.get_object()
        ok, msg   = test_connector(conn)
        conn.test_status    = RevenuePortalConnector.STATUS_OK if ok else RevenuePortalConnector.STATUS_ERROR
        conn.test_message   = msg
        conn.last_tested_at = timezone.now()
        conn.save(update_fields=['test_status', 'test_message', 'last_tested_at'])
        return Response({
            'test_status': conn.test_status,
            'message':     msg,
            'tested_at':   conn.last_tested_at,
        }, status=status.HTTP_200_OK if ok else status.HTTP_502_BAD_GATEWAY)

    @action(detail=True, methods=['post'], url_path='test-connection-async',
            permission_classes=[IsAnyAdmin])
    def test_connection_async(self, request, pk=None):
        """Queue a Celery task to test the connector in the background."""
        from .tasks import test_connector_task
        conn = self.get_object()
        test_connector_task.delay(conn.id)
        return Response({'detail': f'Connectivity test queued for "{conn.name}".'})

    # ── /cross-reference ──────────────────────────────────────────────────────

    @action(detail=True, methods=['post'], url_path='cross-reference-all',
            permission_classes=[IsAnyAdmin])
    def cross_reference_all(self, request, pk=None):
        """
        Run this connector against all parcels in the user's organisation.
        Queues one Celery sub-task per parcel.
        """
        from apps.survey_projects.models import DefenceParcel
        from .tasks import cross_reference_parcel_task
        conn = self.get_object()
        qs   = DefenceParcel.objects.filter(
            organisation=conn.organisation, geometry__isnull=False)
        ids  = list(qs.values_list('id', flat=True))
        for pid in ids:
            cross_reference_parcel_task.delay(pid, connector_ids=[conn.id])
        return Response({'detail': f'{len(ids)} parcels queued for cross-referencing.',
                         'parcels_queued': len(ids)})


class ParcelRevenueLinkViewSet(viewsets.ReadOnlyModelViewSet):
    """
    Read-only view of cross-reference results.
    Filter by ?defence_parcel=<id>, ?connector=<id>, ?discrepancy_flag=true.
    """
    serializer_class = ParcelRevenueLinkSerializer
    filter_backends  = [DjangoFilterBackend]
    filterset_fields = ['defence_parcel', 'connector', 'discrepancy_flag',
                        'connector__portal_type']
    permission_classes = [permissions.IsAuthenticated]

    def get_queryset(self):
        if getattr(self, 'swagger_fake_view', False):
            return ParcelRevenueLink.objects.none()
        user = self.request.user
        qs   = ParcelRevenueLink.objects.select_related(
            'defence_parcel', 'connector', 'connector__state'
        ).all()
        return org_queryset_filter(user, qs, org_field='connector__organisation')

    # ── /cross-reference (trigger from the parcel side) ───────────────────────

    @action(detail=False, methods=['post'], url_path='cross-reference',
            permission_classes=[IsAnyAdmin])
    def cross_reference(self, request):
        """
        Body: {"parcel_id": <int>, "connector_ids": [<int>, ...]}
        connector_ids is optional — omit to run all active connectors.
        Runs synchronously and returns the result summary.
        """
        from apps.survey_projects.models import DefenceParcel
        from .models import RevenuePortalConnector

        parcel_id     = request.data.get('parcel_id')
        connector_ids = request.data.get('connector_ids')

        if not parcel_id:
            return Response({'detail': 'parcel_id is required.'},
                            status=status.HTTP_400_BAD_REQUEST)
        try:
            parcel = DefenceParcel.objects.get(pk=parcel_id)
        except DefenceParcel.DoesNotExist:
            return Response({'detail': 'DefenceParcel not found.'},
                            status=status.HTTP_404_NOT_FOUND)

        connectors = None
        if connector_ids:
            connectors = list(RevenuePortalConnector.objects.filter(
                pk__in=connector_ids, is_active=True))

        result = cross_reference_parcel(parcel, connectors)
        return Response(result)
