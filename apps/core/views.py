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

        # Cap must cover a full 50×50 slope-analysis grid (2500 points) — a
        # lower cap returns a short array and the slope endpoints reject it
        # with "Invalid grid data".
        results = [
            {'lat': loc['lat'], 'lon': loc['lon'],
             'elevation': self._sample(float(loc['lat']), float(loc['lon']))}
            for loc in locations[:5000]
        ]
        return Response({'results': results})


class TerrainConfigView(APIView):
    """Return terrain / Cesium configuration (read-only, authenticated)."""
    permission_classes = [permissions.IsAuthenticated]

    def get(self, request):
        from django.conf import settings
        raw_token   = getattr(settings, 'CESIUM_ION_TOKEN', '') or ''
        terrain_url = getattr(settings, 'TERRAIN_TILE_URL', '') or ''

        # Treat obvious placeholder values as "no token" so the frontend
        # doesn't accidentally fall back to Cesium Ion with an invalid key
        # and surface a 401 / "InvalidCredentials" error.
        _PLACEHOLDERS = ('YOUR_TOKEN_HERE', 'your_token_here', 'changeme', 'REPLACE_ME', '')
        ion_token = '' if raw_token.strip() in _PLACEHOLDERS else raw_token.strip()

        # Local terrain takes priority over Ion (offline-first design).
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

        # ── Write GeoTIFF (ZIP bundle: visualization + analysis) ─────────────
        # GDT_Float32 with 0-255 values shows as checkerboard in standard viewers.
        # Fix: write two separate GeoTIFFs with correct types:
        #   terrain-visualization.tif — 3-band GDT_Byte PHOTOMETRIC=RGB  (opens anywhere)
        #   terrain-analysis.tif      — 3-band GDT_Float32 elevation/slope/aspect
        tmp_vis = tempfile.mktemp(suffix='.tif')
        tmp_ana = tempfile.mktemp(suffix='.tif')
        pixel_w = (max_lon - min_lon) / target_n
        pixel_h = (max_lat - min_lat) / target_n

        srs = osr.SpatialReference()
        srs.ImportFromEPSG(4326)
        geo_transform = [min_lon, pixel_w, 0, max_lat, 0, -pixel_h]
        tiff_drv = gdal.GetDriverByName('GTiff')

        # ── 3-band Byte RGB visualization ────────────────────────────────────
        vis_ds = tiff_drv.Create(
            tmp_vis, target_n, target_n, 3, gdal.GDT_Byte,
            options=['COMPRESS=LZW', 'TILED=YES', 'BLOCKXSIZE=256', 'BLOCKYSIZE=256',
                     'PHOTOMETRIC=RGB'],
        )
        vis_ds.SetGeoTransform(geo_transform)
        vis_ds.SetProjection(srs.ExportToWkt())
        for bidx, (arr, desc, ci) in enumerate([
            (np.clip(r_out, 0, 255).astype(np.uint8), 'Red',   gdal.GCI_RedBand),
            (np.clip(g_out, 0, 255).astype(np.uint8), 'Green', gdal.GCI_GreenBand),
            (np.clip(b_out, 0, 255).astype(np.uint8), 'Blue',  gdal.GCI_BlueBand),
        ], 1):
            vb = vis_ds.GetRasterBand(bidx)
            vb.WriteArray(arr)
            vb.SetDescription(desc)
            vb.SetColorInterpretation(ci)

        # ── 3-band Float32 analysis (elevation / slope / aspect) ─────────────
        ana_ds = tiff_drv.Create(
            tmp_ana, target_n, target_n, 3, gdal.GDT_Float32,
            options=['COMPRESS=LZW', 'TILED=YES', 'BLOCKXSIZE=256', 'BLOCKYSIZE=256'],
        )
        ana_ds.SetGeoTransform(geo_transform)
        ana_ds.SetProjection(srs.ExportToWkt())
        for bidx, (arr, desc) in enumerate([
            (elev_up,  'Elevation_m'),
            (slope_up, 'Slope_deg'),
            (asp_geo,  'Aspect_deg_0N'),
        ], 1):
            ab = ana_ds.GetRasterBand(bidx)
            ab.WriteArray(arr.astype(np.float32))
            ab.SetDescription(desc)
            ab.SetNoDataValue(-9999)
            # Embed statistics so QGIS/ArcGIS auto-stretch instead of showing
            # a blank/flat render (Float32 data has no implicit 0-255 range).
            # Written as band metadata → stored inside the .tif (a SetStatistics
            # call would end up in a .aux.xml sidecar lost when zipping).
            a64 = arr.astype(np.float64)
            ab.SetMetadataItem('STATISTICS_MINIMUM', f'{a64.min():.6f}')
            ab.SetMetadataItem('STATISTICS_MAXIMUM', f'{a64.max():.6f}')
            ab.SetMetadataItem('STATISTICS_MEAN',    f'{a64.mean():.6f}')
            ab.SetMetadataItem('STATISTICS_STDDEV',  f'{a64.std():.6f}')
        ana_ds.GetRasterBand(1).SetColorInterpretation(gdal.GCI_GrayIndex)

        # ── Metadata on both files ────────────────────────────────────────────
        meta = {
            'ELEVATION_MIN_M':    f'{float(elev_arr.min()):.1f}',
            'ELEVATION_MAX_M':    f'{float(elev_arr.max()):.1f}',
            'ELEVATION_AVG_M':    f'{float(elev_arr.mean()):.1f}',
            'ELEVATION_RELIEF_M': f'{float(elev_arr.max() - elev_arr.min()):.1f}',
            'SLOPE_MIN_DEG':      f'{float(slope_arr.min()):.2f}',
            'SLOPE_AVG_DEG':      f'{float(slope_arr.mean()):.2f}',
            'SLOPE_MAX_DEG':      f'{float(slope_arr.max()):.2f}',
            'BBOX':               f'{min_lon:.6f},{min_lat:.6f},{max_lon:.6f},{max_lat:.6f}',
            'CRS':                'EPSG:4326 WGS84',
            'OUTPUT_SIZE':        f'{target_n}x{target_n}',
            'SLOPE_FLAT_PCT':     f'{cat_flat}%',
            'SLOPE_GENTLE_PCT':   f'{cat_gentle}%',
            'SLOPE_MODERATE_PCT': f'{cat_moderate}%',
            'SLOPE_STEEP_PCT':    f'{cat_steep}%',
            'SLOPE_VSTEEP_PCT':   f'{cat_vsteep}%',
            'COLOUR_RAMP':        'green(0deg)->amber(15deg)->red(45deg+) hillshade-blended',
            'ASPECT_CONVENTION':  '0=North 90=East 180=South 270=West -1=flat',
        }
        for k, v in meta.items():
            vis_ds.SetMetadataItem(k, v)
            ana_ds.SetMetadataItem(k, v)

        vis_ds.FlushCache(); vis_ds = None
        ana_ds.FlushCache(); ana_ds = None

        readme = (
            'RakshaGIS Terrain Analysis Export\n'
            '=================================\n\n'
            f'CRS    : EPSG:4326 (WGS84)\n'
            f'BBox   : {min_lon:.6f}, {min_lat:.6f} -> {max_lon:.6f}, {max_lat:.6f}\n'
            f'Size   : {target_n} x {target_n} px\n\n'
            'terrain-visualization.tif\n'
            '  3-band 8-bit RGB. Slope colour ramp (green->amber->red) blended\n'
            '  with hillshade. Opens in any image viewer or GIS software.\n\n'
            'terrain-analysis.tif\n'
            '  3-band Float32 DATA raster - NOT a picture. Ordinary image\n'
            '  viewers (Windows Photos, browsers) cannot display Float32 and\n'
            '  show a blank/transparent image. Open it in QGIS or ArcGIS:\n'
            '    Band 1: Elevation (m)        - Singleband gray / pseudocolor\n'
            '    Band 2: Slope (degrees)      - Singleband pseudocolor\n'
            '    Band 3: Aspect (deg, 0=N, clockwise, -1=flat)\n'
            '  QGIS: Layer Properties -> Symbology -> Render type\n'
            '        "Singleband pseudocolor", pick the band, classify.\n'
            '  Use it with the Raster Calculator for cut/fill, visibility,\n'
            '  flood-level and other raster analyses.\n'
        )

        import zipfile, io as _io
        zip_buf = _io.BytesIO()
        with zipfile.ZipFile(zip_buf, 'w', zipfile.ZIP_DEFLATED) as zf:
            with open(tmp_vis, 'rb') as f:
                zf.writestr('terrain-visualization.tif', f.read())
            with open(tmp_ana, 'rb') as f:
                zf.writestr('terrain-analysis.tif', f.read())
            zf.writestr('README.txt', readme)
        os.unlink(tmp_vis)
        os.unlink(tmp_ana)

        resp = DjResponse(zip_buf.getvalue(), content_type='application/zip')
        resp['Content-Disposition'] = 'attachment; filename="terrain-analysis.zip"'
        return resp


