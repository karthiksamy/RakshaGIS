import math
import os
from rest_framework import viewsets, permissions, parsers
from rest_framework.decorators import action
from rest_framework.exceptions import PermissionDenied
from rest_framework.views import APIView
from rest_framework.response import Response

from apps.accounts.permissions import IsSuperAdmin
from .models import BasemapConfig, BrandingConfig, DroneDataset, DroneUploadSession
from .serializers import BasemapConfigSerializer, BrandingConfigSerializer, DroneDatasetSerializer


class BrandingConfigView(APIView):
    """GET: public (no auth). PATCH: superadmin only."""

    def get_permissions(self):
        if self.request.method == 'GET':
            return [permissions.AllowAny()]
        return [IsSuperAdmin()]

    def get(self, request):
        obj = BrandingConfig.get_solo()
        resp = Response(BrandingConfigSerializer(obj).data)
        # Never let browsers or proxies cache branding — admins update it and
        # the login page (public, no auth) must always see the latest values.
        resp['Cache-Control'] = 'no-store, no-cache, must-revalidate'
        resp['Pragma'] = 'no-cache'
        return resp

    def patch(self, request):
        obj = BrandingConfig.get_solo()
        ser = BrandingConfigSerializer(obj, data=request.data, partial=True)
        ser.is_valid(raise_exception=True)
        ser.save()
        return Response(ser.data)


class BasemapConfigViewSet(viewsets.ModelViewSet):
    serializer_class = BasemapConfigSerializer
    parser_classes = [
        parsers.MultiPartParser,
        parsers.FormParser,
        parsers.JSONParser,
    ]

    def get_queryset(self):
        user = self.request.user
        qs = BasemapConfig.objects.select_related('created_by', 'organisation')

        if not user.is_authenticated:
            return qs.filter(is_active=True, organisation__isnull=True)

        if user.is_superadmin:
            return qs

        # Regular users: global active basemaps + own-org basemaps
        org_id = getattr(user, 'organisation_id', None)
        from django.db.models import Q
        qs = qs.filter(is_active=True).filter(
            Q(organisation__isnull=True) |
            Q(organisation_id=org_id)
        )
        return qs

    def get_permissions(self):
        if self.action in ['list', 'retrieve']:
            return [permissions.IsAuthenticated()]
        if self.action in ['create']:
            # SDOs/Admins can create LOCAL_COG basemaps; only superadmin for others
            return [permissions.IsAuthenticated()]
        if self.action in ['partial_update', 'update', 'destroy', 'set_default']:
            return [permissions.IsAuthenticated()]
        return [IsSuperAdmin()]

    def _can_manage(self, instance=None):
        user = self.request.user
        if user.is_superadmin:
            return True
        # Org-scoped LOCAL_COG: org admins can manage their own
        if instance and instance.provider == BasemapConfig.LOCAL_COG:
            org_id = getattr(user, 'organisation_id', None)
            if instance.organisation_id == org_id and user.role in getattr(user, 'ADMIN_ROLES', []):
                return True
        return False

    def perform_create(self, serializer):
        user = self.request.user
        provider = self.request.data.get('provider', '')

        if provider == BasemapConfig.LOCAL_COG:
            # Any SDO/Admin may upload a local basemap for their org
            if not user.is_superadmin and user.role not in getattr(user, 'ADMIN_ROLES', []) + ['SDO', 'SURVEYOR']:
                raise PermissionDenied("Only SDO/Admin roles can upload local basemaps.")

            org_id = getattr(user, 'organisation_id', None)
            tiff = self.request.FILES.get('tiff_file')
            instance = serializer.save(
                created_by=user,
                organisation_id=org_id,
                tiff_file=tiff,
                cog_status=BasemapConfig.COG_PENDING,
                url_template='',
                is_system=False,
            )
            # Queue COG conversion
            from apps.core.tasks import convert_basemap_to_cog
            convert_basemap_to_cog.delay(instance.pk)
        else:
            if not user.is_superadmin:
                raise PermissionDenied("Only superadmins can create non-local basemaps.")
            serializer.save(created_by=user)

    def perform_update(self, serializer):
        if not self._can_manage(serializer.instance):
            raise PermissionDenied("You don't have permission to modify this basemap.")
        serializer.save()

    def perform_destroy(self, instance):
        if instance.is_system:
            raise PermissionDenied("System basemap configurations cannot be deleted.")
        if not self._can_manage(instance):
            raise PermissionDenied("You don't have permission to delete this basemap.")
        # Remove files
        for fld in (instance.tiff_file, instance.cog_file):
            if fld:
                try:
                    fld.delete(save=False)
                except Exception:
                    pass
        instance.delete()

    @action(detail=True, methods=['post'], permission_classes=[permissions.IsAuthenticated])
    def set_default(self, request, pk=None):
        """Mark this basemap as the default within its scope (org or global)."""
        basemap = self.get_object()
        if not self._can_manage(basemap):
            raise PermissionDenied("You don't have permission to set this as default.")
        basemap.is_default = True
        basemap.save()
        return Response(BasemapConfigSerializer(basemap, context={'request': request}).data)

    @action(detail=True, methods=['get'], permission_classes=[permissions.IsAuthenticated])
    def cog_status(self, request, pk=None):
        """Poll COG conversion status for a LOCAL_COG basemap."""
        bm = self.get_object()
        return Response({
            'id': bm.pk,
            'cog_status': bm.cog_status,
            'cog_error': bm.cog_error or None,
            'cog_url': BasemapConfigSerializer(bm, context={'request': request}).get_cog_url(bm),
            'bounds': {
                'west': bm.bounds_west, 'south': bm.bounds_south,
                'east': bm.bounds_east, 'north': bm.bounds_north,
            } if bm.bounds_west is not None else None,
        })


# ── Drone Dataset ViewSet ─────────────────────────────────────────────────────

