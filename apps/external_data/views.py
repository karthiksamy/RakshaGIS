import logging
from django.utils import timezone
from rest_framework import viewsets, permissions, status
from rest_framework.decorators import action
from rest_framework.response import Response

from apps.accounts.permissions import IsSuperAdmin
from .models import ExternalDatabase, ExternalLayer
from .serializers import ExternalDatabaseSerializer, ExternalLayerSerializer
from .db_utils import (
    test_connection, list_spatial_tables, table_columns,
    layer_geojson, layer_bbox_and_count, import_mst_office,
)

logger = logging.getLogger(__name__)


class ExternalDatabaseViewSet(viewsets.ModelViewSet):
    """
    CRUD for external database connections.
    Super admin only — these contain credentials.
    """
    serializer_class   = ExternalDatabaseSerializer
    permission_classes = [IsSuperAdmin]
    queryset           = ExternalDatabase.objects.prefetch_related('layers').all()

    def perform_create(self, serializer):
        serializer.save(added_by=self.request.user)

    def update(self, request, *args, **kwargs):
        # PATCH: if password not provided, keep existing value
        partial = kwargs.pop('partial', True)
        instance = self.get_object()
        data = request.data.copy()
        if not data.get('password'):
            data['password'] = instance.password
        serializer = self.get_serializer(instance, data=data, partial=partial)
        serializer.is_valid(raise_exception=True)
        self.perform_update(serializer)
        return Response(serializer.data)

    # ── /test ──────────────────────────────────────────────────────────────

    @action(detail=True, methods=['post'], url_path='test')
    def test(self, request, pk=None):
        """POST /api/external/databases/{id}/test/ — test connectivity."""
        db = self.get_object()
        ok, msg = test_connection(db)
        db.test_status   = ExternalDatabase.STATUS_OK if ok else ExternalDatabase.STATUS_ERROR
        db.test_message  = msg
        db.last_tested_at = timezone.now()
        db.save(update_fields=['test_status', 'test_message', 'last_tested_at'])
        return Response({'ok': ok, 'message': msg})

    # ── /tables ────────────────────────────────────────────────────────────

    @action(detail=True, methods=['get'], url_path='tables')
    def tables(self, request, pk=None):
        """GET /api/external/databases/{id}/tables/ — list spatial tables."""
        db = self.get_object()
        try:
            tables = list_spatial_tables(db)
        except Exception as exc:
            return Response({'detail': str(exc)}, status=500)
        return Response(tables)

    @action(detail=True, methods=['get'], url_path='tables/(?P<schema>[^/.]+)/(?P<table>[^/.]+)/columns')
    def table_columns_view(self, request, pk=None, schema=None, table=None):
        """GET .../tables/{schema}/{table}/columns — list non-geometry columns."""
        db = self.get_object()
        try:
            cols = table_columns(db, schema, table)
        except Exception as exc:
            return Response({'detail': str(exc)}, status=500)
        return Response(cols)

    # ── /sync-orgs ─────────────────────────────────────────────────────────

    @action(detail=True, methods=['post'], url_path='sync-orgs')
    def sync_orgs(self, request, pk=None):
        """
        POST /api/external/databases/{id}/sync-orgs/

        Import mst_office records from the external DB into
        the local Organisation table (upsert by office_id).
        Optionally pass ?schema=myschema to override the default schema.
        """
        db     = self.get_object()
        schema = request.query_params.get('schema', db.schema or 'public')
        try:
            result = import_mst_office(db, schema=schema)
        except Exception as exc:
            logger.exception('sync_orgs failed for DB %s', db.id)
            return Response({'detail': str(exc)}, status=500)

        db.last_sync_at = timezone.now()
        db.save(update_fields=['last_sync_at'])
        return Response(result)


class ExternalLayerViewSet(viewsets.ModelViewSet):
    """
    CRUD for external layer registrations.
    Super admin manages; all authenticated users can read active layers.
    """
    serializer_class = ExternalLayerSerializer

    def get_permissions(self):
        if self.action in ('list', 'retrieve', 'geojson'):
            return [permissions.IsAuthenticated()]
        return [IsSuperAdmin()]

    def get_queryset(self):
        qs = ExternalLayer.objects.select_related('database').all()
        if not (self.request.user.is_authenticated and
                getattr(self.request.user, 'role', None) == 'SUPERADMIN'):
            qs = qs.filter(is_active=True, database__is_active=True)
        return qs

    def perform_create(self, serializer):
        layer = serializer.save(added_by=self.request.user)
        # Auto-populate bbox and feature count
        try:
            bbox, count = layer_bbox_and_count(layer)
            if bbox or count is not None:
                layer.bbox          = bbox
                layer.feature_count = count
                layer.last_synced_at = timezone.now()
                layer.save(update_fields=['bbox', 'feature_count', 'last_synced_at'])
        except Exception as exc:
            logger.warning('Could not get bbox/count for new layer %s: %s', layer, exc)

    # ── /geojson ───────────────────────────────────────────────────────────

    @action(detail=True, methods=['get'], url_path='geojson')
    def geojson(self, request, pk=None):
        """
        GET /api/external/layers/{id}/geojson/

        Live query to the external DB — returns GeoJSON FeatureCollection.
        Use ?limit=N to control max features (default 5000, max 20000).
        """
        layer = self.get_object()
        if not layer.database.is_active:
            return Response({'detail': 'Source database is inactive.'}, status=503)
        try:
            limit = min(int(request.query_params.get('limit', 5000)), 20_000)
            # Pass the logged-in user so office-based row filtering is applied.
            fc    = layer_geojson(layer, limit=limit, user=request.user)
        except Exception as exc:
            logger.error('layer_geojson failed for %s: %s', layer, exc)
            return Response({'detail': f'Query failed: {exc}'}, status=500)

        # Opportunistically backfill feature_count/bbox if missing (e.g. layers
        # added before the external DB was reachable). Best-effort; non-fatal.
        if layer.feature_count is None:
            try:
                bbox, count = layer_bbox_and_count(layer)
                if count is not None:
                    from django.utils import timezone
                    layer.feature_count  = count
                    layer.bbox           = bbox
                    layer.last_synced_at = timezone.now()
                    layer.save(update_fields=['feature_count', 'bbox', 'last_synced_at'])
            except Exception:
                pass

        return Response(fc)

    # ── /refresh-stats ─────────────────────────────────────────────────────

    @action(detail=True, methods=['post'], url_path='refresh-stats')
    def refresh_stats(self, request, pk=None):
        """POST .../refresh-stats/ — update bbox + feature_count from external DB."""
        layer = self.get_object()
        try:
            bbox, count = layer_bbox_and_count(layer)
            layer.bbox           = bbox
            layer.feature_count  = count
            layer.last_synced_at = timezone.now()
            layer.save(update_fields=['bbox', 'feature_count', 'last_synced_at'])
        except Exception as exc:
            return Response({'detail': str(exc)}, status=500)
        return Response({'bbox': layer.bbox, 'feature_count': layer.feature_count})

    # ── /columns ───────────────────────────────────────────────────────────

    @action(detail=True, methods=['get'], url_path='columns',
            permission_classes=[IsSuperAdmin])
    def columns(self, request, pk=None):
        """
        GET /api/external/layers/{id}/columns/

        List the non-geometry columns of the underlying external table so the
        super admin can choose which one to use as the office filter field.
        """
        layer = self.get_object()
        try:
            cols = table_columns(layer.database, layer.schema_name, layer.table_name)
        except Exception as exc:
            return Response({'detail': str(exc)}, status=500)
        return Response(cols)
