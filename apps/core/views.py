from rest_framework import viewsets, permissions
from rest_framework.decorators import action
from rest_framework.exceptions import PermissionDenied
from rest_framework.views import APIView
from rest_framework.response import Response

from apps.accounts.permissions import IsSuperAdmin
from .models import BasemapConfig, BrandingConfig
from .serializers import BasemapConfigSerializer, BrandingConfigSerializer


class BrandingConfigView(APIView):
    """GET: public (no auth). PATCH: superadmin only."""

    def get_permissions(self):
        if self.request.method == 'GET':
            return [permissions.AllowAny()]
        return [IsSuperAdmin()]

    def get(self, request):
        obj = BrandingConfig.get_solo()
        return Response(BrandingConfigSerializer(obj).data)

    def patch(self, request):
        obj = BrandingConfig.get_solo()
        ser = BrandingConfigSerializer(obj, data=request.data, partial=True)
        ser.is_valid(raise_exception=True)
        ser.save()
        return Response(ser.data)


class BasemapConfigViewSet(viewsets.ModelViewSet):
    serializer_class = BasemapConfigSerializer

    def get_queryset(self):
        qs = BasemapConfig.objects.select_related('created_by')
        # Non-superadmin users only see active basemaps
        if not (self.request.user.is_authenticated and self.request.user.is_superadmin):
            qs = qs.filter(is_active=True)
        return qs

    def get_permissions(self):
        if self.action in ['list', 'retrieve']:
            return [permissions.IsAuthenticated()]
        return [IsSuperAdmin()]

    def perform_create(self, serializer):
        serializer.save(created_by=self.request.user)

    def perform_destroy(self, instance):
        if instance.is_system:
            raise PermissionDenied("System basemap configurations cannot be deleted.")
        instance.delete()

    @action(detail=True, methods=['post'], permission_classes=[IsSuperAdmin])
    def set_default(self, request, pk=None):
        """Mark this basemap as the single default (and ensure it is active)."""
        basemap = self.get_object()
        basemap.is_default = True
        basemap.save()  # model.save() activates it and clears any other default
        return Response(BasemapConfigSerializer(basemap).data)


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


# Mapnik export endpoints
from django.http import HttpResponse, JsonResponse
from rest_framework.decorators import api_view, permission_classes
import logging

logger = logging.getLogger(__name__)


@api_view(['POST'])
@permission_classes([permissions.IsAuthenticated])
def export_map(request):
    """
    Render map to PNG using Mapnik under Python 3.13 system subprocess.
    Includes Living Provenance DNA watermarking in the output.
    """
    import subprocess
    import os
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
        return JsonResponse({
            'error': 'Invalid parameters',
            'detail': str(exc)
        }, status=400)

    # Build command line to execute the render_mapnik.py script using python3
    cmd = [
        "/usr/bin/python3",
        "apps/core/render_mapnik.py",
        "--style", style,
        "--width", str(width),
        "--height", str(height),
        "--zoom", str(zoom),
        "--center-lon", str(center_lon),
        "--center-lat", str(center_lat),
        "--format", "png"
    ]

    try:
        # Run subprocess with environment variables preserved
        env = os.environ.copy()
        
        result = subprocess.run(
            cmd,
            env=env,
            capture_output=True,
            check=True
        )
        png_bytes = result.stdout
        
        # Apply Living Provenance DNA watermarking
        filename = f"rakshagis_map_{style}_{int(time.time())}.png"
        metadata = {
            "uploaded_by": request.user.username,
            "export_format": "png",
            "style": style,
            "zoom": zoom,
            "center_lon": center_lon,
            "center_lat": center_lat,
        }
        try:
            watermarked_png = embed_watermark(png_bytes, filename, 'image/png', metadata)
        except Exception as wexc:
            logger.error(f"Failed to embed watermark in map export: {wexc}")
            watermarked_png = png_bytes

        response = HttpResponse(watermarked_png, content_type='image/png')
        response['Content-Disposition'] = f'attachment; filename="{filename}"'
        return response

    except subprocess.CalledProcessError as exc:
        stderr_msg = exc.stderr.decode('utf-8', errors='ignore')
        logger.error(f"Mapnik rendering subprocess failed: {stderr_msg}")
        return JsonResponse({
            'error': 'Mapnik rendering failed',
            'detail': stderr_msg.strip() or 'Unknown error in rendering subprocess.'
        }, status=500)
    except Exception as exc:
        logger.exception("Failed to run mapnik rendering")
        return JsonResponse({
            'error': 'Export failed',
            'detail': str(exc)
        }, status=500)



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

        map_b64 = data.get('map_image_b64', '')
        basemap_b64 = data.get('basemap_image_b64', '')
        features_b64 = data.get('features_image_b64', '')

        if not map_b64 and not basemap_b64 and not features_b64:
            return JsonResponse({'error': 'map_image_b64 or split layer images are required'}, status=400)

        # Strip data-URL prefix if the frontend included it
        if map_b64 and ',' in map_b64:
            map_b64 = map_b64.split(',', 1)[1]
        if basemap_b64 and ',' in basemap_b64:
            basemap_b64 = basemap_b64.split(',', 1)[1]
        if features_b64 and ',' in features_b64:
            features_b64 = features_b64.split(',', 1)[1]

        paper_size  = data.get('paper_size', 'A4')
        orientation = data.get('orientation', 'landscape')

        if paper_size not in PAPER_SIZES:
            paper_size = 'A4'
        if orientation not in ('portrait', 'landscape'):
            orientation = 'landscape'

        html = generate_arcgis_print_html(
            map_image_b64    = map_b64,
            basemap_image_b64= basemap_b64,
            features_image_b64= features_b64,
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
        metadata = {
            "uploaded_by": request.user.username,
            "export_format": "pdf",
            "paper_size": paper_size,
            "orientation": orientation,
        }
        layers = data.get('layers')
        if layers:
            metadata['layers'] = layers

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
    Receives any file (PDF, PNG, etc.), applies the LP-DNA/C2PA watermark, and returns it.
    """
    uploaded_file = request.FILES.get('file')
    if not uploaded_file:
        return JsonResponse({'error': 'No file uploaded'}, status=400)

    filename = uploaded_file.name or 'export_file'
    mime_type = uploaded_file.content_type

    try:
        import json
        from apps.core.watermark import embed_watermark
        metadata = {
            "uploaded_by": request.user.username,
            "export_format": filename.split('.')[-1].lower() if '.' in filename else 'bin',
            "source": "RakshaGIS/DEMAP",
            "client_exported": True
        }
        layers_raw = request.POST.get('layers')
        if layers_raw:
            try:
                metadata['layers'] = json.loads(layers_raw)
            except Exception:
                pass
        file_bytes = uploaded_file.read()
        watermarked_bytes = embed_watermark(file_bytes, filename, mime_type, metadata)

        response = HttpResponse(watermarked_bytes, content_type=mime_type)
        response['Content-Disposition'] = f'attachment; filename="{filename}"'
        response['Cache-Control'] = 'no-store'
        return response
    except Exception as exc:
        logger.exception("Failed to watermark client-exported file")
        return JsonResponse({'error': 'Watermarking failed', 'detail': str(exc)}, status=500)

