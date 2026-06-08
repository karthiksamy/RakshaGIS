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

        source = 'none'
        if ion_token:
            source = 'ion'
        elif terrain_url:
            source = 'local'

        return Response({
            'cesium_ion_token': ion_token,
            'terrain_tile_url': terrain_url or '/terrain-tiles',
            'terrain_source': source,  # 'none' | 'local' | 'ion'
        })


class TerrainExportGeoTIFFView(APIView):
    """
    POST /api/core/terrain/export-geotiff/

    Body: { elevGrid: float[], bbox: [minLon,minLat,maxLon,maxLat], gridN: int }

    Returns a 2-band GeoTIFF (WGS84 / EPSG:4326):
      Band 1 – elevation in metres
      Band 2 – slope in degrees (computed from the elevation grid)
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

        # Elevation array — row 0 = southernmost lat; flip north-south for GeoTIFF
        # (GeoTIFF row 0 = northernmost → negate y-axis in geotransform or flip array)
        elev_arr = np.array(elev_flat, dtype=np.float32).reshape(grid_n, grid_n)
        elev_arr = np.flipud(elev_arr)  # row 0 → northernmost

        # Ground sample distances in metres
        def _hav(lat1, lon1, lat2, lon2):
            R = 6_371_000
            dlat = math.radians(lat2 - lat1)
            dlon = math.radians(lon2 - lon1)
            a = math.sin(dlat/2)**2 + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlon/2)**2
            return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))

        dx = _hav(min_lat, min_lon, min_lat, max_lon) / max(grid_n - 1, 1)
        dy = _hav(min_lat, min_lon, max_lat, min_lon) / max(grid_n - 1, 1)

        # Slope from gradient (degrees)
        grad_y, grad_x = np.gradient(elev_arr, dy, dx)
        slope_arr = np.degrees(np.arctan(np.sqrt(grad_x**2 + grad_y**2))).astype(np.float32)

        # Write GeoTIFF
        tmp = tempfile.mktemp(suffix='.tif')
        pixel_w = (max_lon - min_lon) / grid_n
        pixel_h = (max_lat - min_lat) / grid_n

        driver = gdal.GetDriverByName('GTiff')
        ds = driver.Create(tmp, grid_n, grid_n, 2, gdal.GDT_Float32,
                           options=['COMPRESS=LZW', 'TILED=YES'])
        ds.SetGeoTransform([min_lon, pixel_w, 0, max_lat, 0, -pixel_h])

        srs = osr.SpatialReference()
        srs.ImportFromEPSG(4326)
        ds.SetProjection(srs.ExportToWkt())

        b1 = ds.GetRasterBand(1)
        b1.WriteArray(elev_arr)
        b1.SetDescription('Elevation (m)')
        b1.SetNoDataValue(-9999)

        b2 = ds.GetRasterBand(2)
        b2.WriteArray(slope_arr)
        b2.SetDescription('Slope (degrees)')
        b2.SetNoDataValue(-9999)

        ds.FlushCache()
        ds = None

        with open(tmp, 'rb') as f:
            content = f.read()
        os.unlink(tmp)

        resp = DjResponse(content, content_type='image/tiff')
        resp['Content-Disposition'] = 'attachment; filename="terrain-slope-analysis.tif"'
        return resp


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

