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
    distinct_column_values, search_external_layer,
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
        if result.get('unknown_level_codes'):
            logger.warning('sync_orgs DB %s: unrecognised officelevelid codes %s',
                           db.id, result['unknown_level_codes'])
        return Response(result)


class ExternalLayerViewSet(viewsets.ModelViewSet):
    """
    CRUD for external layer registrations.
    Super admin manages; all authenticated users can read active layers.
    """
    serializer_class = ExternalLayerSerializer

    def get_permissions(self):
        if self.action in ('list', 'retrieve', 'geojson', 'search'):
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
            # Cap high enough that an unfiltered (DGDE/superadmin) view of a large
            # layer is not silently truncated. Filtered users get far fewer rows.
            limit = min(int(request.query_params.get('limit', 20_000)), 200_000)
            # Optional viewport filter: ?bbox=minLon,minLat,maxLon,maxLat (WGS84)
            bbox = None
            bbox_raw = (request.query_params.get('bbox') or '').strip()
            if bbox_raw:
                try:
                    parts = [float(x) for x in bbox_raw.split(',')]
                    if len(parts) == 4:
                        bbox = parts
                except ValueError:
                    bbox = None
            # Optional attribute filter: ?filter_field=Col&filter_value=Val
            filter_field = (request.query_params.get('filter_field') or '').strip()
            filter_value = request.query_params.get('filter_value')
            # Pass the logged-in user so office-based row filtering is applied.
            fc    = layer_geojson(
                layer, limit=limit, user=request.user, bbox=bbox,
                attr_field=filter_field or None,
                attr_value=filter_value if filter_field else None,
            )
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

    # ── /search ──────────────────────────────────────────────────────────────

    @action(detail=False, methods=['get'], url_path='search')
    def search(self, request):
        """
        GET /api/external/layers/search/?q=keyword[&limit=15]

        Keyword-search across all active external layers' attributes and return
        matching features (with WGS84 geometry) so the map viewer can fly to them.
        The same per-level office filtering as the map is applied, so users only
        find features they are allowed to see.
        """
        q = (request.query_params.get('q') or '').strip()
        if len(q) < 2:
            return Response({'detail': 'Enter at least 2 characters.', 'results': []}, status=400)

        try:
            per_layer = min(int(request.query_params.get('limit', 15)), 50)
        except ValueError:
            per_layer = 15
        total_cap = 100

        results: list = []
        # get_queryset already restricts to active layers for non-superadmins.
        for layer in self.get_queryset().filter(is_active=True, database__is_active=True):
            if len(results) >= total_cap:
                break
            try:
                results.extend(search_external_layer(layer, q, user=request.user, limit=per_layer))
            except Exception as exc:
                logger.warning('search failed for layer %s: %s', layer, exc)
                continue

        return Response({'query': q, 'count': len(results), 'results': results[:total_cap]})

    # ── /distinct-values ─────────────────────────────────────────────────────

    @action(detail=True, methods=['get'], url_path='distinct-values',
            permission_classes=[permissions.IsAuthenticated])
    def distinct_values(self, request, pk=None):
        """
        GET /api/external/layers/{id}/distinct-values/?field=Land_Use_Type

        Return the distinct values of an attribute column. Used by the super admin
        to auto-generate a classification colour map, and by viewers (e.g. the 3D
        Terrain Viewer) to populate a value filter for the configured column.
        """
        layer = self.get_object()
        field = (request.query_params.get('field') or '').strip()
        if not field:
            return Response({'detail': 'field query parameter is required.'}, status=400)
        try:
            limit  = min(int(request.query_params.get('limit', 200)), 1000)
            values = distinct_column_values(layer, field, limit=limit)
        except ValueError as exc:
            return Response({'detail': str(exc)}, status=400)
        except Exception as exc:
            logger.error('distinct_values failed for %s.%s: %s', layer, field, exc)
            return Response({'detail': str(exc)}, status=500)
        return Response({'field': field, 'values': values})
