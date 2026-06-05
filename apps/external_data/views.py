import logging
from django.utils import timezone
from rest_framework import viewsets, permissions, status
from rest_framework.decorators import action
from rest_framework.response import Response

from apps.accounts.permissions import IsSuperAdmin, IsAnyAdmin
from .models import ExternalDatabase, ExternalLayer, GISServerConnection, GISServerLayer
from .serializers import (
    ExternalDatabaseSerializer, ExternalLayerSerializer,
    GISServerConnectionSerializer, GISServerLayerSerializer,
)
from .db_utils import (
    test_connection, list_spatial_tables, table_columns,
    layer_geojson, layer_bbox_and_count, import_mst_office,
    distinct_column_values, search_external_layer,
)
from .gis_server_utils import (
    test_gis_connection, discover_layers,
    fetch_vector_features, wms_tile_config,
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


# ── GIS Server views ──────────────────────────────────────────────────────────

class GISServerConnectionViewSet(viewsets.ModelViewSet):
    """
    CRUD for GIS server connections.
    Any authenticated user can add/manage connections; all can read active ones.
    """
    serializer_class = GISServerConnectionSerializer

    def get_permissions(self):
        return [permissions.IsAuthenticated()]

    def get_queryset(self):
        qs = GISServerConnection.objects.prefetch_related('layers').all()
        user = self.request.user
        if getattr(user, 'role', None) != 'SUPERADMIN':
            qs = qs.filter(is_active=True)
        return qs

    def perform_create(self, serializer):
        serializer.save(added_by=self.request.user)

    def update(self, request, *args, **kwargs):
        partial = kwargs.pop('partial', True)
        instance = self.get_object()
        data = request.data.copy()
        if not data.get('password'):
            data['password'] = instance.password
        if not data.get('token'):
            data['token'] = instance.token
        serializer = self.get_serializer(instance, data=data, partial=partial)
        serializer.is_valid(raise_exception=True)
        self.perform_update(serializer)
        return Response(serializer.data)

    @action(detail=True, methods=['post'], url_path='test')
    def test(self, request, pk=None):
        """POST .../test/ — verify connectivity."""
        conn = self.get_object()
        ok, msg = test_gis_connection(conn)
        conn.test_status    = GISServerConnection.STATUS_OK if ok else GISServerConnection.STATUS_ERROR
        conn.test_message   = msg
        conn.last_tested_at = timezone.now()
        conn.save(update_fields=['test_status', 'test_message', 'last_tested_at'])
        return Response({'ok': ok, 'message': msg})

    @action(detail=True, methods=['get'], url_path='capabilities')
    def capabilities(self, request, pk=None):
        """GET .../capabilities/ — auto-discover available layers from the server."""
        conn = self.get_object()
        try:
            layers = discover_layers(conn)
        except Exception as exc:
            return Response({'detail': str(exc)}, status=500)
        return Response({'count': len(layers), 'layers': layers})


class GISServerLayerViewSet(viewsets.ModelViewSet):
    """
    CRUD for GIS server layers.
    Any authenticated user can add/manage layers at their level.
    Layers are org-scoped: SUPERADMIN-added layers (organisation=null) are visible to all;
    other users' layers are visible only within their own organisation.
    """
    serializer_class = GISServerLayerSerializer

    def get_permissions(self):
        return [permissions.IsAuthenticated()]

    def get_queryset(self):
        from django.db.models import Q
        qs = GISServerLayer.objects.select_related('connection', 'organisation').all()
        user = self.request.user
        if user.role == 'SUPERADMIN':
            return qs
        # Non-superadmin: active only + (global layers OR own-org layers)
        return qs.filter(
            is_active=True,
            connection__is_active=True,
        ).filter(
            Q(organisation__isnull=True) | Q(organisation=user.organisation)
        )

    def perform_create(self, serializer):
        user = self.request.user
        # Non-superadmin admins: automatically scope to their own organisation
        org = None if user.role == 'SUPERADMIN' else getattr(user, 'organisation', None)
        serializer.save(added_by=user, organisation=org)

    @action(detail=True, methods=['get'], url_path='features')
    def features(self, request, pk=None):
        """
        GET .../features/
        Proxy vector features (WFS or ArcGIS Feature Service) as GeoJSON.
        Use ?bbox=minLon,minLat,maxLon,maxLat and ?limit=N to control results.
        """
        layer = self.get_object()
        if not layer.is_vector:
            return Response({'detail': 'This layer uses a raster/tile protocol — use tile_config instead.'}, status=400)
        if not layer.connection.is_active:
            return Response({'detail': 'GIS server connection is inactive.'}, status=503)

        limit = min(int(request.query_params.get('limit', 10_000)), 50_000)
        bbox = None
        bbox_raw = (request.query_params.get('bbox') or '').strip()
        if bbox_raw:
            try:
                parts = [float(x) for x in bbox_raw.split(',')]
                if len(parts) == 4:
                    bbox = parts
            except ValueError:
                pass

        try:
            fc = fetch_vector_features(layer, bbox=bbox, limit=limit)
        except Exception as exc:
            logger.error('GIS server features fetch failed for %s: %s', layer, exc)
            return Response({'detail': f'Feature fetch failed: {exc}'}, status=500)

        # Backfill feature_count if not set
        if layer.feature_count is None and 'features' in fc:
            try:
                layer.feature_count = len(fc['features'])
                layer.last_synced_at = timezone.now()
                layer.save(update_fields=['feature_count', 'last_synced_at'])
            except Exception:
                pass

        return Response(fc)

    @action(detail=True, methods=['get'], url_path='tile-config')
    def tile_config(self, request, pk=None):
        """
        GET .../tile-config/
        Return WMS/WMTS params that the browser uses to construct a TileLayer source.
        """
        layer = self.get_object()
        if not layer.is_tile:
            return Response({'detail': 'This is a vector layer — use /features/ instead.'}, status=400)
        return Response(wms_tile_config(layer))

    @action(detail=True, methods=['post'], url_path='refresh-stats')
    def refresh_stats(self, request, pk=None):
        """POST .../refresh-stats/ — refresh feature_count for vector layers."""
        layer = self.get_object()
        if not layer.is_vector:
            return Response({'detail': 'Stats refresh only supported for vector layers.'}, status=400)
        try:
            fc = fetch_vector_features(layer, limit=1)
            # Re-fetch without limit for count
            fc_all = fetch_vector_features(layer, limit=50_000)
            count = len(fc_all.get('features', []))
            layer.feature_count  = count
            layer.last_synced_at = timezone.now()
            layer.save(update_fields=['feature_count', 'last_synced_at'])
        except Exception as exc:
            return Response({'detail': str(exc)}, status=500)
        return Response({'feature_count': layer.feature_count})

    @action(detail=True, methods=['get'], url_path='distinct-values')
    def distinct_values(self, request, pk=None):
        """GET .../distinct-values/?field=Land_Use — unique values for classification setup."""
        layer = self.get_object()
        field = (request.query_params.get('field') or '').strip()
        if not field:
            return Response({'detail': 'field query parameter required.'}, status=400)
        if not layer.is_vector:
            return Response({'detail': 'distinct-values only available for vector layers.'}, status=400)
        try:
            fc = fetch_vector_features(layer, limit=50_000)
            values = sorted({
                str(f.get('properties', {}).get(field, ''))
                for f in fc.get('features', [])
                if f.get('properties', {}).get(field) is not None
            })[:500]
        except Exception as exc:
            return Response({'detail': str(exc)}, status=500)
        return Response({'field': field, 'values': values})
