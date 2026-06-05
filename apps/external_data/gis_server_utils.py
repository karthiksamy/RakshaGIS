"""
Utilities for connecting to external GIS servers:
  - WMS / WFS / WMTS (GeoServer, MapServer, QGIS Server, any OGC service)
  - ArcGIS REST (Feature Service, Map Service)

Vector protocols (WFS, ArcGIS Feature) are proxied as GeoJSON.
Raster protocols (WMS, WMTS, ArcGIS Map) return URL info for tile rendering.
"""
import json
import logging
import re
from typing import Any
from xml.etree import ElementTree as ET

import requests

logger = logging.getLogger(__name__)

REQUEST_TIMEOUT = 20  # seconds


def _session(connection) -> requests.Session:
    """Build a requests.Session with auth headers for the given connection."""
    s = requests.Session()
    s.headers.update(connection.auth_headers())
    return s


# ── Test connection ────────────────────────────────────────────────────────────

def test_gis_connection(connection) -> tuple[bool, str]:
    """
    Probe the GIS server and return (ok: bool, message: str).
    For OGC servers: issues a GetCapabilities request.
    For ArcGIS REST: hits the /info endpoint.
    """
    try:
        s = _session(connection)
        base = connection.base_url.rstrip('/')

        if connection.server_type == 'ARCGIS':
            r = s.get(f'{base}/info', params={'f': 'json'}, timeout=REQUEST_TIMEOUT)
            r.raise_for_status()
            info = r.json()
            version = info.get('currentVersion', '')
            return True, f'ArcGIS REST server reachable. Version: {version}'
        else:
            # WMS GetCapabilities as liveness probe
            r = s.get(base, params={
                'SERVICE': 'WMS', 'REQUEST': 'GetCapabilities',
            }, timeout=REQUEST_TIMEOUT)
            r.raise_for_status()
            if 'WMS_Capabilities' in r.text or 'WMT_MS_Capabilities' in r.text or '<Layer' in r.text:
                return True, f'OGC server reachable. Content-Type: {r.headers.get("Content-Type","")}'
            return True, 'Server responded but could not confirm OGC capabilities.'
    except requests.exceptions.ConnectionError as exc:
        return False, f'Connection refused: {exc}'
    except requests.exceptions.Timeout:
        return False, 'Request timed out.'
    except Exception as exc:
        return False, str(exc)


# ── GetCapabilities layer discovery ───────────────────────────────────────────

def get_wms_layers(connection) -> list[dict]:
    """Return a list of WMS layers from the server's GetCapabilities document."""
    s = _session(connection)
    base = connection.base_url.rstrip('/')
    r = s.get(base, params={'SERVICE': 'WMS', 'REQUEST': 'GetCapabilities'}, timeout=REQUEST_TIMEOUT)
    r.raise_for_status()
    try:
        root = ET.fromstring(r.content)
    except ET.ParseError as exc:
        raise ValueError(f'Could not parse WMS GetCapabilities XML: {exc}')

    ns = _xml_ns(root.tag)
    layers: list[dict] = []

    def _walk(node):
        name_el = node.find(f'{ns}Name')
        title_el = node.find(f'{ns}Title')
        name  = name_el.text.strip() if name_el is not None and name_el.text else ''
        title = title_el.text.strip() if title_el is not None and title_el.text else name
        if name:
            layers.append({'name': name, 'title': title, 'protocol': 'WMS'})
        for child in node.findall(f'{ns}Layer'):
            _walk(child)

    # Capability → Layer container
    cap = root.find(f'{ns}Capability') or root
    for layer_el in cap.findall(f'{ns}Layer'):
        _walk(layer_el)

    return layers


def get_wfs_layers(connection) -> list[dict]:
    """Return a list of WFS feature types."""
    s = _session(connection)
    base = connection.base_url.rstrip('/')
    r = s.get(base, params={'SERVICE': 'WFS', 'REQUEST': 'GetCapabilities'}, timeout=REQUEST_TIMEOUT)
    r.raise_for_status()
    try:
        root = ET.fromstring(r.content)
    except ET.ParseError as exc:
        raise ValueError(f'Could not parse WFS GetCapabilities XML: {exc}')

    ns = _xml_ns(root.tag)
    layers: list[dict] = []
    # FeatureTypeList > FeatureType
    ft_list = root.find(f'.//{ns}FeatureTypeList') or root.find('.//FeatureTypeList')
    if ft_list is None:
        return layers
    for ft in ft_list.findall(f'{ns}FeatureType') or ft_list.findall('FeatureType'):
        name_el  = ft.find(f'{ns}Name')  or ft.find('Name')
        title_el = ft.find(f'{ns}Title') or ft.find('Title')
        name  = (name_el.text or '').strip() if name_el is not None else ''
        title = (title_el.text or name).strip() if title_el is not None else name
        if name:
            layers.append({'name': name, 'title': title, 'protocol': 'WFS'})
    return layers