class DEMAnalysisView(APIView):
    """
    POST /api/core/terrain/dem-analysis/

    Unified DEM analysis engine.  Body:
      { type: str, elevGrid: float[], bbox: [minLon,minLat,maxLon,maxLat], gridN: int, params: {} }

    Supported types:
      contours | aspect_map | curvature | viewshed | volume | cut_fill
      flood    | landslide  | watershed | cross_section
      twi      | solar_shadow | trafficability
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

    @staticmethod
    def _make_hillshade(gx, gy):
        """Dual-illumination hillshade (0–1) — matches slope export lighting."""
        import numpy as np, math
        alt = math.radians(45)
        sl  = np.arctan(np.sqrt(gx**2 + gy**2))
        asp = np.arctan2(gx, -gy)
        for az_deg, w in [(315, 0.72), (45, 0.28)]:
            az = math.radians(az_deg)
            h  = np.sin(alt)*np.cos(sl) + np.cos(alt)*np.sin(sl)*np.cos(az - asp)
            if az_deg == 315:
                hs = w * np.clip(h, 0, 1)
            else:
                hs += w * np.clip(h, 0, 1)
        return hs.astype(np.float32)

    @staticmethod
    def _composite_hillshade(png_b64: str, hs) -> str:
        """Blend an RGBA analysis PNG over an earth-tone hillshade background."""
        import io, base64, numpy as np
        from PIL import Image

        raw   = base64.b64decode(png_b64.split(',', 1)[1])
        ana   = np.array(Image.open(io.BytesIO(raw)).convert('RGBA'), dtype=np.float32)
        ah, aw = ana.shape[:2]

        # Resize hillshade to match PNG dimensions (DEM grid may be smaller)
        if hs.shape != (ah, aw):
            hs_img = Image.fromarray((np.clip(hs, 0, 1) * 255).astype(np.uint8))
            hs_img = hs_img.resize((aw, ah), Image.BILINEAR)
            hs = np.array(hs_img, dtype=np.float32) / 255.0

        # Earth-tone base: dark-earth shadows → warm-light highlights
        base_r = 45  + 155 * hs
        base_g = 40  + 140 * hs
        base_b = 30  + 110 * hs

        # Alpha-composite analysis RGBA over the hillshade base
        a = ana[:, :, 3] / 255.0
        out_r = np.clip(a * ana[:, :, 0] + (1 - a) * base_r, 0, 255)
        out_g = np.clip(a * ana[:, :, 1] + (1 - a) * base_g, 0, 255)
        out_b = np.clip(a * ana[:, :, 2] + (1 - a) * base_b, 0, 255)

        rgb = np.stack([out_r, out_g, out_b], axis=2).astype(np.uint8)
        buf = io.BytesIO()
        Image.fromarray(rgb, 'RGB').save(buf, format='PNG')
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

    def _twi(self, elev_arr, slope_arr, dx, dy, min_lon, min_lat, max_lon, max_lat, params):
        """Topographic Wetness Index: ln(flow_acc * cell_area / tan(slope))."""
        import numpy as np
        ny, nx = elev_arr.shape

        # D8 flow accumulation — iterate cells highest→lowest, push weight downslope
        flow_acc = np.ones((ny, nx), dtype=np.float32)
        order = np.argsort(elev_arr.ravel())[::-1]
        dirs = [(-1,-1),(0,-1),(1,-1),(-1,0),(1,0),(-1,1),(0,1),(1,1)]
        for idx in order:
            r, c = divmod(int(idx), nx)
            best_elev = elev_arr[r, c]; br, bc = r, c
            for dr, dc in dirs:
                nr, nc = r+dr, c+dc
                if 0 <= nr < ny and 0 <= nc < nx and elev_arr[nr, nc] < best_elev:
                    best_elev = elev_arr[nr, nc]; br, bc = nr, nc
            if (br, bc) != (r, c):
                flow_acc[br, bc] += flow_acc[r, c]

        cell_area = dx * dy
        slope_rad = np.radians(slope_arr)
        tan_sl = np.where(slope_arr < 0.5, np.tan(np.radians(0.5)), np.tan(slope_rad))
        twi = np.log(flow_acc * cell_area / tan_sl).astype(np.float32)

        lo, hi = float(np.percentile(twi, 2)), float(np.percentile(twi, 98))
        norm = np.clip((twi - lo) / max(hi - lo, 0.1), 0, 1)
        # brown→yellow→cyan→blue colour ramp
        r_ch = np.interp(norm, [0,.4,.7,1], [139,255,  0,  0]).astype(np.uint8)
        g_ch = np.interp(norm, [0,.4,.7,1], [ 90,215,200,  0]).astype(np.uint8)
        b_ch = np.interp(norm, [0,.4,.7,1], [ 43,  0,255,200]).astype(np.uint8)
        rgba = np.stack([r_ch, g_ch, b_ch, np.full((ny,nx),200,np.uint8)], axis=2)

        high_pct = float(100 * (twi >= np.percentile(twi, 80)).sum() / twi.size)
        return {
            'type': 'twi',
            'image': self._to_png_b64(rgba),
            'stats': {
                'twi_min': round(float(np.percentile(twi,5)), 2),
                'twi_max': round(float(np.percentile(twi,95)), 2),
                'twi_mean': round(float(twi.mean()), 2),
                'waterlogging_risk_pct': round(high_pct, 1),
                'cell_area_m2': round(cell_area, 1),
            },
        }

    def _solar_shadow(self, elev_arr, slope_arr, gx, gy, dx, dy,
                      min_lon, min_lat, max_lon, max_lat, params):
        """Hillshade + shadow mask for a given date/time using simplified Spencer solar position."""
        import numpy as np, math
        ny, nx = elev_arr.shape
        from datetime import datetime

        date_str = params.get('date', '2024-06-21')
        time_str = params.get('time', '12:00')
        lat_c = (min_lat + max_lat) / 2
        lon_c = (min_lon + max_lon) / 2

        try:
            dt = datetime.strptime(f'{date_str} {time_str}', '%Y-%m-%d %H:%M')
        except ValueError:
            dt = datetime(2024, 6, 21, 12, 0)

        doy = dt.timetuple().tm_yday
        B = math.radians(360 / 365 * (doy - 81))
        decl = math.radians(23.45 * math.sin(B))
        eqt  = (9.87*math.sin(2*B) - 7.53*math.cos(B) - 1.5*math.sin(B)) / 60.0
        solar_noon = 12.0 - lon_c / 15.0 - eqt
        hour_angle = math.radians(15 * ((dt.hour + dt.minute/60) - solar_noon))

        lat_r = math.radians(lat_c)
        sin_alt = (math.sin(lat_r)*math.sin(decl) +
                   math.cos(lat_r)*math.cos(decl)*math.cos(hour_angle))
        sun_alt = math.asin(max(sin_alt, 1e-6))
        sun_elev_deg = math.degrees(sun_alt)

        cos_az_num = math.sin(decl) - math.sin(lat_r)*sin_alt
        cos_az_den = math.cos(lat_r)*math.cos(sun_alt)
        cos_az = max(-1.0, min(1.0, cos_az_num / max(cos_az_den, 1e-9)))
        az = math.acos(cos_az)
        if (dt.hour + dt.minute/60) > solar_noon:
            az = 2*math.pi - az
        sun_az_deg = math.degrees(az)

        # Hillshade
        zenith = math.pi/2 - sun_alt
        mag = np.sqrt(1 + gx**2 + gy**2)
        hs = (math.cos(zenith)/mag +
              math.sin(zenith)*(-math.sin(az)*gx - math.cos(az)*gy)/mag)
        hs = np.clip(hs * 255, 0, 255).astype(np.uint8)

        shadow = hs < 15
        r_ch = np.where(shadow, np.uint8(15),  hs)
        g_ch = np.where(shadow, np.uint8(20),  np.clip((hs.astype(int)*200//255), 0, 255).astype(np.uint8))
        b_ch = np.where(shadow, np.uint8(60),  np.clip((hs.astype(int)*100//255), 0, 255).astype(np.uint8))
        rgba = np.stack([r_ch, g_ch, b_ch, np.full((ny,nx),210,np.uint8)], axis=2)

        return {
            'type': 'solar_shadow',
            'image': self._to_png_b64(rgba),
            'stats': {
                'sun_elevation_deg': round(sun_elev_deg, 1),
                'sun_azimuth_deg': round(sun_az_deg, 1),
                'shadowed_area_pct': round(float(100*shadow.sum()/shadow.size), 1),
                'date': date_str,
                'time': time_str,
            },
        }

    def _trafficability(self, elev_arr, slope_arr, dx, dy,
                        min_lon, min_lat, max_lon, max_lat, params):
        """Off-road vehicle passability map from slope + terrain roughness."""
        import numpy as np
        ny, nx = elev_arr.shape
        cell = dx * dy

        # Local roughness = deviation from 3×3 moving average
        kernel = np.ones((3,3)) / 9.0
        from scipy.ndimage import uniform_filter
        smooth = uniform_filter(elev_arr.astype(float), size=3)
        rough = np.abs(elev_arr - smooth).astype(np.float32)
        rough_thresh = float(np.percentile(rough, 75))

        easy      = (slope_arr < 8)
        moderate  = (slope_arr >= 8)  & (slope_arr < 15)
        difficult = (slope_arr >= 15) & (slope_arr < 30) | (easy & (rough > rough_thresh*1.5))
        impassable = slope_arr >= 30

        r_ch = np.zeros((ny,nx), np.uint8); g_ch = r_ch.copy(); b_ch = r_ch.copy()
        r_ch[easy]=50;  g_ch[easy]=180;  b_ch[easy]=50     # green
        r_ch[moderate]=255; g_ch[moderate]=200; b_ch[moderate]=0  # yellow
        r_ch[difficult]=255; g_ch[difficult]=100; b_ch[difficult]=0  # orange
        r_ch[impassable]=200; g_ch[impassable]=0; b_ch[impassable]=0 # red
        rgba = np.stack([r_ch, g_ch, b_ch, np.full((ny,nx),200,np.uint8)], axis=2)

        total = ny * nx
        return {
            'type': 'trafficability',
            'image': self._to_png_b64(rgba),
            'stats': {
                'easy_pct':       round(float(100*easy.sum()/total), 1),
                'moderate_pct':   round(float(100*moderate.sum()/total), 1),
                'difficult_pct':  round(float(100*difficult.sum()/total), 1),
                'impassable_pct': round(float(100*impassable.sum()/total), 1),
                'passable_area_km2': round(float((easy|moderate).sum()*cell/1e6), 3),
            },
        }

    def _change_detection(self, elev_arr, dx, dy, params):
        """Compare two elevation grids; positive diff=fill (blue), negative=cut (red)."""
        import numpy as np
        ny, nx = elev_arr.shape
        grid2_flat = params.get('grid2', [])
        if len(grid2_flat) != ny * nx:
            raise ValueError(f'grid2 must have {ny*nx} values (same as grid1)')
        grid2 = np.array(grid2_flat, dtype=np.float32).reshape(ny, nx)
        diff = grid2 - elev_arr

        cell_area = dx * dy
        cut  = diff < -0.1
        fill = diff > 0.1

        lo = float(np.percentile(diff, 2)); hi = float(np.percentile(diff, 98))
        norm = np.clip((diff - lo) / max(hi - lo, 0.1), 0, 1)
        r_ch = np.interp(norm, [0,.45,.55,1], [210,200,170, 40]).astype(np.uint8)
        g_ch = np.interp(norm, [0,.45,.55,1], [ 50,200,210,130]).astype(np.uint8)
        b_ch = np.interp(norm, [0,.45,.55,1], [ 50, 80,230,230]).astype(np.uint8)
        alpha = np.full((ny,nx), 210, np.uint8)
        rgba = np.stack([r_ch, g_ch, b_ch, alpha], axis=2)

        return {
            'type': 'change_detection',
            'image': self._to_png_b64(rgba),
            'stats': {
                'cut_volume_m3':  round(float((-diff[cut]).sum()  * cell_area), 1),
                'fill_volume_m3': round(float(diff[fill].sum()    * cell_area), 1),
                'net_change_m3':  round(float(diff.sum()          * cell_area), 1),
                'cut_area_pct':   round(float(100 * cut.sum()  / diff.size), 1),
                'fill_area_pct':  round(float(100 * fill.sum() / diff.size), 1),
                'max_cut_m':      round(float((-diff).max()), 2),
                'max_fill_m':     round(float(diff.max()), 2),
                'rmse_m':         round(float(np.sqrt((diff**2).mean())), 3),
            },
        }

    def _lz_assessment(self, elev_arr, slope_arr, dx, dy, min_lon, min_lat, max_lon, max_lat, params):
        """Landing Zone assessment: slope < 7°, flat radius, approach clearance."""
        import numpy as np, math
        from scipy.ndimage import uniform_filter, shift as nd_shift
        ny, nx = elev_arr.shape

        radius_m    = float(params.get('radius_m', 30))
        approach_dir = float(params.get('approach_deg', 270))
        approach_m   = float(params.get('approach_m', 200))

        # 1. Slope score — primary criterion (< 7° ideal)
        slope_score = np.clip((7.0 - slope_arr) / 7.0 * 100, 0, 100)

        # 2. Flat-area radius score — kernel min-slope check
        kern = max(3, int(radius_m / ((dx + dy) / 2)) * 2 + 1)
        kern = min(kern, min(ny, nx) - 1)
        local_max_slope = uniform_filter(slope_arr.astype(float), size=kern)
        area_score = np.clip((7.0 - local_max_slope) / 7.0 * 100, 0, 100)

        # 3. Approach clearance — check terrain rise in look-ahead direction
        approach_rad = math.radians(approach_dir)
        shift_c =  math.cos(approach_rad) * approach_m / max(dx, 1)
        shift_r = -math.sin(approach_rad) * approach_m / max(dy, 1)  # row increases southward
        ahead = nd_shift(elev_arr.astype(float), (shift_r, shift_c), mode='nearest')
        rise = np.maximum(0, ahead - elev_arr.astype(float)).astype(np.float32)
        approach_score = np.clip(100 - rise * 3, 0, 100)

        composite = (slope_score * 0.45 + area_score * 0.35 + approach_score * 0.20).astype(np.float32)

        excellent  = composite >= 80
        good       = (composite >= 60) & ~excellent
        marginal   = (composite >= 40) & ~excellent & ~good
        unsuitable = composite < 40

        r_ch = np.zeros((ny,nx), np.uint8); g_ch = r_ch.copy(); b_ch = r_ch.copy()
        r_ch[excellent]=0;   g_ch[excellent]=200; b_ch[excellent]=100
        r_ch[good]=100;      g_ch[good]=210;      b_ch[good]=50
        r_ch[marginal]=255;  g_ch[marginal]=200;  b_ch[marginal]=0
        r_ch[unsuitable]=200; g_ch[unsuitable]=50; b_ch[unsuitable]=50
        rgba = np.stack([r_ch, g_ch, b_ch, np.full((ny,nx),200,np.uint8)], axis=2)
        rgba[~unsuitable & ~marginal & ~good & ~excellent] = [60,60,60,120]

        total = ny * nx
        return {
            'type': 'lz_assessment',
            'image': self._to_png_b64(rgba),
            'stats': {
                'excellent_pct':  round(float(100*excellent.sum()/total), 1),
                'good_pct':       round(float(100*good.sum()/total), 1),
                'marginal_pct':   round(float(100*marginal.sum()/total), 1),
                'unsuitable_pct': round(float(100*unsuitable.sum()/total), 1),
                'lz_radius_m':    radius_m,
                'approach_dir_deg': approach_dir,
                'candidate_zones': int(excellent.sum()),
            },
        }

    def _rf_coverage(self, elev_arr, dx, dy, min_lon, min_lat, max_lon, max_lat, params):
        """RF line-of-sight coverage with first Fresnel zone obstruction check."""
        import numpy as np, math
        ny, nx = elev_arr.shape

        obs_lat  = float(params.get('tower_lat',    (min_lat+max_lat)/2))
        obs_lon  = float(params.get('tower_lon',    (min_lon+max_lon)/2))
        tower_h  = float(params.get('tower_height_m', 30))
        freq_mhz = float(params.get('freq_mhz', 150))
        rx_h     = float(params.get('rx_height_m',  2))

        obs_xi = int(np.clip((obs_lon-min_lon)/(max_lon-min_lon)*(nx-1), 0, nx-1))
        obs_yi = int(np.clip((obs_lat-min_lat)/(max_lat-min_lat)*(ny-1), 0, ny-1))
        obs_e  = float(elev_arr[obs_yi, obs_xi]) + tower_h

        tgt_y = np.arange(ny)[:,None].repeat(nx,axis=1).astype(float)
        tgt_x = np.arange(nx)[None,:].repeat(ny,axis=0).astype(float)
        tgt_e = elev_arr.astype(float) + rx_h

        # Max terrain obstruction above LOS line for each cell
        max_obs = np.full((ny,nx), -999.0, dtype=np.float64)
        n_steps = np.maximum(np.abs(tgt_y-obs_yi), np.abs(tgt_x-obs_xi))

        for step in range(1, int(max(ny,nx)*1.5)+1):
            frac    = np.where(n_steps>0, step/n_steps, 1.0)
            in_path = (frac>0.0) & (frac<1.0)
            if not in_path.any(): break

            sy = np.round(obs_yi + frac*(tgt_y-obs_yi)).astype(int).clip(0,ny-1)
            sx = np.round(obs_xi + frac*(tgt_x-obs_xi)).astype(int).clip(0,nx-1)
            terrain_h = elev_arr[sy, sx].astype(float)
            los_h = obs_e + frac*(tgt_e - obs_e)
            obstruction = terrain_h - los_h
            max_obs = np.where(in_path, np.maximum(max_obs, obstruction), max_obs)

        # Fresnel zone first radius at midpoint: r1 ≈ 17.3√(d/4f) metres
        dist_m = np.sqrt(((tgt_y-obs_yi)*dy)**2 + ((tgt_x-obs_xi)*dx)**2)
        dist_m = np.where(dist_m < 1, 1, dist_m)
        freq_hz = max(freq_mhz, 1) * 1e6
        fresnel_r = 17.3 * np.sqrt(dist_m / (4 * freq_hz))

        coverage = np.zeros((ny,nx), dtype=np.uint8)
        coverage = np.where(max_obs <= 0,                        np.uint8(3), coverage)  # clear LoS
        coverage = np.where((max_obs>0) & (max_obs<=fresnel_r*0.6), np.uint8(2), coverage)  # minor
        coverage = np.where((max_obs>fresnel_r*0.6) & (max_obs<=fresnel_r), np.uint8(1), coverage)  # partial
        coverage[obs_yi, obs_xi] = 3

        color_r = np.array([60,200,100, 30], np.uint8)
        color_g = np.array([60,100,200,200], np.uint8)
        color_b = np.array([60, 50, 50, 50], np.uint8)
        r_ch = color_r[coverage]; g_ch = color_g[coverage]; b_ch = color_b[coverage]
        rgba = np.stack([r_ch, g_ch, b_ch, np.full((ny,nx),200,np.uint8)], axis=2)
        rgba[obs_yi,obs_xi] = [255,255,0,255]

        total = ny*nx
        return {
            'type': 'rf_coverage',
            'image': self._to_png_b64(rgba),
            'stats': {
                'excellent_los_pct':   round(float(100*(coverage==3).sum()/total), 1),
                'minor_fresnel_pct':   round(float(100*(coverage==2).sum()/total), 1),
                'partial_fresnel_pct': round(float(100*(coverage==1).sum()/total), 1),
                'no_coverage_pct':     round(float(100*(coverage==0).sum()/total), 1),
                'tower_height_m': tower_h,
                'freq_mhz': freq_mhz,
                'tower_lat': obs_lat,
                'tower_lon': obs_lon,
            },
        }

    # ── dispatch ──────────────────────────────────────────────────────────────

    def post(self, request):
        analysis_type = request.data.get('type','')
        try:
            (elev_arr, slope_arr, asp_arr, gx, gy,
             dx, dy, min_lon, min_lat, max_lon, max_lat, grid_n, params) = self._setup(request)
        except ValueError as e:
            return Response({'error': str(e)}, status=400)

        dispatch = {
            'contours':          lambda: self._contours(elev_arr, min_lon, min_lat, max_lon, max_lat, params),
            'aspect_map':        lambda: self._aspect_map(elev_arr, asp_arr, slope_arr, params),
            'curvature':         lambda: self._curvature(elev_arr, dx, dy, params),
            'viewshed':          lambda: self._viewshed(elev_arr, dx, dy, min_lon, min_lat, max_lon, max_lat, params),
            'volume':            lambda: self._volume(elev_arr, dx, dy, params),
            'cut_fill':          lambda: self._volume(elev_arr, dx, dy, params),
            'flood':             lambda: self._flood(elev_arr, dx, dy, min_lon, min_lat, max_lon, max_lat, params),
            'landslide':         lambda: self._landslide(elev_arr, slope_arr, dx, dy, params),
            'watershed':         lambda: self._watershed(elev_arr, dx, dy, min_lon, min_lat, max_lon, max_lat, params),
            'cross_section':     lambda: self._cross_section(elev_arr, dx, dy, min_lon, min_lat, max_lon, max_lat, params),
            'twi':               lambda: self._twi(elev_arr, slope_arr, dx, dy, min_lon, min_lat, max_lon, max_lat, params),
            'solar_shadow':      lambda: self._solar_shadow(elev_arr, slope_arr, gx, gy, dx, dy, min_lon, min_lat, max_lon, max_lat, params),
            'trafficability':    lambda: self._trafficability(elev_arr, slope_arr, dx, dy, min_lon, min_lat, max_lon, max_lat, params),
            'change_detection':  lambda: self._change_detection(elev_arr, dx, dy, params),
            'lz_assessment':     lambda: self._lz_assessment(elev_arr, slope_arr, dx, dy, min_lon, min_lat, max_lon, max_lat, params),
            'rf_coverage':       lambda: self._rf_coverage(elev_arr, dx, dy, min_lon, min_lat, max_lon, max_lat, params),
        }
        fn = dispatch.get(analysis_type)
        if not fn:
            return Response({'error': f'Unknown type: {analysis_type}'}, status=400)

        try:
            result = fn()
        except Exception as exc:
            import traceback
            return Response({'error': str(exc), 'trace': traceback.format_exc()}, status=500)

        # Composite every raster image over an earth-tone hillshade base so the
        # downloaded PNG contains terrain context (like the slope export output).
        # solar_shadow already encodes its own hillshade; skip to avoid double-blending.
        if result.get('image') and analysis_type != 'solar_shadow':
            try:
                hs = self._make_hillshade(gx, gy)
                result['image'] = self._composite_hillshade(result['image'], hs)
            except Exception:
                pass  # fall back to plain image if compositing fails

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

    include_dxf = bool(request.data.get('include_dxf', False))

    et = ExportTask.objects.create(
        export_type=export_type,
        object_id=object_id,
        object_name=object_name,
        requested_by=user,
        organisation_id=org_id,
        include_dxf=include_dxf,
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



# ── Terrain viewer: ad-hoc vector upload ───────────────────────────────────────

class TerrainVectorUploadView(APIView):
    """
    POST /api/core/terrain/vector-upload/   (multipart: file)

    Parse an uploaded vector file and return WGS84 GeoJSON for draping on the
    3D terrain viewer. Nothing is written to the database — this is a viewing/
    analysis aid, not an import.

    Supported: .zip (shapefile or KML inside), .geojson/.json, .kml, .kmz, .gpkg
    Response:  { name, feature_count, truncated, bbox: [minLon,minLat,maxLon,maxLat],
                 geojson: FeatureCollection }
    """
    parser_classes = [parsers.MultiPartParser]
    permission_classes = [permissions.IsAuthenticated]

    MAX_FEATURES = 10_000
    MAX_SIZE_MB = 100

    @staticmethod
    def _walk_coords(coords, bbox):
        """Update bbox [minLon,minLat,maxLon,maxLat] from nested coordinates."""
        if not coords:
            return
        if isinstance(coords[0], (int, float)):
            lon, lat = coords[0], coords[1]
            bbox[0] = min(bbox[0], lon); bbox[1] = min(bbox[1], lat)
            bbox[2] = max(bbox[2], lon); bbox[3] = max(bbox[3], lat)
        else:
            for c in coords:
                TerrainVectorUploadView._walk_coords(c, bbox)

    def post(self, request):
        import json as _json
        import tempfile
        import zipfile as _zipfile
        try:
            import fiona
            import fiona.transform
        except ImportError:
            return Response({'error': 'GDAL/fiona not available on server'}, status=503)

        up = request.FILES.get('file')
        if not up:
            return Response({'error': 'No file uploaded'}, status=400)
        if up.size > self.MAX_SIZE_MB * 1024 * 1024:
            return Response({'error': f'File exceeds {self.MAX_SIZE_MB} MB limit'}, status=400)

        ext = (up.name.lower().rsplit('.', 1)[-1] if '.' in up.name else '')
        if ext not in ('zip', 'geojson', 'json', 'kml', 'kmz', 'gpkg'):
            return Response({'error': f'Unsupported format ".{ext}". '
                                      'Use shapefile .zip, GeoJSON, KML/KMZ or GPKG.'}, status=400)

        features: list = []
        bbox = [180.0, 90.0, -180.0, -90.0]
        truncated = False

        try:
            with tempfile.TemporaryDirectory() as tmpdir:
                src_path = os.path.join(tmpdir, os.path.basename(up.name))
                with open(src_path, 'wb') as f:
                    for chunk in up.chunks():
                        f.write(chunk)

                # Archives: extract and locate the actual vector layer(s)
                if ext in ('zip', 'kmz'):
                    with _zipfile.ZipFile(src_path) as zf:
                        zf.extractall(tmpdir)
                    paths = []
                    for root, _, files in os.walk(tmpdir):
                        for fn in files:
                            if fn.lower().endswith(('.shp', '.kml', '.geojson', '.gpkg')):
                                paths.append(os.path.join(root, fn))
                    if not paths:
                        return Response({'error': 'No supported vector layer '
                                                  '(.shp/.kml/.geojson/.gpkg) found in archive'}, status=400)
                else:
                    paths = [src_path]

                for path in paths:
                    try:
                        layers = fiona.listlayers(path)
                    except Exception:
                        layers = [None]
                    for layer in layers:
                        try:
                            src = fiona.open(path, layer=layer) if layer else fiona.open(path)
                        except Exception:
                            continue
                        with src:
                            src_crs = src.crs_wkt or 'EPSG:4326'
                            for feat in src:
                                if len(features) >= self.MAX_FEATURES:
                                    truncated = True
                                    break
                                if feat.geometry is None:
                                    continue
                                geom = fiona.transform.transform_geom(
                                    src_crs, 'EPSG:4326', feat.geometry)
                                geom = _json.loads(_json.dumps(geom))  # plain dict
                                props = {}
                                for k, v in dict(feat.properties or {}).items():
                                    props[str(k)] = (v if isinstance(v, (int, float, bool))
                                                     or v is None else str(v))
                                self._walk_coords(geom.get('coordinates'), bbox)
                                features.append({'type': 'Feature',
                                                 'geometry': geom,
                                                 'properties': props})
                        if truncated:
                            break
                    if truncated:
                        break
        except _zipfile.BadZipFile:
            return Response({'error': 'Corrupt archive'}, status=400)
        except Exception as exc:
            logger.exception('terrain vector-upload parse error')
            return Response({'error': f'Could not parse file: {exc}'}, status=400)

        if not features:
            return Response({'error': 'No features with geometry found in the file'}, status=400)

        return Response({
            'name': up.name,
            'feature_count': len(features),
            'truncated': truncated,
            'bbox': bbox,
            'geojson': {'type': 'FeatureCollection', 'features': features},
        })


# ── LiDAR point cloud upload ───────────────────────────────────────────────────

class LidarUploadView(APIView):
    parser_classes = [parsers.MultiPartParser]
    permission_classes = [permissions.IsAuthenticated]

    MAX_POINTS = 200_000  # subsample to this many for web delivery

    def post(self, request):
        las_file = request.FILES.get('file')
        if not las_file:
            return Response({'error': 'No file uploaded'}, status=400)

        suffix = las_file.name.lower().rsplit('.', 1)[-1]
        if suffix not in ('las', 'laz'):
            return Response({'error': 'Only .las / .laz files are supported'}, status=400)

        import tempfile, numpy as np

        try:
            import laspy
        except ImportError:
            return Response({'error': 'laspy not installed on server'}, status=501)

        with tempfile.NamedTemporaryFile(suffix=f'.{suffix}', delete=False) as tmp:
            for chunk in las_file.chunks():
                tmp.write(chunk)
            tmp_path = tmp.name

        try:
            las = laspy.read(tmp_path)
            xs = np.array(las.x, dtype=np.float64)
            ys = np.array(las.y, dtype=np.float64)
            zs = np.array(las.z, dtype=np.float32)

            # Reproject to WGS84 if CRS is not geographic
            try:
                from pyproj import CRS, Transformer
                src_crs = None
                if hasattr(las, 'header') and hasattr(las.header, 'parse_crs'):
                    try:
                        src_crs = las.header.parse_crs()
                    except Exception:
                        pass
                if src_crs is None:
                    try:
                        src_crs = CRS.from_wkt(las.header.vlrs[0].record_data.decode('utf-8'))
                    except Exception:
                        pass
                if src_crs and not src_crs.is_geographic:
                    t = Transformer.from_crs(src_crs, 'EPSG:4326', always_xy=True)
                    xs, ys = t.transform(xs, ys)
            except Exception:
                pass  # leave as-is — may already be WGS84

            n_pts = len(xs)
            if n_pts > self.MAX_POINTS:
                idx = np.random.choice(n_pts, self.MAX_POINTS, replace=False)
                xs = xs[idx]; ys = ys[idx]; zs = zs[idx]

            # Try to get intensity / RGB for colouring
            try:
                intensity = np.array(las.intensity, dtype=np.float32)
                if n_pts > self.MAX_POINTS:
                    intensity = intensity[idx]
                # Normalise to 0-255
                imin, imax = intensity.min(), intensity.max()
                if imax > imin:
                    intensity = ((intensity - imin) / (imax - imin) * 255).astype(np.uint8)
                else:
                    intensity = np.full(len(xs), 128, np.uint8)
            except Exception:
                intensity = np.full(len(xs), 128, np.uint8)

            # Build DEM from point cloud using 2D histogram binning
            dem_data = None
            try:
                from scipy.stats import binned_statistic_2d
                n_bins = 64
                stat, x_edges, y_edges, _ = binned_statistic_2d(
                    xs, ys, zs, statistic='mean', bins=n_bins,
                )
                valid = ~np.isnan(stat)
                if valid.any():
                    # Fill NaN with nearest valid (simple forward fill)
                    from scipy.ndimage import label
                    filled = stat.copy()
                    mean_z = float(zs.mean())
                    filled[~valid] = mean_z
                    min_lon = float(x_edges[0]); max_lon = float(x_edges[-1])
                    min_lat = float(y_edges[0]); max_lat = float(y_edges[-1])
                    dem_data = {
                        'elevGrid': filled.T.ravel().tolist(),
                        'bbox': [min_lon, min_lat, max_lon, max_lat],
                        'gridN': n_bins,
                    }
            except Exception:
                pass

            return Response({
                'point_count': int(len(xs)),
                'original_count': int(n_pts),
                'min_lon': float(xs.min()), 'max_lon': float(xs.max()),
                'min_lat': float(ys.min()), 'max_lat': float(ys.max()),
                'min_elev': float(zs.min()), 'max_elev': float(zs.max()),
                'points': {
                    'x': xs.tolist(),
                    'y': ys.tolist(),
                    'z': zs.tolist(),
                    'i': intensity.tolist(),
                },
                'dem': dem_data,
            })
        except Exception as exc:
            return Response({'error': f'Failed to parse point cloud: {exc}'}, status=400)
        finally:
            import os as _os
            try:
                _os.unlink(tmp_path)
            except Exception:
                pass


# ---------------------------------------------------------------------------
# Sentinel-2 tile proxy
# ---------------------------------------------------------------------------

@api_view(['GET'])
@permission_classes([permissions.IsAuthenticated])
def sentinel2_tile(request, pk: int, z: int, x: int, y: int):
    """
    GET /api/core/sentinel2-tiles/{pk}/{z}/{x}/{y}/

    Serves a cached Sentinel-2 tile if available, otherwise fetches it live
    from the configured url_template and caches it for future requests.
    Returns the tile image with an appropriate content-type.
    """
    import urllib.request
    from django.http import HttpResponse, Http404
    from apps.core.models import BasemapConfig
    from django.conf import settings as _s

    try:
        bm = BasemapConfig.objects.get(pk=pk, provider=BasemapConfig.SENTINEL2, is_active=True)
    except BasemapConfig.DoesNotExist:
        raise Http404

    if not bm.url_template:
        raise Http404

    tile_path = os.path.join(
        _s.MEDIA_ROOT, 'tile_cache', 'sentinel2', str(pk), str(z), str(x), f"{y}.jpg"
    )

    if os.path.exists(tile_path):
        with open(tile_path, 'rb') as fh:
            return HttpResponse(fh.read(), content_type='image/jpeg')

    # Live fetch and cache
    url = (
        bm.url_template
        .replace('{z}', str(z)).replace('{x}', str(x)).replace('{y}', str(y))
        .replace('{TileMatrix}', str(z))
        .replace('{TileCol}', str(x))
        .replace('{TileRow}', str(y))
    )
    try:
        req = urllib.request.Request(url, headers={'User-Agent': 'RakshaGIS/1.0'})
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = resp.read()
            content_type = resp.headers.get('Content-Type', 'image/jpeg')
    except Exception:
        raise Http404

    os.makedirs(os.path.dirname(tile_path), exist_ok=True)
    try:
        with open(tile_path, 'wb') as fh:
            fh.write(data)
    except OSError:
        pass

    return HttpResponse(data, content_type=content_type)
