"""
Fetch adapters for each revenue portal type.

Each adapter accepts a RevenuePortalConnector + DefenceParcel and returns a
list of normalised revenue records:
  { survey_number, owner, area_ha, land_type, geometry_geojson, raw }

All portal URLs, layer names, field mappings and query parameters come from
the connector model — nothing is hard-coded.
"""
from __future__ import annotations

import json
import logging
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .models import RevenuePortalConnector
    from apps.survey_projects.models import DefenceParcel

logger = logging.getLogger(__name__)

_TIMEOUT = 25  # seconds per HTTP request


# ── Public entry points ────────────────────────────────────────────────────────

def fetch_for_parcel(connector: 'RevenuePortalConnector',
                     parcel: 'DefenceParcel') -> list[dict]:
    """Dispatch to the correct fetch adapter; return normalised revenue records."""
    dispatch = {
        'DILRMP_WFS': _fetch_wfs,
        'BHUVAN_WFS': _fetch_wfs,
        'STATE_WFS':  _fetch_wfs,
        'BHU_NAKSHA': _fetch_bhu_naksha,
        'STATE_REST': _fetch_arcgis_rest,
    }
    fn = dispatch.get(connector.portal_type)
    if fn is None:
        raise ValueError(f'Unknown portal_type: {connector.portal_type}')
    return fn(connector, parcel)


def test_connector(connector: 'RevenuePortalConnector') -> tuple[bool, str]:
    """Probe the configured endpoint and return (success: bool, message: str)."""
    import httpx
    headers  = _build_headers(connector)
    auth_p   = _build_auth_params(connector)
    ptype    = connector.portal_type

    try:
        if ptype == 'BHU_NAKSHA':
            # Hit a lightweight info path; the exact path varies by deployment
            # so we just verify the base URL is reachable.
            url = connector.base_url.rstrip('/')
            r = httpx.get(url, headers=headers, params=auth_p,
                          timeout=_TIMEOUT, follow_redirects=True)
        elif ptype == 'STATE_REST':
            # ArcGIS: /query?where=1=0&f=json — minimal round-trip
            url = connector.base_url.rstrip('/') + '/query'
            r = httpx.get(url, headers=headers,
                          params=dict(auth_p, where='1=0', f='json'),
                          timeout=_TIMEOUT, follow_redirects=True)
        else:
            # WFS: GetCapabilities
            extra   = connector.extra_params or {}
            version = extra.get('version', '1.1.0')
            r = httpx.get(
                connector.base_url,
                headers=headers,
                params=dict(auth_p, service='WFS', version=version,
                            request='GetCapabilities'),
                timeout=_TIMEOUT, follow_redirects=True,
            )
        if r.status_code == 200:
            return True, f'HTTP 200 — {len(r.content):,} bytes received'
        return False, f'HTTP {r.status_code}: {r.text[:200]}'
    except Exception as exc:
        return False, str(exc)


def cross_reference_parcel(parcel: 'DefenceParcel',
                            connectors=None) -> dict:
    """
    Run all active connectors for a parcel, upsert ParcelRevenueLink rows.
    Returns a summary dict.
    """
    from .models import RevenuePortalConnector, ParcelRevenueLink

    if connectors is None:
        connectors = list(
            RevenuePortalConnector.objects.filter(
                is_active=True,
                organisation=parcel.organisation,
            )
        )

    created = updated = skipped = errors = 0

    for conn in connectors:
        try:
            records = fetch_for_parcel(conn, parcel)
            for rec in records:
                sn = (rec.get('survey_number') or '').strip()
                if not sn:
                    skipped += 1
                    continue
                overlap_ha, overlap_pct = _compute_overlap(rec, parcel)
                discrepancy, disc_notes = _check_discrepancy(rec, parcel, overlap_ha)
                _, new = ParcelRevenueLink.objects.update_or_create(
                    defence_parcel=parcel,
                    connector=conn,
                    remote_survey_number=sn,
                    defaults={
                        'remote_owner':      (rec.get('owner') or '')[:500],
                        'remote_area_ha':    rec.get('area_ha'),
                        'remote_land_type':  (rec.get('land_type') or '')[:300],
                        'raw_attributes':    rec.get('raw') or {},
                        'overlap_area_ha':   overlap_ha,
                        'overlap_pct':       overlap_pct,
                        'discrepancy_flag':  discrepancy,
                        'discrepancy_notes': disc_notes,
                    },
                )
                if new:
                    created += 1
                else:
                    updated += 1
        except Exception as exc:
            logger.error('cross_reference_parcel connector=%s parcel=%s: %s',
                         conn.id, parcel.id, exc, exc_info=True)
            errors += 1

    return {
        'parcel_id':       parcel.id,
        'connectors_run':  len(connectors),
        'links_created':   created,
        'links_updated':   updated,
        'records_skipped': skipped,
        'errors':          errors,
    }