class DroneDatasetViewSet(viewsets.ModelViewSet):
    """
    CRUD + upload for DroneDataset (org-scoped).

    Large files: POST multipart/form-data; the file field accepts up to 50 GB.
    Processing is async; poll /status/ until status == 'DONE'.
    """
    serializer_class = DroneDatasetSerializer
    parser_classes = [
        parsers.MultiPartParser,
        parsers.FormParser,
        parsers.JSONParser,
    ]

    def get_queryset(self):
        user = self.request.user
        qs = DroneDataset.objects.select_related(
            'organisation', 'uploaded_by', 'project',
        )
        if user.is_superadmin:
            return qs
        from django.db.models import Q
        org_id = getattr(user, 'organisation_id', None)
        # Users see their own org's datasets + shared project datasets
        return qs.filter(organisation_id=org_id)

    def get_permissions(self):
        if self.action in ['list', 'retrieve', 'status']:
            return [permissions.IsAuthenticated()]
        if self.action in ['partial_update', 'update']:
            return [permissions.IsAuthenticated()]
        if self.action == 'destroy':
            return [permissions.IsAuthenticated()]
        return [permissions.IsAuthenticated()]

    def perform_create(self, serializer):
        user = self.request.user
        uploaded_file = self.request.FILES.get('file')
        if not uploaded_file:
            from rest_framework.exceptions import ValidationError
            raise ValidationError({'file': 'A file is required.'})

        org_id = getattr(user, 'organisation_id', None)
        instance = serializer.save(
            uploaded_by=user,
            organisation_id=org_id,
            file=uploaded_file,
            file_size=uploaded_file.size,
            original_filename=uploaded_file.name,
            status=DroneDataset.PENDING,
        )
        from apps.core.tasks import process_drone_dataset
        process_drone_dataset.delay(instance.pk)

    def perform_destroy(self, instance):
        user = self.request.user
        if not (user.is_superadmin or
                instance.organisation_id == getattr(user, 'organisation_id', None)):
            raise PermissionDenied("Cannot delete datasets from another organisation.")
        for fld in (instance.file, instance.cog_file):
            if fld:
                try:
                    fld.delete(save=False)
                except Exception:
                    pass
        instance.delete()

    @action(detail=True, methods=['get'])
    def status(self, request, pk=None):
        """Poll processing status for a DroneDataset."""
        ds = self.get_object()
        ser = DroneDatasetSerializer(ds, context={'request': request})
        return Response({
            'id': ds.pk,
            'status': ds.status,
            'error': ds.error or None,
            'cog_url': ser.get_cog_url(ds),
            'potree_url': ser.get_potree_url(ds),
            'tiles_url': ser.get_tiles_url(ds),
            'point_cloud_meta': ds.point_cloud_meta,
            'bounds': {
                'west': ds.bounds_west, 'south': ds.bounds_south,
                'east': ds.bounds_east, 'north': ds.bounds_north,
            } if ds.bounds_west is not None else None,
        })

    # ── Resumable chunked upload ──────────────────────────────────────────────

    @action(detail=False, methods=['post'], url_path='upload/initiate',
            parser_classes=[parsers.JSONParser])
    def upload_initiate(self, request):
        """
        POST /api/core/drone-datasets/upload/initiate/
        Start a resumable upload session.

        Body JSON:
          name, description, data_type, filename, file_size,
          project (int|null), folder (int|null),
          chunk_size (int, default 10 MB)

        Returns:
          upload_id, chunk_size, total_chunks, expires_at
        """
        from django.utils import timezone as tz
        import math

        user = request.user
        data = request.data

        filename  = (data.get('filename') or '').strip()
        file_size = int(data.get('file_size') or 0)
        if not filename or file_size <= 0:
            return Response({'detail': 'filename and file_size are required.'}, status=400)

        chunk_size   = int(data.get('chunk_size') or DroneUploadSession.CHUNK_SIZE_DEFAULT)
        chunk_size   = max(1 * 1024 * 1024, min(chunk_size, 100 * 1024 * 1024))  # 1 MB – 100 MB
        total_chunks = math.ceil(file_size / chunk_size)

        org_id = getattr(user, 'organisation_id', None)
        session = DroneUploadSession.objects.create(
            original_filename=filename,
            total_size=file_size,
            chunk_size=chunk_size,
            total_chunks=total_chunks,
            name=data.get('name') or filename,
            description=data.get('description') or '',
            data_type=data.get('data_type') or DroneDataset.ORTHO_2D,
            organisation_id=org_id,
            project_id=data.get('project') or None,
            folder_id=data.get('folder') or None,
            uploaded_by=user,
            expires_at=tz.now() + tz.timedelta(hours=48),
        )
        return Response({
            'upload_id':    str(session.upload_id),
            'chunk_size':   chunk_size,
            'total_chunks': total_chunks,
            'expires_at':   session.expires_at.isoformat(),
        }, status=201)

    @action(detail=False, methods=['get', 'put'], url_path=r'upload/(?P<upload_id>[0-9a-f-]+)/chunk/(?P<chunk_index>\d+)',
            parser_classes=[parsers.MultiPartParser, parsers.FormParser])
    def upload_chunk(self, request, upload_id=None, chunk_index=None):
        """
        PUT /api/core/drone-datasets/upload/{upload_id}/chunk/{index}/
        Upload one chunk. Idempotent — re-uploading an existing chunk is safe.

        GET — returns received_chunks list (client uses this to find gaps).
        """
        try:
            session = DroneUploadSession.objects.get(upload_id=upload_id)
        except DroneUploadSession.DoesNotExist:
            return Response({'detail': 'Upload session not found.'}, status=404)

        if session.status not in (DroneUploadSession.UPLOADING,):
            return Response({'detail': f'Session is {session.status}.'}, status=409)

        if request.method == 'GET':
            return Response({
                'upload_id':       upload_id,
                'received_chunks': session.received_chunks,
                'total_chunks':    session.total_chunks,
                'progress_pct':    session.progress_pct,
                'missing_chunks':  session.missing_chunks,
            })

        chunk_idx = int(chunk_index)
        if chunk_idx < 0 or chunk_idx >= session.total_chunks:
            return Response({'detail': f'Chunk index {chunk_idx} out of range.'}, status=400)

        chunk_file = request.FILES.get('chunk')
        if not chunk_file:
            return Response({'detail': 'No chunk file in request.'}, status=400)

        # Write chunk to disk
        import os
        chunk_dir = session.chunk_dir()
        os.makedirs(chunk_dir, exist_ok=True)
        chunk_path = session.chunk_path(chunk_idx)
        with open(chunk_path, 'wb') as fh:
            for block in chunk_file.chunks(8192):
                fh.write(block)

        # Track receipt (idempotent)
        received = set(session.received_chunks)
        received.add(chunk_idx)
        session.received_chunks = sorted(received)
        session.save(update_fields=['received_chunks'])

        return Response({
            'chunk_index':     chunk_idx,
            'received_chunks': session.received_chunks,
            'total_chunks':    session.total_chunks,
            'progress_pct':    session.progress_pct,
        })

    @action(detail=False, methods=['post'], url_path=r'upload/(?P<upload_id>[0-9a-f-]+)/complete',
            parser_classes=[parsers.JSONParser])
    def upload_complete(self, request, upload_id=None):
        """
        POST /api/core/drone-datasets/upload/{upload_id}/complete/
        Assemble all chunks into the final file and trigger Celery processing.
        Returns {dataset_id} immediately; client polls dataset status.
        """
        try:
            session = DroneUploadSession.objects.get(upload_id=upload_id)
        except DroneUploadSession.DoesNotExist:
            return Response({'detail': 'Upload session not found.'}, status=404)

        if session.status != DroneUploadSession.UPLOADING:
            return Response({'detail': f'Session already in state: {session.status}.'}, status=409)

        missing = session.missing_chunks
        if missing:
            return Response({
                'detail': f'{len(missing)} chunks still missing.',
                'missing_chunks': missing[:20],
            }, status=422)

        # Hand off assembly to Celery
        session.status = DroneUploadSession.ASSEMBLING
        session.save(update_fields=['status'])
        from apps.core.tasks import assemble_drone_upload
        assemble_drone_upload.delay(str(session.upload_id))
        return Response({'upload_id': upload_id, 'status': 'ASSEMBLING'}, status=202)

    @action(detail=False, methods=['get'], url_path=r'upload/(?P<upload_id>[0-9a-f-]+)/session')
    def upload_session(self, request, upload_id=None):
        """GET session state — used by the frontend to resume interrupted uploads."""
        try:
            session = DroneUploadSession.objects.get(upload_id=upload_id)
        except DroneUploadSession.DoesNotExist:
            return Response({'detail': 'Session not found.'}, status=404)
        return Response({
            'upload_id':       str(session.upload_id),
            'status':          session.status,
            'total_chunks':    session.total_chunks,
            'chunk_size':      session.chunk_size,
            'received_chunks': session.received_chunks,
            'missing_chunks':  session.missing_chunks,
            'progress_pct':    session.progress_pct,
            'dataset_id':      session.dataset_id,
            'error':           session.error or None,
            'expires_at':      session.expires_at.isoformat(),
        })


class ElevationLookupView(APIView):
    """
    POST /api/core/elevation/
    Body:    {"locations": [{"lat": 12.97, "lon": 77.59}, ...]}
    Returns: {"results": [{"lat": ..., "lon": ..., "elevation": ...}]}

    Queries elevation directly from individual SRTM GeoTIFF tiles — no VRT merge,
    no internet required after initial download.  Avoids the GDAL integer overflow
    that occurs when ReadAsArray is called on a very large merged VRT
    (nSrcXSize=30000, nSrcYSize=36000 → overflow with 32-bit internal buffers).
    Each tile file is opened once and cached per worker process.
    """
    permission_classes = [permissions.IsAuthenticated]

    # Per-process tile cache: path_str -> (ds, gt, band, nodata) or None
    _tile_cache: dict = {}

    @classmethod
    def _srtm_dir(cls):
        from django.conf import settings
        from pathlib import Path
        data_dir = getattr(settings, 'DATA_DIR', None) or os.environ.get('DATA_DIR', '/data')
        return Path(data_dir) / 'terrain' / 'srtm_raw'

    @classmethod
    def _open_tile(cls, path_str: str):
        from osgeo import gdal
        if path_str not in cls._tile_cache:
            ds = gdal.Open(path_str)
            if ds is None:
                cls._tile_cache[path_str] = None
            else:
                band = ds.GetRasterBand(1)
                cls._tile_cache[path_str] = (ds, ds.GetGeoTransform(), band, band.GetNoDataValue())
        return cls._tile_cache[path_str]

    @classmethod
    def _sample(cls, lat: float, lon: float) -> float:
        srtm_dir = cls._srtm_dir()

        # CGIAR 5°×5° tile naming: srtm_CC_RR.tif
        # col 1 = -180°, each 5° wide eastward
        # row 1 = 60°N, each 5° tall going south
        col = int((lon + 180) / 5) + 1
        row = int((60 - lat) / 5) + 1
        primary = srtm_dir / f'srtm_{col:02d}_{row:02d}.tif'

        candidates = [primary] if primary.exists() else list(srtm_dir.glob('*.tif'))

        for path in candidates:
            if not path.exists():
                continue
            entry = cls._open_tile(str(path))
            if entry is None:
                continue
            ds, gt, band, nodata = entry
            x_min, x_res, _, y_max, _, y_res = gt   # y_res is negative
            x_max = x_min + x_res * ds.RasterXSize
            y_min = y_max + y_res * ds.RasterYSize

            if not (x_min <= lon < x_max and y_min <= lat < y_max):
                continue

            px = int((lon - x_min) / x_res)
            py = int((lat - y_max) / y_res)
            if not (0 <= px < ds.RasterXSize and 0 <= py < ds.RasterYSize):
                continue

            try:
                arr = band.ReadAsArray(px, py, 1, 1)
                if arr is not None:
                    v = float(arr[0][0])
                    if nodata is None or v != nodata:
                        return v
            except Exception:
                pass

        return 0.0

    def post(self, request):
        locations = request.data.get('locations', [])
        if not locations:
            return Response({'results': []})

        srtm_dir = self._srtm_dir()
        if not srtm_dir.exists() or not any(srtm_dir.glob('*.tif')):
            return Response(
                {'error': 'SRTM elevation data not available. '
                          'Run ./setup_terrain.sh --download first.'},
                status=503,
            )

        results = [
            {'lat': loc['lat'], 'lon': loc['lon'],
             'elevation': self._sample(float(loc['lat']), float(loc['lon']))}
            for loc in locations[:500]
        ]
        return Response({'results': results})


class TerrainConfigView(APIView):
    """Return terrain / Cesium configuration (read-only, authenticated)."""
    permission_classes = [permissions.IsAuthenticated]

    def get(self, request):
        from django.conf import settings
        ion_token = getattr(settings, 'CESIUM_ION_TOKEN', '')
        terrain_url = getattr(settings, 'TERRAIN_TILE_URL', '')

        # Local terrain takes priority over Ion (offline-first design).
        # When terrain-server is running with real tiles, analysis works
        # without internet. If local URL is set but server is unreachable,
        # the frontend falls back to Ion automatically.
        source = 'none'
        if terrain_url:
            source = 'local'
        elif ion_token:
            source = 'ion'

        return Response({
            'cesium_ion_token': ion_token,
            'terrain_tile_url': terrain_url or '/terrain-tiles',
            'terrain_source': source,  # 'none' | 'local' | 'ion'
        })