def get_arcgis_layers(connection) -> list[dict]:
    """Return a flat list of all layers from an ArcGIS REST server."""
    s = _session(connection)
    base = connection.base_url.rstrip('/')
    # Hit the root to get services
    results: list[dict] = []
    try:
        r = s.get(base, params={'f': 'json'}, timeout=REQUEST_TIMEOUT)
        r.raise_for_status()
        data = r.json()
    except Exception as exc:
        raise ValueError(f'Could not query ArcGIS REST endpoint: {exc}')

    services = data.get('services', []) or data.get('layers', [])
    if not services:
        # Single service endpoint — query its layers directly
        try:
            lr = s.get(f'{base}/layers', params={'f': 'json'}, timeout=REQUEST_TIMEOUT)
            lr.raise_for_status()
            for lyr in lr.json().get('layers', []):
                results.append({
                    'name': str(lyr.get('id', '')),
                    'title': lyr.get('name', str(lyr.get('id', ''))),
                    'protocol': 'ARCGIS_FEATURE',
                    'geometry_type': lyr.get('geometryType', ''),
                })
        except Exception:
            pass
        return results

    for svc in services:
        svc_name = svc.get('name', '')
        svc_type = svc.get('type', '')
        if svc_type not in ('MapServer', 'FeatureServer', 'FeatureLayer', ''):
            continue
        proto = 'ARCGIS_FEATURE' if 'Feature' in svc_type else 'ARCGIS_MAP'
        results.append({'name': svc_name, 'title': svc_name, 'protocol': proto})
    return results


def discover_layers(connection) -> list[dict]:
    """Auto-discover available layers from the server based on its type."""
    stype = connection.server_type
    layers = []
    if stype == 'ARCGIS':
        layers = get_arcgis_layers(connection)
    else:
        # Try WMS first, then WFS
        try:
            layers += get_wms_layers(connection)
        except Exception as exc:
            logger.warning('WMS discovery failed for %s: %s', connection, exc)
        try:
            layers += get_wfs_layers(connection)
        except Exception as exc:
            logger.warning('WFS discovery failed for %s: %s', connection, exc)
    return layers


# ── Feature fetching (vector proxy) ───────────────────────────────────────────

def fetch_wfs_geojson(layer, bbox=None, limit=10000) -> dict:
    """
    Fetch features from a WFS layer and return a GeoJSON FeatureCollection dict.
    """
    connection = layer.connection
    s = _session(connection)
    base = connection.base_url.rstrip('/')
    params: dict[str, Any] = {
        'SERVICE':     'WFS',
        'VERSION':     layer.wfs_version or '2.0.0',
        'REQUEST':     'GetFeature',
        'TYPENAMES':   layer.layer_name,
        'OUTPUTFORMAT': layer.wfs_output_fmt or 'application/json',
        'COUNT':       limit,
    }
    if bbox:
        params['BBOX'] = ','.join(str(v) for v in bbox) + ',EPSG:4326'
    r = s.get(base, params=params, timeout=REQUEST_TIMEOUT)
    r.raise_for_status()
    ct = r.headers.get('Content-Type', '')
    if 'json' in ct or 'geojson' in ct:
        return r.json()
    # Some servers return GML even when JSON requested — attempt to convert
    raise ValueError(f'WFS server returned non-JSON response (Content-Type: {ct}). '
                     'Try setting wfs_output_fmt to a supported format.')


def fetch_arcgis_geojson(layer, bbox=None, limit=2000) -> dict:
    """
    Fetch features from an ArcGIS Feature Service layer and return GeoJSON.
    """
    connection = layer.connection
    s = _session(connection)
    base = connection.base_url.rstrip('/')
    # layer_name is the layer path relative to base_url (e.g. "MyService/FeatureServer/0")
    layer_path = layer.layer_name.strip('/')
    suffix = (layer.arcgis_query_suffix or '/query').strip('/')
    url = f'{base}/{layer_path}/{suffix}'

    params: dict[str, Any] = {
        'where':     '1=1',
        'outFields': '*',
        'f':         'geojson',
        'resultRecordCount': limit,
    }
    if bbox:
        params['geometry'] = f'{bbox[0]},{bbox[1]},{bbox[2]},{bbox[3]}'
        params['geometryType'] = 'esriGeometryEnvelope'
        params['inSR'] = '4326'
        params['spatialRel'] = 'esriSpatialRelIntersects'

    r = s.get(url, params=params, timeout=REQUEST_TIMEOUT)
    r.raise_for_status()
    data = r.json()
    # ArcGIS may return {error: ...}
    if 'error' in data:
        raise ValueError(f'ArcGIS query error: {data["error"]}')
    return data


def fetch_vector_features(layer, bbox=None, limit=10000) -> dict:
    """
    Dispatch to the correct vector fetch function based on layer.protocol.
    Returns a GeoJSON FeatureCollection dict.
    """
    if layer.protocol == 'WFS':
        return fetch_wfs_geojson(layer, bbox=bbox, limit=limit)
    if layer.protocol == 'ARCGIS_FEATURE':
        return fetch_arcgis_geojson(layer, bbox=bbox, limit=min(limit, 2000))
    raise ValueError(f'Protocol {layer.protocol!r} is not a vector protocol.')


# ── Helper: WMS tile URL info ──────────────────────────────────────────────────

def wms_tile_config(layer) -> dict:
    """
    Return the config needed by OpenLayers TileWMS to render this layer.
    The frontend uses this to construct a TileLayer source directly.
    """
    connection = layer.connection
    headers = connection.auth_headers()
    return {
        'url':     connection.base_url.rstrip('/'),
        'params': {
            'LAYERS':  layer.layer_name,
            'VERSION': layer.wms_version or '1.1.1',
            'FORMAT':  layer.wms_format or 'image/png',
            'TRANSPARENT': 'TRUE',
            **(layer.wms_params or {}),
        },
        'cross_origin': 'anonymous',
        'auth_headers': headers,  # for informational use; browser can't inject these
    }


# ── XML namespace helper ───────────────────────────────────────────────────────

def _xml_ns(tag: str) -> str:
    """Extract namespace prefix from an XML tag like '{http://...}Root'."""
    m = re.match(r'\{(.+?)\}', tag)
    return f'{{{m.group(1)}}}' if m else ''