# ── WFS adapter ───────────────────────────────────────────────────────────────

def _fetch_wfs(connector: 'RevenuePortalConnector',
               parcel: 'DefenceParcel') -> list[dict]:
    """OGC WFS 1.x / 2.0 GetFeature with BBOX derived from the parcel geometry."""
    import httpx
    extra   = connector.extra_params or {}
    version = extra.get('version', '1.1.0')
    max_f   = extra.get('max_features', 500)
    fmt     = extra.get('output_format', 'application/json')

    query = {
        'service':      'WFS',
        'version':      version,
        'request':      'GetFeature',
        'typeName':     connector.layer_name,
        'outputFormat': fmt,
        'BBOX':         _bbox_str(parcel, version),
        'srsName':      'EPSG:4326',
    }
    if version.startswith('2'):
        query['count'] = str(max_f)
    else:
        query['maxFeatures'] = str(max_f)

    query.update(_build_auth_params(connector))

    headers = _build_headers(connector)
    headers['Accept'] = 'application/json, text/xml;q=0.9'

    try:
        r = httpx.get(connector.base_url, params=query, headers=headers,
                      timeout=_TIMEOUT, follow_redirects=True)
        r.raise_for_status()
    except Exception as exc:
        logger.warning('WFS fetch failed connector=%s: %s', connector.id, exc)
        return []

    return _parse_geojson_response(r.content, extra)


# ── Bhu-Naksha REST adapter ───────────────────────────────────────────────────