class TerrainExportGeoTIFFView(APIView):
    """
    POST /api/core/terrain/export-geotiff/

    Body: { elevGrid: float[], bbox: [minLon,minLat,maxLon,maxLat], gridN: int }

    Returns a 6-band Float32 GeoTIFF (WGS84 / EPSG:4326):
      Band 1 – Red   (smooth slope colour, hillshade-blended, 0-255)
      Band 2 – Green (smooth slope colour, hillshade-blended, 0-255)
      Band 3 – Blue  (smooth slope colour, hillshade-blended, 0-255)
      Band 4 – Elevation in metres (Float32)
      Band 5 – Slope in degrees   (Float32)
      Band 6 – Aspect in degrees  (Float32, 0=North clockwise, -1=flat)

    QGIS: Symbology → Multiband color, R=Band1 G=Band2 B=Band3, min=0 max=255.
    Band 4/5/6 carry the analysis data for raster calculations.
    Colour ramp: smooth gradient green→yellow→orange→red for 0→45°+ slope.
    """
    permission_classes = [permissions.IsAuthenticated]

    def post(self, request):
        import math, tempfile, os
        from django.http import HttpResponse as DjResponse

        try:
            from osgeo import gdal, osr
            import numpy as np
        except ImportError:
            return Response({'error': 'GDAL / numpy not available'}, status=503)

        elev_flat = request.data.get('elevGrid', [])
        bbox      = request.data.get('bbox', [])
        grid_n    = int(request.data.get('gridN', 15))

        if not elev_flat or len(elev_flat) != grid_n * grid_n or len(bbox) != 4:
            return Response({'error': 'Invalid grid data'}, status=400)

        min_lon, min_lat, max_lon, max_lat = [float(v) for v in bbox]

        elev_arr = np.array(elev_flat, dtype=np.float32).reshape(grid_n, grid_n)
        elev_arr = np.flipud(elev_arr)  # row 0 → northernmost (GeoTIFF convention)

        # ── Ground sample distances ───────────────────────────────────────────
        def _hav(lat1, lon1, lat2, lon2):
            R = 6_371_000
            dlat = math.radians(lat2 - lat1)
            dlon = math.radians(lon2 - lon1)
            a = math.sin(dlat/2)**2 + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlon/2)**2
            return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))

        dx = _hav(min_lat, min_lon, min_lat, max_lon) / max(grid_n - 1, 1)
        dy = _hav(min_lat, min_lon, max_lat, min_lon) / max(grid_n - 1, 1)

        # ── Slope from gradient (degrees) ─────────────────────────────────────
        grad_y, grad_x = np.gradient(elev_arr, dy, dx)
        slope_arr = np.degrees(np.arctan(np.sqrt(grad_x**2 + grad_y**2))).astype(np.float32)

        # ── Pure-numpy bilinear resize (no scipy needed) ──────────────────────
        def _bilinear_resize(arr, target_n):
            h, w = arr.shape
            y_out = np.linspace(0, h - 1, target_n)
            x_out = np.linspace(0, w - 1, target_n)
            y0 = np.floor(y_out).astype(int).clip(0, h - 2)
            x0 = np.floor(x_out).astype(int).clip(0, w - 2)
            y1 = (y0 + 1).clip(0, h - 1)
            x1 = (x0 + 1).clip(0, w - 1)
            dy_f = (y_out - y0)[:, None]
            dx_f = (x_out - x0)[None, :]
            return (arr[np.ix_(y0, x0)] * (1 - dy_f) * (1 - dx_f) +
                    arr[np.ix_(y0, x1)] * (1 - dy_f) * dx_f +
                    arr[np.ix_(y1, x0)] * dy_f * (1 - dx_f) +
                    arr[np.ix_(y1, x1)] * dy_f * dx_f).astype(arr.dtype)

        # Higher resolution for more detail: 1024 min or gridN × 20
        target_n = max(1024, grid_n * 20)
        elev_up  = _bilinear_resize(elev_arr,  target_n)
        slope_up = _bilinear_resize(slope_arr, target_n)

        # ── Smooth slope colour ramp ──────────────────────────────────────────
        # Interpolates between key (slope_deg, RGB) stops — no hard category edges
        def _slope_rgb_smooth(s):
            keys = [
                (0.0,  (82,  196,  26)),   # flat green
                (5.0,  (130, 210,  20)),
                (15.0, (250, 173,  20)),   # moderate amber
                (30.0, (250,  95,  15)),   # steep dark orange
                (45.0, (255,  50,  50)),   # very steep red
                (90.0, (160,   0,  30)),   # extreme
            ]
            r = np.zeros_like(s, dtype=np.float32)
            g = np.zeros_like(s, dtype=np.float32)
            b = np.zeros_like(s, dtype=np.float32)
            for i in range(len(keys) - 1):
                s0, c0 = keys[i]
                s1, c1 = keys[i + 1]
                mask = (s >= s0) & (s < s1)
                if not mask.any():
                    continue
                t = np.where(mask, (s - s0) / float(s1 - s0), 0.0)
                r += mask * (c0[0] + t * (c1[0] - c0[0]))
                g += mask * (c0[1] + t * (c1[1] - c0[1]))
                b += mask * (c0[2] + t * (c1[2] - c0[2]))
            last_s, last_c = keys[-1]
            cap = s >= last_s
            r += cap * last_c[0]
            g += cap * last_c[1]
            b += cap * last_c[2]
            return r, g, b

        # ── Hillshade: dual-light (NW primary + NE fill) ──────────────────────
        cell_m = dx / (target_n / max(grid_n, 1))
        gy_up, gx_up = np.gradient(elev_up, cell_m, cell_m)
        sl_up  = np.arctan(np.sqrt(gx_up**2 + gy_up**2))
        hs_asp = np.arctan2(-gy_up, gx_up)   # hillshade azimuth (math convention)
        alt    = np.radians(45)

        # Primary NW light (225° from east = standard cartographic NW)
        az_nw = np.radians(225)
        hs_nw = np.sin(alt) * np.cos(sl_up) + np.cos(alt) * np.sin(sl_up) * np.cos(az_nw - hs_asp)

        # Soft NE fill light to reduce dark shadow areas
        az_ne = np.radians(315)
        hs_ne = np.sin(alt) * np.cos(sl_up) + np.cos(alt) * np.sin(sl_up) * np.cos(az_ne - hs_asp)

        hs = np.clip(0.72 * hs_nw + 0.28 * hs_ne, 0.0, 1.0)

        r_col, g_col, b_col = _slope_rgb_smooth(slope_up)
        # Blend: 38% ambient + 62% hillshade modulated; gamma 0.88 for vivid output
        blend = (0.38 + 0.62 * hs) ** 0.88
        r_out = np.clip(r_col * blend, 0, 255).astype(np.float32)
        g_out = np.clip(g_col * blend, 0, 255).astype(np.float32)
        b_out = np.clip(b_col * blend, 0, 255).astype(np.float32)

        # ── Aspect (Band 6): GDAL convention 0=North, 90=East, clockwise ──────
        # atan2(east_grad, -north_grad) → [−180, 180] → normalise to [0, 360)
        asp_deg = np.degrees(np.arctan2(gx_up, -gy_up))
        asp_geo = np.where(asp_deg < 0, asp_deg + 360.0, asp_deg).astype(np.float32)
        flat_mask = (gx_up ** 2 + gy_up ** 2) < 1e-10
        asp_geo[flat_mask] = -1.0   # -1 = undefined (flat pixel)

        # ── Slope category percentages (metadata) ─────────────────────────────
        total_px = slope_arr.size
        def _pct(mask): return round(float(mask.sum()) / total_px * 100, 1)
        cat_flat     = _pct(slope_arr <  5)
        cat_gentle   = _pct((slope_arr >= 5)  & (slope_arr < 15))
        cat_moderate = _pct((slope_arr >= 15) & (slope_arr < 30))
        cat_steep    = _pct((slope_arr >= 30) & (slope_arr < 45))
        cat_vsteep   = _pct(slope_arr >= 45)

        # ── Write 6-band Float32 GeoTIFF ──────────────────────────────────────
        tmp = tempfile.mktemp(suffix='.tif')
        pixel_w = (max_lon - min_lon) / target_n
        pixel_h = (max_lat - min_lat) / target_n

        srs = osr.SpatialReference()
        srs.ImportFromEPSG(4326)

        tiff_drv = gdal.GetDriverByName('GTiff')
        out_ds = tiff_drv.Create(
            tmp, target_n, target_n, 6, gdal.GDT_Float32,
            options=['COMPRESS=LZW', 'TILED=YES', 'BLOCKXSIZE=256', 'BLOCKYSIZE=256'],
        )
        out_ds.SetGeoTransform([min_lon, pixel_w, 0, max_lat, 0, -pixel_h])
        out_ds.SetProjection(srs.ExportToWkt())

        band_defs = [
            (r_out,    'Red — smooth slope colour, hillshade-blended (0-255)',    gdal.GCI_RedBand),
            (g_out,    'Green — smooth slope colour, hillshade-blended (0-255)',  gdal.GCI_GreenBand),
            (b_out,    'Blue — smooth slope colour, hillshade-blended (0-255)',   gdal.GCI_BlueBand),
            (elev_up,  'Elevation (metres above mean sea level)',                  gdal.GCI_Undefined),
            (slope_up, 'Slope (degrees 0-90)',                                     gdal.GCI_Undefined),
            (asp_geo,  'Aspect (degrees 0-360, 0=North clockwise; -1=flat)',       gdal.GCI_Undefined),
        ]
        for idx, (data, desc, interp) in enumerate(band_defs, 1):
            b = out_ds.GetRasterBand(idx)
            b.WriteArray(data)
            b.SetDescription(desc)
            b.SetColorInterpretation(interp)
            if idx >= 4:
                b.SetNoDataValue(-9999)

        # Enhanced metadata
        out_ds.SetMetadataItem('ELEVATION_MIN_M',    f'{float(elev_arr.min()):.1f}')
        out_ds.SetMetadataItem('ELEVATION_MAX_M',    f'{float(elev_arr.max()):.1f}')
        out_ds.SetMetadataItem('ELEVATION_AVG_M',    f'{float(elev_arr.mean()):.1f}')
        out_ds.SetMetadataItem('ELEVATION_RELIEF_M', f'{float(elev_arr.max() - elev_arr.min()):.1f}')
        out_ds.SetMetadataItem('SLOPE_MIN_DEG',      f'{float(slope_arr.min()):.2f}')
        out_ds.SetMetadataItem('SLOPE_AVG_DEG',      f'{float(slope_arr.mean()):.2f}')
        out_ds.SetMetadataItem('SLOPE_MAX_DEG',      f'{float(slope_arr.max()):.2f}')
        out_ds.SetMetadataItem('BBOX_MIN_LON',        f'{min_lon:.6f}')
        out_ds.SetMetadataItem('BBOX_MIN_LAT',        f'{min_lat:.6f}')
        out_ds.SetMetadataItem('BBOX_MAX_LON',        f'{max_lon:.6f}')
        out_ds.SetMetadataItem('BBOX_MAX_LAT',        f'{max_lat:.6f}')
        out_ds.SetMetadataItem('GRID_SAMPLES',        f'{grid_n}x{grid_n}')
        out_ds.SetMetadataItem('OUTPUT_SIZE',         f'{target_n}x{target_n}')
        out_ds.SetMetadataItem('CRS',                 'EPSG:4326 WGS84')
        out_ds.SetMetadataItem('SLOPE_FLAT_PCT',      f'{cat_flat}%  (0-5 deg)')
        out_ds.SetMetadataItem('SLOPE_GENTLE_PCT',    f'{cat_gentle}%  (5-15 deg)')
        out_ds.SetMetadataItem('SLOPE_MODERATE_PCT',  f'{cat_moderate}%  (15-30 deg)')
        out_ds.SetMetadataItem('SLOPE_STEEP_PCT',     f'{cat_steep}%  (30-45 deg)')
        out_ds.SetMetadataItem('SLOPE_VSTEEP_PCT',    f'{cat_vsteep}%  (>=45 deg)')
        out_ds.SetMetadataItem('ASPECT_CONVENTION',
            'Band6: GDAL/ArcGIS convention. 0=North, 90=East, 180=South, 270=West. '
            '-1 = flat (no aspect). Clockwise from North.')
        out_ds.SetMetadataItem('RENDERING_HINT',
            'QGIS: Symbology > Multiband color, R=Band1 G=Band2 B=Band3, min=0 max=255. '
            'Band4=Elevation(m) Band5=Slope(deg) Band6=Aspect(deg,0=N). '
            'Colour: smooth gradient green(flat)->amber(moderate)->red(steep).')
        out_ds.FlushCache()
        out_ds = None

        with open(tmp, 'rb') as f:
            content = f.read()
        os.unlink(tmp)

        resp = DjResponse(content, content_type='image/tiff')
        resp['Content-Disposition'] = 'attachment; filename="terrain-analysis.tif"'
        return resp


