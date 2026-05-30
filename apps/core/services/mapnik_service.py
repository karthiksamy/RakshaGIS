import os
import logging
from typing import Optional, Tuple
from io import BytesIO
from django.conf import settings

logger = logging.getLogger(__name__)

try:
    import mapnik
    MAPNIK_AVAILABLE = True
except ImportError:
    MAPNIK_AVAILABLE = False
    logger.warning("Mapnik not installed. Install with: pip install mapnik")


class MapnikService:
    """High-performance map rendering using Mapnik

    Usage:
        service = MapnikService()
        service.load_style('boundaries')
        service.set_center_zoom(78.5, 20.5, 10)
        png_data = service.render_png(1200, 800)
    """

    def __init__(self):
        if not MAPNIK_AVAILABLE:
            raise RuntimeError(
                "Mapnik is not installed. "
                "Install with: pip install mapnik"
            )

        self.mapnik_path = os.path.join(
            settings.BASE_DIR, 'services', 'mapnik'
        )
        self.style_path = os.path.join(self.mapnik_path, 'styles')
        self.cache_path = os.path.join(self.mapnik_path, 'cache')
        self.map = None

        # Ensure directories exist
        os.makedirs(self.style_path, exist_ok=True)
        os.makedirs(self.cache_path, exist_ok=True)

    def load_style(self, style_name: str = 'boundaries'):
        """Load a Mapnik XML style"""
        xml_path = os.path.join(self.style_path, f'{style_name}.xml')

        if not os.path.exists(xml_path):
            raise FileNotFoundError(f"Style not found: {xml_path}")

        try:
            self.map = mapnik.Map(1200, 800)  # width x height
            mapnik.load_map(self.map, xml_path)
            mapnik.load_map_object(self.map)
            logger.info(f"Loaded style: {style_name}")
        except Exception as e:
            logger.error(f"Failed to load style {style_name}: {str(e)}")
            raise

    def set_bbox(self, bbox: Tuple[float, float, float, float]):
        """Set map bounding box (minx, miny, maxx, maxy)"""
        if not self.map:
            self.load_style()

        try:
            minx, miny, maxx, maxy = bbox
            box = mapnik.Box2d(minx, miny, maxx, maxy)
            self.map.zoom_to_box(box)
            logger.info(f"Set bbox: {bbox}")
        except Exception as e:
            logger.error(f"Failed to set bbox: {str(e)}")
            raise

    def set_center_zoom(self, center_lon: float, center_lat: float, zoom: int):
        """Set map center and zoom level (Web Mercator)"""
        if not self.map:
            self.load_style()

        try:
            # Zoom level to resolution (Web Mercator)
            # Resolution = 40075016.6 / (256 * 2^zoom)
            resolution = 40075016.6 / (256 * (2 ** zoom))

            # Calculate bounding box around center
            width_degrees = (1200 * resolution) / 111320  # meters per degree
            height_degrees = (800 * resolution) / 111320

            box = mapnik.Box2d(
                center_lon - width_degrees / 2,
                center_lat - height_degrees / 2,
                center_lon + width_degrees / 2,
                center_lat + height_degrees / 2,
            )
            self.map.zoom_to_box(box)
            logger.info(f"Set center: ({center_lon}, {center_lat}), zoom: {zoom}")
        except Exception as e:
            logger.error(f"Failed to set center/zoom: {str(e)}")
            raise

    def render_png(self, width: int = 1200, height: int = 800) -> bytes:
        """Render map to PNG

        Args:
            width: Image width in pixels (default 1200, max 4000)
            height: Image height in pixels (default 800, max 3000)

        Returns:
            PNG image data as bytes
        """
        if not self.map:
            self.load_style()

        try:
            # Constrain dimensions
            width = max(400, min(width, 4000))
            height = max(300, min(height, 3000))

            self.map.width = width
            self.map.height = height

            img = mapnik.Image(width, height)
            mapnik.render(self.map, img)

            result = img.tostring('png')
            logger.info(f"Rendered PNG: {width}x{height} ({len(result)} bytes)")
            return result
        except Exception as e:
            logger.error(f"Failed to render PNG: {str(e)}")
            raise

    def render_json(self) -> str:
        """Render map to GeoJSON feature collection"""
        if not self.map:
            self.load_style()

        try:
            import json
            features = []
            for layer in self.map.layers:
                # Collect layer info
                features.append({
                    'type': 'Feature',
                    'properties': {
                        'name': layer.name,
                        'visible': layer.is_visible(),
                        'opacity': layer.opacity,
                    },
                    'geometry': None
                })

            result = {
                'type': 'FeatureCollection',
                'features': features,
                'srs': self.map.srs
            }
            logger.info(f"Rendered GeoJSON with {len(features)} features")
            return json.dumps(result)
        except Exception as e:
            logger.error(f"Failed to render GeoJSON: {str(e)}")
            raise


# Global instance
_mapnik_service: Optional[MapnikService] = None

def get_mapnik_service() -> MapnikService:
    """Get or create global Mapnik service instance"""
    global _mapnik_service
    if _mapnik_service is None:
        try:
            _mapnik_service = MapnikService()
        except RuntimeError as e:
            logger.error(f"Mapnik service unavailable: {e}")
            raise
    return _mapnik_service