def _fetch_bhu_naksha(connector: 'RevenuePortalConnector',
                      parcel: 'DefenceParcel') -> list[dict]:
    """
    Bhu-Naksha NIC cadastral REST API.

    Village/taluk/district codes drive the query; they are read from
    extra_params (user-configured).  The parcel's own village FK is used
    as a fallback to populate missing codes from the admin hierarchy's
    `code` fields.
    """
    import httpx
    extra   = connector.extra_params or {}
    headers = _build_headers(connector)
    auth_p  = _build_auth_params(connector)
    base    = connector.base_url.rstrip('/')

    state_code    = extra.get('state_code', '')
    district_code = extra.get('district_code', '')
    taluk_code    = extra.get('taluk_code', '')
    village_code  = extra.get('village_code', '')

    # Fall back to admin hierarchy codes on the parcel if not configured
    if not village_code and parcel.village_id:
        try:
            v = parcel.village
            village_code  = v.code or ''
            taluk_code    = taluk_code  or (v.taluk.code  if v.taluk_id  else '')
            district_code = district_code or (v.taluk.district.code if v.taluk_id else '')
        except Exception:
            pass
    if not district_code and parcel.district_id:
        try:
            district_code = parcel.district.code or ''
        except Exception:
            pass

    if not state_code:
        logger.warning('Bhu-Naksha connector %s: state_code missing in extra_params',
                       connector.id)
        return []

    # The query endpoint and parameter names are also user-configurable via
    # extra_params["api_path"] and extra_params["param_names"]
    api_path    = extra.get('api_path', '/api/map/getData')
    param_names = extra.get('param_names', {})
    qp = dict(auth_p, **{
        param_names.get('state_code',    'stateCode'):    state_code,
        param_names.get('district_code', 'districtCode'): district_code,
        param_names.get('taluk_code',    'tahsilCode'):   taluk_code,
        param_names.get('village_code',  'villageCode'):  village_code,
        param_names.get('type',          'type'):         extra.get('type', '0'),
    })

    try:
        r = httpx.get(f'{base}{api_path}', params=qp, headers=headers,
                      timeout=_TIMEOUT, follow_redirects=True)
        r.raise_for_status()
        data = r.json()
    except Exception as exc:
        logger.warning('Bhu-Naksha fetch failed connector=%s: %s', connector.id, exc)
        return []

    features = data if isinstance(data, list) else data.get('features', [])
    field_map = extra  # field override keys sit directly in extra_params

    records = []
    for feat in features:
        props = (feat.get('properties') or feat) if isinstance(feat, dict) else {}
        geom  = feat.get('geometry') if isinstance(feat, dict) else None
        records.append({
            'survey_number':    _pick(props, field_map.get('survey_number_fields',
                                     ['plot_no', 'survey_no', 'khata_no', 'parcel_no'])),
            'owner':            _pick(props, field_map.get('owner_fields',
                                     ['owner', 'khatedar', 'pattadar', 'malik_naam'])),
            'area_ha':          _pick_float(props, field_map.get('area_fields',
                                            ['area', 'area_ha', 'area_hectare'])),
            'land_type':        _pick(props, field_map.get('land_type_fields',
                                     ['land_type', 'bhumi_prakar', 'type', 'use'])),
            'geometry_geojson': geom,
            'raw':              props,
        })
    return _filter_by_bbox(records, parcel)


# ── ArcGIS / generic REST adapter ─────────────────────────────────────────────

def _fetch_arcgis_rest(connector: 'RevenuePortalConnector',
                       parcel: 'DefenceParcel') -> list[dict]:
    """ArcGIS Feature Service REST /query with envelope geometry filter."""
    import httpx
    extra   = connector.extra_params or {}
    headers = _build_headers(connector)
    auth_p  = _build_auth_params(connector)

    minx, miny, maxx, maxy = parcel.geometry.extent
    qp = dict(auth_p, **{
        'geometry':          f'{minx},{miny},{maxx},{maxy}',
        'geometryType':      'esriGeometryEnvelope',
        'inSR':              '4326',
        'spatialRel':        'esriSpatialRelIntersects',
        'outFields':         extra.get('out_fields', '*'),
        'returnGeometry':    'true',
        'outSR':             '4326',
        'f':                 'geojson',
        'resultRecordCount': str(extra.get('result_record_count', 1000)),
    })

    url = connector.base_url.rstrip('/') + '/query'
    try:
        r = httpx.get(url, params=qp, headers=headers,
                      timeout=_TIMEOUT, follow_redirects=True)
        r.raise_for_status()
        data = r.json()
    except Exception as exc:
        logger.warning('ArcGIS REST fetch failed connector=%s: %s', connector.id, exc)
        return []

    field_map = extra.get('field_map', {})
    records   = []
    for feat in data.get('features', []):
        props = feat.get('properties') or {}
        geom  = feat.get('geometry')
        records.append({
            'survey_number': (props.get(field_map.get('survey_number', ''))
                              or _pick(props, extra.get('survey_number_fields',
                                       ['plot_no', 'survey_no', 'parcel_id']))),
            'owner':         (props.get(field_map.get('owner', ''))
                              or _pick(props, extra.get('owner_fields',
                                       ['owner', 'owner_name', 'malik']))),
            'area_ha':       (_pick_float(props, [field_map.get('area_ha', '')])
                              or _pick_float(props, extra.get('area_fields',
                                             ['area', 'area_ha', 'hectare']))),
            'land_type':     (props.get(field_map.get('land_type', ''))
                              or _pick(props, extra.get('land_type_fields',
                                       ['land_use', 'type', 'use_type']))),
            'geometry_geojson': geom,
            'raw':           props,
        })
    return records