class DEMAnalysisView(APIView):
    """
    POST /api/core/terrain/dem-analysis/

    Unified DEM analysis engine.  Body:
      { type: str, elevGrid: float[], bbox: [minLon,minLat,maxLon,maxLat], gridN: int, params: {} }

    Supported types:
      contours | aspect_map | curvature | viewshed | volume | cut_fill
      flood    | landslide  | watershed | cross_section
    """
    permission_classes = [permissions.IsAuthenticated]

    # ── shared helpers ────────────────────────────────────────────────────────

    @staticmethod
    def _setup(request):
        import math, numpy as np
        elev_flat = request.data.get('elevGrid', [])
        bbox      = request.data.get('bbox', [])
        grid_n    = int(request.data.get('gridN', 50))
        params    = request.data.get('params', {})

        if not elev_flat or len(elev_flat) != grid_n * grid_n or len(bbox) != 4:
            raise ValueError('Invalid grid data')

        min_lon, min_lat, max_lon, max_lat = [float(v) for v in bbox]
        elev_arr = np.array(elev_flat, dtype=np.float32).reshape(grid_n, grid_n)

        def _hav(la1, lo1, la2, lo2):
            R = 6_371_000
            a = math.sin(math.radians(la2-la1)/2)**2 + \
                math.cos(math.radians(la1))*math.cos(math.radians(la2))*math.sin(math.radians(lo2-lo1)/2)**2
            return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1-a))

        dx = _hav(min_lat, min_lon, min_lat, max_lon) / max(grid_n - 1, 1)
        dy = _hav(min_lat, min_lon, max_lat, min_lon) / max(grid_n - 1, 1)

        gy, gx      = np.gradient(elev_arr, dy, dx)
        slope_arr   = np.degrees(np.arctan(np.sqrt(gx**2 + gy**2))).astype(np.float32)
        asp_deg     = np.degrees(np.arctan2(gx, -gy))
        asp_arr     = np.where(asp_deg < 0, asp_deg + 360, asp_deg).astype(np.float32)

        return (elev_arr, slope_arr, asp_arr, gx, gy,
                dx, dy, min_lon, min_lat, max_lon, max_lat, grid_n, params)

    @staticmethod
    def _to_png_b64(rgba_arr):
        import io, base64
        from PIL import Image
        img = Image.fromarray(rgba_arr.astype('uint8'), 'RGBA')
        buf = io.BytesIO()
        img.save(buf, format='PNG')
        return 'data:image/png;base64,' + base64.b64encode(buf.getvalue()).decode()

    # ── analysis methods ──────────────────────────────────────────────────────

    def _contours(self, elev_arr, min_lon, min_lat, max_lon, max_lat, params):
        import json, numpy as np
        from osgeo import gdal, osr, ogr

        ny, nx  = elev_arr.shape
        relief  = float(elev_arr.max() - elev_arr.min())
        default_ivl = 1
        for nice in [1,2,5,10,20,25,50,100,200,500]:
            if relief / nice <= 20:
                default_ivl = nice; break
        interval     = float(params.get('interval', default_ivl))
        index_factor = int(params.get('index_factor', 5))

        elev_flip = np.flipud(elev_arr)
        pw = (max_lon - min_lon) / max(nx - 1, 1)
        ph = (max_lat - min_lat) / max(ny - 1, 1)

        mem_drv = gdal.GetDriverByName('MEM')
        rds = mem_drv.Create('', nx, ny, 1, gdal.GDT_Float32)
        rds.SetGeoTransform([min_lon - pw/2, pw, 0, max_lat + ph/2, 0, -ph])
        srs = osr.SpatialReference(); srs.ImportFromEPSG(4326)
        rds.SetProjection(srs.ExportToWkt())
        rds.GetRasterBand(1).WriteArray(elev_flip)

        ods  = ogr.GetDriverByName('Memory').CreateDataSource('c')
        olyr = ods.CreateLayer('c', srs, ogr.wkbLineString)
        olyr.CreateField(ogr.FieldDefn('ELEV', ogr.OFTReal))
        gdal.ContourGenerate(rds.GetRasterBand(1), interval, 0, [], 0, 0, olyr, -1,
                             olyr.GetLayerDefn().GetFieldIndex('ELEV'))

        features = []
        for feat in olyr:
            elv  = feat.GetField('ELEV')
            geom = feat.GetGeometryRef()
            if not geom: continue
            is_idx = int(round(elv / interval)) % index_factor == 0
            features.append({'type': 'Feature',
                'geometry': json.loads(geom.ExportToJson()),
                'properties': {'elevation': elv, 'label': f'{int(elv)} m',
                    'is_index': is_idx,
                    'color': '#ffd700' if is_idx else '#88ccff',
                    'width': 2.5 if is_idx else 1.2}})
        rds = None; ods = None

        return {'type': 'contours',
                'geojson': {'type': 'FeatureCollection', 'features': features},
                'stats': {'interval_m': interval, 'count': len(features),
                          'index_every': index_factor,
                          'min_elev_m': round(float(elev_arr.min()), 1),
                          'max_elev_m': round(float(elev_arr.max()), 1),
                          'relief_m': round(relief, 1)}}

    def _aspect_map(self, elev_arr, asp_arr, slope_arr, params):
        import numpy as np
        ny, nx = asp_arr.shape
        rgba = np.zeros((ny, nx, 4), dtype=np.uint8)

        # HSV-like colour wheel: 0°N=blue, 90°E=red, 180°S=yellow, 270°W=green
        hue   = asp_arr / 360.0
        h6    = hue * 6; hi = np.floor(h6).astype(int) % 6; f = h6 - np.floor(h6); q = 1 - f
        maps  = [(1,f,0),(q,1,0),(0,1,f),(0,q,1),(f,0,1),(1,0,q)]
        r = np.zeros((ny,nx)); g = np.zeros((ny,nx)); b = np.zeros((ny,nx))
        for i,(rv,gv,bv) in enumerate(maps):
            m = (hi == i)
            r[m] = (rv if np.isscalar(rv) else rv[m]) * 255
            g[m] = (gv if np.isscalar(gv) else gv[m]) * 255
            b[m] = (bv if np.isscalar(bv) else bv[m]) * 255

        rgba[:,:,0] = np.clip(r,0,255); rgba[:,:,1] = np.clip(g,0,255)
        rgba[:,:,2] = np.clip(b,0,255); rgba[:,:,3] = 200
        flat = slope_arr < 0.5
        rgba[flat] = [160,160,160,80]

        total = int((~flat).sum()) or 1
        def pct(m): return round(float(m.sum())/total*100, 1)
        A = asp_arr
        stats = {
            'N':  pct((A>=315)|(A<45)), 'NE': pct((A>=45)&(A<90)),
            'E':  pct((A>=90)&(A<135)),'SE': pct((A>=135)&(A<180)),
            'S':  pct((A>=180)&(A<225)),'SW': pct((A>=225)&(A<270)),
            'W':  pct((A>=270)&(A<315)),'NW': pct((A>=315)&(A<360)),
            'flat_pct': round(float(flat.sum())/flat.size*100,1),
        }
        dom = max(['N','NE','E','SE','S','SW','W','NW'], key=lambda k: stats[k])
        stats['dominant'] = dom

        return {'type': 'aspect_map', 'image': self._to_png_b64(rgba), 'stats': stats}

    def _curvature(self, elev_arr, dx, dy, params):
        import numpy as np
        ny, nx = elev_arr.shape

        # Second derivatives via central differences
        Dxx = np.zeros_like(elev_arr); Dyy = np.zeros_like(elev_arr); Dxy = np.zeros_like(elev_arr)
        Dxx[:,1:-1] = (elev_arr[:,:-2] - 2*elev_arr[:,1:-1] + elev_arr[:,2:]) / (dx**2)
        Dxx[:,0]=Dxx[:,1]; Dxx[:,-1]=Dxx[:,-2]
        Dyy[1:-1,:] = (elev_arr[:-2,:] - 2*elev_arr[1:-1,:] + elev_arr[2:,:]) / (dy**2)
        Dyy[0,:]=Dyy[1,:]; Dyy[-1,:]=Dyy[-2,:]
        Dxy[1:-1,1:-1] = (elev_arr[:-2,2:]-elev_arr[:-2,:-2]-elev_arr[2:,2:]+elev_arr[2:,:-2])/(4*dx*dy)
        Dxy[0,:]=Dxy[1,:]; Dxy[-1,:]=Dxy[-2,:]; Dxy[:,0]=Dxy[:,1]; Dxy[:,-1]=Dxy[:,-2]

        gy, gx = np.gradient(elev_arr, dy, dx)
        p2 = gx**2; q2 = gy**2; pq = p2 + q2 + 1e-12

        profile = -(Dxx*p2 + 2*Dxy*gx*gy + Dyy*q2) / (pq * np.sqrt(pq + 1))
        plan    = (Dxx*q2 - 2*Dxy*gx*gy + Dyy*p2) / pq
        total   = -(Dxx + Dyy)

        ctype = params.get('curvature_type', 'total')
        arr   = {'total': total, 'profile': profile, 'plan': plan}.get(ctype, total)

        # Diverge: blue=concave(+), white=flat(0), red=convex(-)
        mn = float(np.percentile(arr, 2)); mx = float(np.percentile(arr, 98))
        norm = np.clip((arr - mn) / max(mx - mn, 1e-6), 0, 1)
        rgba = np.zeros((ny, nx, 4), dtype=np.uint8)
        rgba[:,:,0] = np.clip(np.where(norm>=0.5, 255, norm*2*255), 0, 255).astype(np.uint8)
        rgba[:,:,1] = np.clip(255*(1-np.abs(norm-0.5)*2), 80, 255).astype(np.uint8)
        rgba[:,:,2] = np.clip(np.where(norm<=0.5, 255, (1-norm)*2*255), 0, 255).astype(np.uint8)
        rgba[:,:,3] = 200

        return {'type': 'curvature', 'image': self._to_png_b64(rgba),
                'stats': {'type': ctype,
                          'min': round(float(arr.min()),4), 'max': round(float(arr.max()),4),
                          'mean': round(float(arr.mean()),4),
                          'concave_pct': round(float((arr>0).sum())/arr.size*100, 1),
                          'convex_pct':  round(float((arr<0).sum())/arr.size*100, 1)}}

    def _viewshed(self, elev_arr, dx, dy, min_lon, min_lat, max_lon, max_lat, params):
        import numpy as np
        ny, nx = elev_arr.shape
        obs_lat = float(params.get('observer_lat', (min_lat+max_lat)/2))
        obs_lon = float(params.get('observer_lon', (min_lon+max_lon)/2))
        obs_h   = float(params.get('observer_height', 2.0))

        obs_xi = int(np.clip((obs_lon-min_lon)/(max_lon-min_lon)*(nx-1), 0, nx-1))
        obs_yi = int(np.clip((obs_lat-min_lat)/(max_lat-min_lat)*(ny-1), 0, ny-1))
        obs_e  = float(elev_arr[obs_yi, obs_xi]) + obs_h

        tgt_y = np.arange(ny)[:,None].repeat(nx,axis=1).astype(float)
        tgt_x = np.arange(nx)[None,:].repeat(ny,axis=0).astype(float)
        visible = np.ones((ny,nx), dtype=bool)

        for step in range(1, int(max(ny,nx)*1.5)+1):
            n_steps = np.maximum(np.abs(tgt_y-obs_yi), np.abs(tgt_x-obs_xi))
            frac    = np.where(n_steps>0, step/n_steps, 1.0)
            in_path = (frac>0.0) & (frac<1.0)
            if not in_path.any(): break

            sy = np.round(obs_yi + frac*(tgt_y-obs_yi)).astype(int).clip(0,ny-1)
            sx = np.round(obs_xi + frac*(tgt_x-obs_xi)).astype(int).clip(0,nx-1)

            terrain_h = elev_arr[sy, sx].astype(float)
            required  = obs_e + frac*(elev_arr.astype(float) - obs_e)
            visible  &= ~(in_path & (terrain_h > required + 0.5))

        rgba = np.zeros((ny,nx,4), dtype=np.uint8)
        rgba[visible]  = [80,210,100,180]
        rgba[~visible] = [210,70,50,140]
        rgba[obs_yi,obs_xi] = [255,255,0,255]

        vis_pct = round(float(visible.sum())/(ny*nx)*100, 1)
        return {'type': 'viewshed', 'image': self._to_png_b64(rgba),
                'stats': {'observer_lat': obs_lat, 'observer_lon': obs_lon,
                          'observer_height_m': obs_h,
                          'observer_elev_m': round(obs_e - obs_h, 1),
                          'visible_pct': vis_pct,
                          'not_visible_pct': round(100-vis_pct,1),
                          'visible_cells': int(visible.sum())}}

    def _volume(self, elev_arr, dx, dy, params):
        import numpy as np
        ref = float(params.get('reference_elevation', float(elev_arr.min())))
        cell_area = dx * dy
        diff = elev_arr.astype(float) - ref

        cut_vol  = float(diff[diff>0].sum()) * cell_area
        fill_vol = float((-diff[diff<0]).sum()) * cell_area
        cut_area  = float((diff>0).sum()) * cell_area
        fill_area = float((diff<0).sum()) * cell_area

        max_diff = float(np.abs(diff).max()) or 1.0
        rgba = np.zeros((*elev_arr.shape, 4), dtype=np.uint8)
        cut  = diff > 0; fill = diff < 0
        ic = np.clip(diff/max_diff, 0, 1); fi = np.clip(-diff/max_diff, 0, 1)
        rgba[cut,  0] = np.clip(180+75*ic[cut],  0,255).astype(np.uint8)
        rgba[cut,  1] = np.clip(100-70*ic[cut],  0,255).astype(np.uint8)
        rgba[cut,  3] = 190
        rgba[fill, 2] = np.clip(180+75*fi[fill], 0,255).astype(np.uint8)
        rgba[fill, 1] = np.clip(80+80*fi[fill],  0,255).astype(np.uint8)
        rgba[fill, 3] = 190
        rgba[diff==0] = [255,255,255,80]

        return {'type': 'volume', 'image': self._to_png_b64(rgba),
                'stats': {'reference_elevation_m': round(ref,1),
                          'cut_volume_m3':  round(cut_vol,1),
                          'fill_volume_m3': round(fill_vol,1),
                          'net_volume_m3':  round(cut_vol-fill_vol,1),
                          'cut_area_m2':    round(cut_area,1),
                          'fill_area_m2':   round(fill_area,1),
                          'cut_area_ha':    round(cut_area/10000,3),
                          'fill_area_ha':   round(fill_area/10000,3)}}

    def _flood(self, elev_arr, dx, dy, min_lon, min_lat, max_lon, max_lat, params):
        import numpy as np
        from collections import deque
        ny, nx = elev_arr.shape
        water_level = float(params.get('water_level', float(elev_arr.min())+5.0))

        # Seed point
        if params.get('seed_lat') is not None:
            sy = int(np.clip((float(params['seed_lat'])-min_lat)/(max_lat-min_lat)*(ny-1), 0, ny-1))
            sx = int(np.clip((float(params['seed_lon'])-min_lon)/(max_lon-min_lon)*(nx-1), 0, nx-1))
        else:
            idx = int(np.argmin(elev_arr)); sy, sx = idx//nx, idx%nx

        flooded = np.zeros((ny,nx), dtype=bool)
        if elev_arr[sy,sx] <= water_level:
            q = deque([(sy,sx)]); flooded[sy,sx] = True
            while q:
                y,x = q.popleft()
                for dy2,dx2 in [(-1,0),(1,0),(0,-1),(0,1)]:
                    ny2,nx2 = y+dy2, x+dx2
                    if 0<=ny2<ny and 0<=nx2<nx and not flooded[ny2,nx2]:
                        if elev_arr[ny2,nx2] <= water_level:
                            flooded[ny2,nx2]=True; q.append((ny2,nx2))

        depth    = np.where(flooded, water_level - elev_arr, 0).astype(np.float32)
        max_depth = float(depth.max()) or 1.0
        nd = depth/max_depth

        rgba = np.zeros((ny,nx,4), dtype=np.uint8)
        rgba[flooded, 0] = np.clip(20 +80*(1-nd[flooded]), 0,255).astype(np.uint8)
        rgba[flooded, 1] = np.clip(80 +80*(1-nd[flooded]), 0,255).astype(np.uint8)
        rgba[flooded, 2] = np.clip(180+75*(1-nd[flooded]), 0,255).astype(np.uint8)
        rgba[flooded, 3] = 210
        rgba[sy,sx] = [255,200,0,255]

        cell_area = dx*dy
        fa = float(flooded.sum())*cell_area
        return {'type': 'flood', 'image': self._to_png_b64(rgba),
                'stats': {'water_level_m': water_level,
                          'max_depth_m':    round(float(depth.max()),2),
                          'avg_depth_m':    round(float(depth[flooded].mean()) if flooded.any() else 0, 2),
                          'flooded_area_m2': round(fa,1),
                          'flooded_area_ha': round(fa/10000,2),
                          'flooded_pct':    round(float(flooded.sum())/(ny*nx)*100,1)}}

    def _landslide(self, elev_arr, slope_arr, dx, dy, params):
        import numpy as np
        ny, nx = elev_arr.shape

        Dxx = np.zeros_like(elev_arr); Dyy = np.zeros_like(elev_arr)
        Dxx[:,1:-1] = (elev_arr[:,:-2]-2*elev_arr[:,1:-1]+elev_arr[:,2:])/(dx**2)
        Dxx[:,0]=Dxx[:,1]; Dxx[:,-1]=Dxx[:,-2]
        Dyy[1:-1,:] = (elev_arr[:-2,:]-2*elev_arr[1:-1,:]+elev_arr[2:,:])/(dy**2)
        Dyy[0,:]=Dyy[1,:]; Dyy[-1,:]=Dyy[-2,:]
        lap = Dxx+Dyy
        lap_n = (lap-lap.min()) / max(float(lap.max()-lap.min()), 1e-6) * 100

        elev_n  = (elev_arr-elev_arr.min()) / max(float(elev_arr.max()-elev_arr.min()), 1) * 100
        s_score = np.clip(slope_arr/45.0*100, 0, 100)
        risk    = np.clip(0.65*s_score + 0.25*lap_n + 0.10*elev_n, 0, 100).astype(np.float32)

        norm = risk/100.0
        rgba = np.zeros((ny,nx,4), dtype=np.uint8)
        rgba[:,:,0] = np.clip(255*np.minimum(norm*2,1),    0,255).astype(np.uint8)
        rgba[:,:,1] = np.clip(255*(1-np.maximum(norm*2-1,0)),0,255).astype(np.uint8)
        rgba[:,:,2] = 0; rgba[:,:,3] = 200

        def pct(m): return round(float(m.sum())/risk.size*100,1)
        return {'type': 'landslide', 'image': self._to_png_b64(rgba),
                'stats': {'low_pct':      pct(risk<25),
                          'moderate_pct': pct((risk>=25)&(risk<50)),
                          'high_pct':     pct((risk>=50)&(risk<75)),
                          'very_high_pct':pct(risk>=75),
                          'avg_score':    round(float(risk.mean()),1),
                          'note': 'Model: slope 65% + curvature 25% + elevation 10%'}}

    def _watershed(self, elev_arr, dx, dy, min_lon, min_lat, max_lon, max_lat, params):
        import numpy as np
        ny, nx = elev_arr.shape

        # Pit fill
        filled = elev_arr.copy().astype(np.float64)
        for _ in range(40):
            pad = np.pad(filled, 1, mode='edge')
            nbr_min = np.minimum.reduce([pad[:-2,:-2],pad[:-2,1:-1],pad[:-2,2:],
                                         pad[1:-1,:-2],              pad[1:-1,2:],
                                         pad[2:,:-2], pad[2:,1:-1], pad[2:,2:]])
            pit = filled < nbr_min
            if not pit.any(): break
            filled[pit] = nbr_min[pit]+0.001

        # D8 flow direction
        ddy = [-1,-1,-1,0,0,1,1,1]
        ddx = [-1,0,1,-1,1,-1,0,1]
        dists = [1.414,1,1.414,1,1,1.414,1,1.414]
        drops = np.full((8,ny,nx),-np.inf)
        for i,(dy2,dx2,ds) in enumerate(zip(ddy,ddx,dists)):
            y0=max(0,-dy2); y1=ny+min(0,-dy2)
            x0=max(0,-dx2); x1=nx+min(0,-dx2)
            ny0=max(0,dy2);  ny1=ny+min(0,dy2)
            nx0=max(0,dx2);  nx1=nx+min(0,dx2)
            drops[i,y0:y1,x0:x1] = (filled[y0:y1,x0:x1]-filled[ny0:ny1,nx0:nx1])/ds

        flow_dir = np.argmax(drops,axis=0).astype(np.int8)
        flow_dir[drops.max(axis=0)<=0] = -1

        # Flow accumulation
        accum = np.ones((ny,nx), dtype=np.int32)
        for flat_idx in np.argsort(filled.ravel())[::-1]:
            y,x = int(flat_idx//nx), int(flat_idx%nx)
            d = int(flow_dir[y,x])
            if d<0: continue
            ny2,nx2 = y+ddy[d], x+ddx[d]
            if 0<=ny2<ny and 0<=nx2<nx:
                accum[ny2,nx2] += accum[y,x]

        # Pour point
        if params.get('pour_lat') is not None:
            py = int(np.clip((float(params['pour_lat'])-min_lat)/(max_lat-min_lat)*(ny-1),0,ny-1))
            px = int(np.clip((float(params['pour_lon'])-min_lon)/(max_lon-min_lon)*(nx-1),0,nx-1))
        else:
            fi = int(np.argmax(accum)); py,px = fi//nx, fi%nx

        # Upstream BFS
        reverse = {0:7,1:6,2:5,3:4,4:3,5:2,6:1,7:0}
        ws = np.zeros((ny,nx), dtype=bool); ws[py,px]=True
        q  = [(py,px)]
        while q:
            y,x = q.pop()
            for i,(dy2,dx2) in enumerate(zip(ddy,ddx)):
                ny2,nx2 = y+dy2, x+dx2
                if 0<=ny2<ny and 0<=nx2<nx and not ws[ny2,nx2]:
                    if int(flow_dir[ny2,nx2]) == reverse.get(i,-1):
                        ws[ny2,nx2]=True; q.append((ny2,nx2))

        rgba = np.zeros((ny,nx,4), dtype=np.uint8)
        rgba[ws]  = [100,180,255,100]
        thresh = int(np.percentile(accum[ws],85)) if ws.any() else 99999
        streams = ws & (accum>thresh)
        rgba[streams] = [20,80,220,230]
        rgba[py,px] = [255,50,50,255]

        cell_area = dx*dy; wsa = float(ws.sum())*cell_area
        return {'type': 'watershed', 'image': self._to_png_b64(rgba),
                'stats': {'area_m2':  round(wsa,1), 'area_ha': round(wsa/10000,2),
                          'area_km2': round(wsa/1e6,3),
                          'pour_lat': round(float(min_lat+py/(ny-1)*(max_lat-min_lat)),6),
                          'pour_lon': round(float(min_lon+px/(nx-1)*(max_lon-min_lon)),6)}}

    def _cross_section(self, elev_arr, dx, dy, min_lon, min_lat, max_lon, max_lat, params):
        import numpy as np, math
        ny, nx = elev_arr.shape
        transects = params.get('transects', [])
        if not transects:
            mid_lat = (min_lat+max_lat)/2; mid_lon = (min_lon+max_lon)/2
            transects = [
                {'start':{'lat':min_lat,'lon':mid_lon},'end':{'lat':max_lat,'lon':mid_lon},'label':'N–S'},
                {'start':{'lat':mid_lat,'lon':min_lon},'end':{'lat':mid_lat,'lon':max_lon},'label':'E–W'},
            ]
        n_pts = int(params.get('sample_count', 100))
        profiles = []
        for tr in transects:
            s,e = tr['start'], tr['end']
            lats = np.linspace(float(s['lat']),float(e['lat']),n_pts)
            lons = np.linspace(float(s['lon']),float(e['lon']),n_pts)
            rows = np.clip((lats-min_lat)/(max_lat-min_lat)*(ny-1),0,ny-1).astype(int)
            cols = np.clip((lons-min_lon)/(max_lon-min_lon)*(nx-1),0,nx-1).astype(int)
            elevs = elev_arr[rows, cols]
            dlat  = (float(e['lat'])-float(s['lat']))*111320
            dlon  = (float(e['lon'])-float(s['lon']))*111320*math.cos(math.radians(float(s['lat'])))
            total = float(math.sqrt(dlat**2+dlon**2))
            dists = np.linspace(0,total,n_pts)
            profiles.append({'label':tr.get('label',f'Section {len(profiles)+1}'),
                'length_m': round(total,1),
                'points':[{'dist':round(float(d),1),'elev':round(float(el),2),
                            'lat':round(float(la),6),'lon':round(float(lo),6)}
                           for d,el,la,lo in zip(dists,elevs,lats,lons)],
                'stats':{'min_m':round(float(elevs.min()),1),'max_m':round(float(elevs.max()),1),
                         'relief_m':round(float(elevs.max()-elevs.min()),1)}})
        return {'type':'cross_section','profiles':profiles,'stats':{'count':len(profiles)}}

    # ── dispatch ──────────────────────────────────────────────────────────────

    def post(self, request):
        analysis_type = request.data.get('type','')
        try:
            (elev_arr, slope_arr, asp_arr, gx, gy,
             dx, dy, min_lon, min_lat, max_lon, max_lat, grid_n, params) = self._setup(request)
        except ValueError as e:
            return Response({'error': str(e)}, status=400)

        dispatch = {
            'contours':     lambda: self._contours(elev_arr, min_lon, min_lat, max_lon, max_lat, params),
            'aspect_map':   lambda: self._aspect_map(elev_arr, asp_arr, slope_arr, params),
            'curvature':    lambda: self._curvature(elev_arr, dx, dy, params),
            'viewshed':     lambda: self._viewshed(elev_arr, dx, dy, min_lon, min_lat, max_lon, max_lat, params),
            'volume':       lambda: self._volume(elev_arr, dx, dy, params),
            'cut_fill':     lambda: self._volume(elev_arr, dx, dy, params),
            'flood':        lambda: self._flood(elev_arr, dx, dy, min_lon, min_lat, max_lon, max_lat, params),
            'landslide':    lambda: self._landslide(elev_arr, slope_arr, dx, dy, params),
            'watershed':    lambda: self._watershed(elev_arr, dx, dy, min_lon, min_lat, max_lon, max_lat, params),
            'cross_section':lambda: self._cross_section(elev_arr, dx, dy, min_lon, min_lat, max_lon, max_lat, params),
        }
        fn = dispatch.get(analysis_type)
        if not fn:
            return Response({'error': f'Unknown type: {analysis_type}'}, status=400)

        try:
            result = fn()
        except Exception as exc:
            import traceback
            return Response({'error': str(exc), 'trace': traceback.format_exc()}, status=500)

        result['bbox'] = [min_lon, min_lat, max_lon, max_lat]
        return Response(result)


# Mapnik export endpoints
from django.http import HttpResponse, JsonResponse
from rest_framework.decorators import api_view, permission_classes
import logging
import math
import os
import re
import subprocess
import tempfile

logger = logging.getLogger(__name__)


def _png_to_geotiff(png_bytes: bytes, ul_x: float, ul_y: float,
                    lr_x: float, lr_y: float) -> bytes | None:
    """
    Convert raw PNG bytes to a georeferenced GeoTIFF (EPSG:3857) using
    gdal_translate (installed via gdal-bin in the Docker image).

    ul_x/ul_y are the OUTER EDGE of the upper-left pixel.
    lr_x/lr_y are the OUTER EDGE of the lower-right pixel.
    (These are the 'a_ullr' values — not pixel-centre values like a .pgw file.)

    Returns GeoTIFF bytes on success, None on failure (caller falls back to PNG).
    """
    tmp_in = tmp_out = None
    try:
        with tempfile.NamedTemporaryFile(suffix='.png', delete=False) as f:
            f.write(png_bytes)
            tmp_in = f.name
        tmp_out = tmp_in[:-4] + '.tif'

        result = subprocess.run(
            [
                'gdal_translate',
                '-of', 'GTiff',
                '-a_srs', 'EPSG:3857',
                '-a_ullr',
                f'{ul_x:.6f}', f'{ul_y:.6f}',
                f'{lr_x:.6f}', f'{lr_y:.6f}',
                '-co', 'COMPRESS=DEFLATE',
                '-co', 'PREDICTOR=2',
                '-co', 'TILED=YES',
                tmp_in, tmp_out,
            ],
            capture_output=True,
            timeout=60,
        )
        if result.returncode != 0:
            logger.error('gdal_translate failed: %s',
                         result.stderr.decode('utf-8', errors='ignore')[:400])
            return None
        with open(tmp_out, 'rb') as f:
            return f.read()
    except Exception as exc:
        logger.error('GeoTIFF creation failed: %s', exc)
        return None
    finally:
        for path in (tmp_in, tmp_out):
            if path and os.path.exists(path):
                try:
                    os.remove(path)
                except OSError:
                    pass


@api_view(['POST'])
@permission_classes([permissions.IsAuthenticated])
def export_map(request):
    """
    Render map to GeoTIFF using Mapnik (server-side vector) + gdal_translate.
    The output is a single EPSG:3857 GeoTIFF — no sidecar world files needed.
    """
    import time
    from django.conf import settings
    from apps.core.watermark import embed_watermark

    data = request.data
    try:
        width = int(data.get('width', 1200))
        height = int(data.get('height', 800))
        zoom = float(data.get('zoom', 10))
        center_lon = float(data.get('center_lon', 78.0))
        center_lat = float(data.get('center_lat', 20.0))
        style = str(data.get('style', 'boundaries'))
    except (ValueError, TypeError) as exc:
        return JsonResponse({'error': 'Invalid parameters', 'detail': str(exc)}, status=400)

    # ── Render PNG via Mapnik ──────────────────────────────────────────────────
    cmd = [
        '/usr/bin/python3',
        'apps/core/render_mapnik.py',
        '--style', style,
        '--width', str(width), '--height', str(height),
        '--zoom', str(zoom),
        '--center-lon', str(center_lon), '--center-lat', str(center_lat),
        '--format', 'png',
    ]
    try:
        result = subprocess.run(cmd, env=os.environ.copy(),
                                capture_output=True, check=True)
        png_bytes = result.stdout
    except subprocess.CalledProcessError as exc:
        stderr_msg = exc.stderr.decode('utf-8', errors='ignore')
        logger.error('Mapnik rendering subprocess failed: %s', stderr_msg)
        return JsonResponse({
            'error': 'Mapnik rendering failed',
            'detail': stderr_msg.strip() or 'Unknown error in rendering subprocess.',
        }, status=500)

    # ── Compute EPSG:3857 bounding box (outer pixel edges for gdal_translate) ──
    # Replicates the projection used by render_mapnik.py so the bbox matches
    # exactly what Mapnik rendered.
    circumference = 2.0 * math.pi * 6_378_137.0
    resolution = circumference / (256.0 * (2.0 ** zoom))   # metres/pixel

    # Project centre to Web Mercator
    lon_rad = math.radians(center_lon)
    lat_rad = math.radians(center_lat)
    cx = 6_378_137.0 * lon_rad
    cy = 6_378_137.0 * math.log(math.tan(math.pi / 4.0 + lat_rad / 2.0))

    half_w = width  * resolution / 2.0
    half_h = height * resolution / 2.0

    ul_x = cx - half_w
    ul_y = cy + half_h
    lr_x = cx + half_w
    lr_y = cy - half_h

    # ── Convert to GeoTIFF ────────────────────────────────────────────────────
    ts = int(time.time())
    geotiff_bytes = _png_to_geotiff(png_bytes, ul_x, ul_y, lr_x, lr_y)

    if geotiff_bytes:
        filename = f'rakshagis_map_{style}_{ts}.tif'
        metadata = {
            'uploaded_by': request.user.username,
            'export_format': 'tif',
            'style': style, 'zoom': zoom,
            'center_lon': center_lon, 'center_lat': center_lat,
        }
        try:
            # GeoTIFF tail-comment watermark (safe append; GDAL ignores trailing bytes)
            from apps.core.watermark import embed_watermark
            output_bytes = embed_watermark(geotiff_bytes, filename, 'image/tiff', metadata)
        except Exception as wexc:
            logger.error('Failed to watermark GeoTIFF: %s', wexc)
            output_bytes = geotiff_bytes

        response = HttpResponse(output_bytes, content_type='image/tiff')
        response['Content-Disposition'] = f'attachment; filename="{filename}"'
        return response

    # Fallback: return PNG (georeferencing will be incomplete)
    logger.warning('GeoTIFF conversion failed — returning plain PNG for Mapnik export')
    filename = f'rakshagis_map_{style}_{ts}.png'
    try:
        output_bytes = embed_watermark(png_bytes, filename, 'image/png',
                                       {'uploaded_by': request.user.username,
                                        'export_format': 'png', 'style': style})
    except Exception:
        output_bytes = png_bytes
    response = HttpResponse(output_bytes, content_type='image/png')
    response['Content-Disposition'] = f'attachment; filename="{filename}"'
    return response



@api_view(['GET'])
@permission_classes([permissions.IsAuthenticated])
def map_styles(request):
    """List available map styles"""
    try:
        import os
        from django.conf import settings

        styles_dir = os.path.join(
            settings.BASE_DIR, 'services', 'mapnik', 'styles'
        )

        if not os.path.exists(styles_dir):
            return JsonResponse({'styles': []})

        # List all .xml files
        styles = [
            f[:-4]  # Remove .xml extension
            for f in os.listdir(styles_dir)
            if f.endswith('.xml')
        ]

        return JsonResponse({
            'styles': sorted(styles),
            'count': len(styles)
        })

    except Exception as e:
        logger.error(f"Failed to list styles: {str(e)}")
        return JsonResponse({
            'error': 'Failed to list styles',
            'detail': str(e)
        }, status=500)


# ── Playwright PDF print service ─────────────────────────────────────────────

PRINT_SERVICE_URL = 'http://print-service:3001/render'


@api_view(['POST'])
@permission_classes([permissions.IsAuthenticated])
def print_pdf(request):
    """
    POST /api/core/print-pdf/

    Accepts JSON with map_image_b64 + layout params, generates an
    ArcGIS-style HTML layout, and delegates PDF rendering to the
    Playwright print-service container.

    Required fields:
        map_image_b64   Base64-encoded PNG of the current map canvas
        title           Map title string

    Optional fields:
        subtitle, org_name, paper_size, orientation,
        show_legend, show_north, show_scale, show_coords, show_attrib,
        legend [{name, color, type}],
        extent  {sw_lat, sw_lon, ne_lat, ne_lon},
        scale_denominator  (integer, e.g. 50000 for 1:50 000)
    """
    try:
        from .print_html import generate_arcgis_print_html, PAPER_SIZES
        import httpx

        data = request.data

        layer_images = data.get('layer_images', [])
        # Strip data-URL prefixes for layer_images if present
        for img in layer_images:
            b64 = img.get('image_b64', '')
            if b64 and ',' in b64:
                img['image_b64'] = b64.split(',', 1)[1]

        # If not provided, fallback to old fields
        if not layer_images:
            basemap_b64 = data.get('basemap_image_b64', '')
            features_b64 = data.get('features_image_b64', '')
            map_b64 = data.get('map_image_b64', '')
            
            if basemap_b64:
                if ',' in basemap_b64:
                    basemap_b64 = basemap_b64.split(',', 1)[1]
                layer_images.append({'name': 'Base Map', 'image_b64': basemap_b64})
            if features_b64:
                if ',' in features_b64:
                    features_b64 = features_b64.split(',', 1)[1]
                layer_images.append({'name': 'Spatial Features', 'image_b64': features_b64})
            if not layer_images and map_b64:
                if ',' in map_b64:
                    map_b64 = map_b64.split(',', 1)[1]
                layer_images.append({'name': 'Spatial Features', 'image_b64': map_b64})

        if not layer_images:
            return JsonResponse({'error': 'layer_images or map_image_b64/split layer images are required'}, status=400)

        paper_size  = data.get('paper_size', 'A4')
        orientation = data.get('orientation', 'landscape')

        if paper_size not in PAPER_SIZES:
            paper_size = 'A4'
        if orientation not in ('portrait', 'landscape'):
            orientation = 'landscape'

        export_attributes = bool(data.get('export_attributes', False))
        features = list(data.get('features', []))

        html = generate_arcgis_print_html(
            layer_images     = layer_images,
            title            = str(data.get('title', 'Map')),
            subtitle         = str(data.get('subtitle', '')),
            org_name         = str(data.get('org_name', '')),
            paper_size       = paper_size,
            orientation      = orientation,
            legend           = list(data.get('legend', [])),
            show_legend      = bool(data.get('show_legend', True)),
            show_north       = bool(data.get('show_north', True)),
            show_scale       = bool(data.get('show_scale', True)),
            show_coords      = bool(data.get('show_coords', True)),
            show_attrib      = bool(data.get('show_attrib', True)),
            extent           = data.get('extent'),
            scale_denominator= int(data.get('scale_denominator', 0)),
            export_attributes= export_attributes,
            features         = features,
        )

        # Always render at scale 1.0 — CSS layout must fit the @page exactly.
        # Higher DPI quality comes from the frontend sending a higher-resolution
        # map image (3× canvas capture for 300 DPI), not from Playwright scaling.
        # Call the Playwright print service
        try:
            pw_response = httpx.post(
                PRINT_SERVICE_URL,
                json={
                    'html':        html,
                    'paper_size':  paper_size,
                    'orientation': orientation,
                    'scale':       1.0,
                },
                timeout=120,
            )
            pw_response.raise_for_status()
        except httpx.ConnectError:
            return JsonResponse({
                'error': 'Print service unavailable',
                'detail': 'The Playwright print-service is not running. '
                          'Start it with: docker compose up -d print-service',
            }, status=503)
        except httpx.HTTPStatusError as exc:
            return JsonResponse({
                'error': 'Print service error',
                'detail': exc.response.text[:300],
            }, status=502)

        safe_title = ''.join(c if c.isalnum() or c in '-_ ' else '_' for c in str(data.get('title', 'map')))
        filename   = f"{safe_title.strip().replace(' ', '_')}_{paper_size}_{orientation}.pdf"

        from django.http import HttpResponse
        from apps.core.watermark import embed_watermark
        
        layers = data.get('layers')
        if not layers:
            layers = [img['name'] for img in layer_images]
            
        metadata = {
            "uploaded_by": request.user.username,
            "export_format": "pdf",
            "paper_size": paper_size,
            "orientation": orientation,
            "layers": layers,
        }

        try:
            pdf_bytes = embed_watermark(pw_response.content, filename, 'application/pdf', metadata)
        except Exception as wexc:
            logger.error(f"Failed to embed watermark in printed PDF: {wexc}")
            pdf_bytes = pw_response.content

        response = HttpResponse(pdf_bytes, content_type='application/pdf')
        response['Content-Disposition'] = f'attachment; filename="{filename}"'
        response['Cache-Control'] = 'no-store'

        logger.info(
            f"PDF printed by {request.user.username}: "
            f"{paper_size} {orientation} scale=1:{data.get('scale_denominator', '?')}"
        )
        return response

    except Exception as exc:
        logger.exception('print_pdf error')
        return JsonResponse({'error': 'Print failed', 'detail': str(exc)}, status=500)


@api_view(['POST'])
@permission_classes([permissions.IsAuthenticated])
def watermark_file(request):
    """
    POST /api/core/watermark-file/
    Receives any file and applies the LP-DNA/C2PA watermark.

    For georeferenced PNG exports (WYSIWYG canvas capture), the caller may
    supply the EPSG:3857 bounding box via POST fields:
        ul_x, ul_y  — outer edge of the upper-left pixel  (metres)
        lr_x, lr_y  — outer edge of the lower-right pixel (metres)
    When all four values are present the PNG is converted to a GeoTIFF with the
    CRS and geotransform embedded — no sidecar files needed in QGIS/ArcGIS.
    """
    import json
    from apps.core.watermark import embed_watermark

    uploaded_file = request.FILES.get('file')
    if not uploaded_file:
        return JsonResponse({'error': 'No file uploaded'}, status=400)

    filename = uploaded_file.name or 'export_file'
    mime_type = uploaded_file.content_type

    # Parse optional georeferencing bbox
    geotiff_bbox = None
    try:
        ul_x = request.POST.get('ul_x')
        ul_y = request.POST.get('ul_y')
        lr_x = request.POST.get('lr_x')
        lr_y = request.POST.get('lr_y')
        if all(v is not None for v in (ul_x, ul_y, lr_x, lr_y)):
            geotiff_bbox = (float(ul_x), float(ul_y), float(lr_x), float(lr_y))
    except (TypeError, ValueError):
        pass

    try:
        metadata = {
            'uploaded_by': request.user.username,
            'export_format': filename.split('.')[-1].lower() if '.' in filename else 'bin',
            'source': 'RakshaGIS/DEMAP',
            'client_exported': True,
        }
        layers_raw = request.POST.get('layers')
        if layers_raw:
            try:
                metadata['layers'] = json.loads(layers_raw)
            except Exception:
                pass

        file_bytes = uploaded_file.read()

        # ── GeoTIFF path: PNG canvas capture with known extent ────────────────
        if geotiff_bbox and filename.lower().endswith('.png'):
            ul_x, ul_y, lr_x, lr_y = geotiff_bbox
            tif_bytes = _png_to_geotiff(file_bytes, ul_x, ul_y, lr_x, lr_y)
            if tif_bytes:
                tif_filename = filename[:-4] + '.tif'
                metadata['export_format'] = 'tif'
                try:
                    output_bytes = embed_watermark(tif_bytes, tif_filename, 'image/tiff', metadata)
                except Exception:
                    output_bytes = tif_bytes
                response = HttpResponse(output_bytes, content_type='image/tiff')
                response['Content-Disposition'] = f'attachment; filename="{tif_filename}"'
                response['Cache-Control'] = 'no-store'
                return response
            logger.warning('GeoTIFF conversion failed — falling through to plain PNG watermark')

        # ── Standard watermark path (all other formats) ───────────────────────
        watermarked_bytes = embed_watermark(file_bytes, filename, mime_type, metadata)
        response = HttpResponse(watermarked_bytes, content_type=mime_type)
        response['Content-Disposition'] = f'attachment; filename="{filename}"'
        response['Cache-Control'] = 'no-store'
        return response

    except Exception as exc:
        logger.exception('Failed to watermark client-exported file')
        return JsonResponse({'error': 'Watermarking failed', 'detail': str(exc)}, status=500)


# ── Async data-export endpoints ───────────────────────────────────────────────

def _max_concurrent_org():
    from django.conf import settings as _s
    return getattr(_s, 'EXPORT_MAX_CONCURRENT_PER_ORG', 3)

def _max_concurrent_user():
    from django.conf import settings as _s
    return getattr(_s, 'EXPORT_MAX_CONCURRENT_PER_USER', 2)


@api_view(['POST'])
@permission_classes([permissions.IsAuthenticated])
def start_export(request):
    """
    POST /api/core/export/start/
    Body: { export_type: 'survey_area'|'project', object_id: <int> }

    Creates an ExportTask and queues the Celery worker.
    Enforces per-user and per-org concurrency limits.
    Returns: { task_uuid, status, message }
    """
    from apps.core.models import ExportTask
    from apps.core.tasks import build_export_zip

    export_type = request.data.get('export_type', '')
    object_id   = request.data.get('object_id')

    if export_type not in (ExportTask.SURVEY_AREA, ExportTask.PROJECT):
        return JsonResponse({'error': 'Invalid export_type'}, status=400)
    try:
        object_id = int(object_id)
    except (TypeError, ValueError):
        return JsonResponse({'error': 'object_id must be an integer'}, status=400)

    user = request.user
    org_id = getattr(user, 'organisation_id', None)

    # ── Concurrency guards ────────────────────────────────────────────────────
    active_statuses = (ExportTask.PENDING, ExportTask.RUNNING)

    user_active = ExportTask.objects.filter(
        requested_by=user, status__in=active_statuses
    ).count()
    if user_active >= _max_concurrent_user():
        return JsonResponse({
            'error': 'Too many active exports',
            'detail': f'You already have {user_active} export(s) in progress. '
                      f'Wait for them to finish before starting another.',
        }, status=429)

    if org_id:
        org_active = ExportTask.objects.filter(
            organisation_id=org_id, status__in=active_statuses
        ).count()
        if org_active >= _max_concurrent_org():
            return JsonResponse({
                'error': 'Office export limit reached',
                'detail': f'Your office has {org_active} export(s) running. '
                          f'Please wait for them to complete.',
            }, status=429)

    # ── Resolve a human-readable name for the task ────────────────────────────
    object_name = ''
    try:
        if export_type == ExportTask.SURVEY_AREA:
            from apps.survey_projects.models import SurveyArea
            object_name = SurveyArea.objects.values_list('name', flat=True).get(pk=object_id)
        else:
            from apps.survey_projects.models import SurveyProject
            object_name = SurveyProject.objects.values_list('project_number', flat=True).get(pk=object_id)
    except Exception:
        object_name = str(object_id)

    et = ExportTask.objects.create(
        export_type=export_type,
        object_id=object_id,
        object_name=object_name,
        requested_by=user,
        organisation_id=org_id,
        progress_msg='Queued — waiting for worker…',
    )
    build_export_zip.delay(et.pk)

    return JsonResponse({
        'task_uuid': str(et.task_uuid),
        'status': et.status,
        'message': 'Export queued. Poll /api/core/export/status/{task_uuid}/ for progress.',
    }, status=202)


@api_view(['GET'])
@permission_classes([permissions.IsAuthenticated])
def export_status(request, task_uuid):
    """
    GET /api/core/export/status/{task_uuid}/

    Returns the current state of an ExportTask.
    Only the requesting user (or a superadmin) can see the task.
    """
    from apps.core.models import ExportTask

    try:
        et = ExportTask.objects.get(task_uuid=task_uuid)
    except ExportTask.DoesNotExist:
        return JsonResponse({'error': 'Task not found'}, status=404)

    user = request.user
    if not (user.is_superadmin or et.requested_by_id == user.pk):
        return JsonResponse({'error': 'Forbidden'}, status=403)

    return JsonResponse({
        'task_uuid': str(et.task_uuid),
        'export_type': et.export_type,
        'object_id': et.object_id,
        'object_name': et.object_name,
        'status': et.status,
        'progress_msg': et.progress_msg,
        'file_size': et.file_size,
        'error': et.error or None,
        'expires_at': et.expires_at.isoformat() if et.expires_at else None,
    })


@api_view(['GET'])
@permission_classes([permissions.IsAuthenticated])
def export_download(request, task_uuid):
    """
    GET /api/core/export/download/{task_uuid}/

    Stream the completed ZIP to the client.
    Extends expiry by 30 min after each download (so multiple downloads work).
    """
    from django.conf import settings as _settings
    from django.utils import timezone
    from apps.core.models import ExportTask

    try:
        et = ExportTask.objects.get(task_uuid=task_uuid)
    except ExportTask.DoesNotExist:
        return JsonResponse({'error': 'Task not found'}, status=404)

    user = request.user
    if not (user.is_superadmin or et.requested_by_id == user.pk):
        return JsonResponse({'error': 'Forbidden'}, status=403)

    if et.status != ExportTask.DONE:
        return JsonResponse({'error': 'Export not ready', 'status': et.status}, status=409)

    if not et.result_path:
        return JsonResponse({'error': 'Export file path missing'}, status=500)

    full_path = os.path.join(_settings.MEDIA_ROOT, et.result_path)
    if not os.path.exists(full_path):
        # Mark as failed so the frontend stops polling
        ExportTask.objects.filter(pk=et.pk).update(
            status=ExportTask.FAILED,
            error='Export file not found on disk — the worker may have failed silently.',
        )
        return JsonResponse({'error': 'Export file missing — the worker may have failed. Please retry.'}, status=410)

    # Extend expiry so the file survives re-downloads
    ExportTask.objects.filter(pk=et.pk).update(
        expires_at=timezone.now() + timezone.timedelta(minutes=30)
    )

    safe_name = re.sub(r'[^\w\-]', '_', et.object_name or 'export')[:60]
    filename = f"{safe_name}_export.zip"

    try:
        fh = open(full_path, 'rb')
    except OSError as exc:
        logger.error("export_download: cannot open %s: %s", full_path, exc)
        return JsonResponse({'error': 'Failed to open export file'}, status=500)

    response = HttpResponse(fh, content_type='application/zip')
    response['Content-Disposition'] = f'attachment; filename="{filename}"'
    if et.file_size:
        response['Content-Length'] = et.file_size
    response['Cache-Control'] = 'no-store'
    return response