# ── Cross-reference helpers ────────────────────────────────────────────────────

def _compute_overlap(rec: dict,
                     parcel: 'DefenceParcel') -> tuple[float | None, float | None]:
    """Compute intersection area (ha) and overlap % against the defence parcel."""
    geom_json = rec.get('geometry_geojson')
    if not geom_json:
        return None, None
    try:
        from django.contrib.gis.geos import GEOSGeometry
        remote = GEOSGeometry(json.dumps(geom_json), srid=4326)
        if not remote.valid:
            remote = remote.buffer(0)
        inter = parcel.geometry.intersection(remote)
        if inter.empty:
            return 0.0, 0.0
        c    = inter.centroid
        zone = min(max(int((c.x + 180) / 6) + 1, 1), 60)
        epsg = 32600 + zone
        overlap_m2 = inter.transform(epsg, clone=True).area
        remote_m2  = remote.transform(epsg, clone=True).area
        overlap_ha  = round(overlap_m2 / 10000, 4)
        overlap_pct = round(overlap_m2 / max(remote_m2, 0.01) * 100, 2)
        return overlap_ha, overlap_pct
    except Exception as exc:
        logger.debug('overlap computation failed: %s', exc)
        return None, None


def _check_discrepancy(rec: dict,
                       parcel: 'DefenceParcel',
                       overlap_ha: float | None) -> tuple[bool, str]:
    """
    Flag a discrepancy when the remote record suggests the land may not be
    in MoD / GoI ownership, or when geometry / area diverge significantly.
    """
    notes = []
    owner = (rec.get('owner') or '').lower()

    govt_kw = ('government', 'govt', 'mod', 'ministry of defence', 'defence',
               'military', 'army', 'navy', 'air force', 'cantonment', 'dgde',
               'central govt', 'union of india', 'president of india',
               'raksha', 'bharat sarkar', 'केंद्र सरकार')
    if owner and not any(kw in owner for kw in govt_kw):
        notes.append(f'Remote owner "{rec["owner"]}" may not be MoD/GoI.')

    if overlap_ha == 0:
        notes.append('No spatial overlap detected with defence parcel geometry.')

    remote_area = rec.get('area_ha')
    if remote_area and parcel.area_hectares:
        diff_pct = (abs(float(remote_area) - float(parcel.area_hectares))
                    / float(parcel.area_hectares) * 100)
        if diff_pct > 20:
            notes.append(
                f'Area mismatch: remote {float(remote_area):.2f} ha vs '
                f'RakshaGIS {float(parcel.area_hectares):.2f} ha '
                f'({diff_pct:.0f}% difference).'
            )
    return bool(notes), ' '.join(notes)


# ── HTTP helpers ───────────────────────────────────────────────────────────────

def _build_headers(connector: 'RevenuePortalConnector') -> dict:
    h = {'User-Agent': 'RakshaGIS-RevenueConnector/1.0', 'Accept': 'application/json'}
    if connector.auth_type == 'BEARER':
        h['Authorization'] = f'Bearer {connector.api_key}'
    elif connector.auth_type == 'BASIC':
        import base64
        cred = base64.b64encode(
            f'{connector.username}:{connector.password}'.encode()
        ).decode()
        h['Authorization'] = f'Basic {cred}'
    return h


def _build_auth_params(connector: 'RevenuePortalConnector') -> dict:
    if connector.auth_type == 'API_KEY':
        key_name = (connector.extra_params or {}).get('api_key_param', 'api_key')
        return {key_name: connector.api_key}
    return {}


def _bbox_str(parcel: 'DefenceParcel', version: str) -> str:
    """BBOX string in the correct axis-order for the WFS version."""
    minx, miny, maxx, maxy = parcel.geometry.extent
    if version.startswith('2'):
        return f'{miny},{minx},{maxy},{maxx},urn:ogc:def:crs:EPSG::4326'
    return f'{minx},{miny},{maxx},{maxy},EPSG:4326'


# ── GeoJSON / GML parsers ──────────────────────────────────────────────────────

def _parse_geojson_response(content: bytes, extra: dict) -> list[dict]:
    """Parse WFS response (GeoJSON preferred, GML fallback)."""
    try:
        data     = json.loads(content)
        features = data.get('features') or []
    except (json.JSONDecodeError, ValueError):
        features = _parse_gml_features(content)

    return [
        {
            'survey_number':    _pick(f.get('properties') or {},
                                     extra.get('survey_number_fields',
                                               ['survey_no', 'survey_number', 'plot_no',
                                                'khasra_no', 'khata_no', 'parcel_id'])),
            'owner':            _pick(f.get('properties') or {},
                                     extra.get('owner_fields',
                                               ['owner', 'owner_name', 'khatedar',
                                                'malik_naam', 'pattadar_nm'])),
            'area_ha':          _pick_float(f.get('properties') or {},
                                            extra.get('area_fields',
                                                      ['area', 'area_ha', 'area_hectare',
                                                       'extent_ha', 'tot_area'])),
            'land_type':        _pick(f.get('properties') or {},
                                     extra.get('land_type_fields',
                                               ['land_type', 'land_use', 'type',
                                                'classification', 'bhumi_prakar'])),
            'geometry_geojson': f.get('geometry'),
            'raw':              f.get('properties') or {},
        }
        for f in features
    ]


def _parse_gml_features(content: bytes) -> list[dict]:
    """Minimal GML parser: extract properties only (no geometry)."""
    try:
        import xml.etree.ElementTree as ET
        root     = ET.fromstring(content)
        features = []
        for member in root.iter():
            if member.tag.endswith('}featureMember') or member.tag.endswith('}member'):
                for child in member:
                    props = {
                        (t.tag.split('}')[-1] if '}' in t.tag else t.tag): (t.text or '').strip()
                        for t in child
                    }
                    if props:
                        features.append({'properties': props, 'geometry': None})
        return features
    except Exception:
        return []


# ── Utility ────────────────────────────────────────────────────────────────────

def _pick(d: dict, keys: list[str]) -> str:
    low = {str(k).lower(): v for k, v in d.items()}
    for k in keys:
        v = low.get(k.lower())
        if v not in (None, ''):
            return str(v)
    return ''


def _pick_float(d: dict, keys: list[str]) -> float | None:
    low = {str(k).lower(): v for k, v in d.items()}
    for k in keys:
        if not k:
            continue
        v = low.get(k.lower())
        f = _to_float(v)
        if f is not None:
            return f
    return None


def _to_float(v) -> float | None:
    if v is None:
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _filter_by_bbox(records: list[dict], parcel: 'DefenceParcel') -> list[dict]:
    """Keep only records whose geometry bbox overlaps the parcel bbox."""
    minx, miny, maxx, maxy = parcel.geometry.extent
    out = []
    for rec in records:
        geom = rec.get('geometry_geojson')
        if not geom:
            out.append(rec)
            continue
        try:
            coords = _flatten_coords(geom)
            if any(minx <= lon <= maxx and miny <= lat <= maxy for lon, lat in coords):
                out.append(rec)
        except Exception:
            out.append(rec)
    return out


def _flatten_coords(geom: dict) -> list[tuple[float, float]]:
    flat = []
    def _r(c):
        if not c:
            return
        if isinstance(c[0], (int, float)):
            flat.append((float(c[0]), float(c[1])))
        else:
            for item in c:
                _r(item)
    _r(geom.get('coordinates', []))
    return flat
