"""
Defence Land Proximity Analysis
================================
Checks an uploaded TemporaryLayer against existing survey features stored in
`survey_projects_gisfeature` (the GISFeature table in the current PostGIS DB).

The analysis identifies whether the uploaded geometry:
  - FALLS_WITHIN : intersects one or more GISFeature polygons
  - NEARBY       : lies within BUFFER_KM of a GISFeature polygon but doesn't intersect
  - CLEAR        : no GISFeature polygons found within BUFFER_KM

Results are cached on the TemporaryLayer.analysis_result field and can be
rendered to PDF via the Playwright print service.
"""

from __future__ import annotations

import html as _html
import json
import logging
import math
from datetime import date
from typing import TYPE_CHECKING

logger = logging.getLogger(__name__)

if TYPE_CHECKING:
    from .models import TemporaryLayer

DEFAULT_BUFFER_M = 1000
VALID_BUFFER_M   = [50, 100, 200, 500, 1000, 2000, 5000, 10000, 25000, 50000, 100000]


# ── Helpers ───────────────────────────────────────────────────────────────────

def _union_geojson(geojson: dict):
    """Return a GEOSGeometry union of all features in a GeoJSON FeatureCollection."""
    from django.contrib.gis.geos import GEOSGeometry

    features = geojson.get('features', [])
    if not features:
        raise ValueError('GeoJSON has no features')

    union = None
    for feat in features:
        geom_str = json.dumps(feat.get('geometry', {}))
        try:
            g = GEOSGeometry(geom_str, srid=4326)
        except Exception:
            continue
        union = g if union is None else union.union(g)

    if union is None:
        raise ValueError('No valid geometries found in uploaded file')
    return union


def _feature_dict(feat, dist_m: float | None = None) -> dict:
    """Convert a GISFeature ORM object to a plain dict for the analysis result."""
    attrs = feat.attributes or {}
    d = {
        'id':         feat.id,
        'layer_name': feat.layer_name,
        'project':    feat.project.name if feat.project_id else '—',
        'project_id': feat.project_id,
        'attributes': {k: str(v)[:80] for k, v in list(attrs.items())[:8]},
    }
    if dist_m is not None:
        d['distance_m']  = round(dist_m, 0)
        d['distance_km'] = round(dist_m / 1000, 3)
    return d


# ── Folder-tree helpers ──────────────────────────────────────────────────────

def _get_folder_ids_for_survey_areas(survey_area_ids: list[int]) -> set[int]:
    """
    Return all ProjectLayerFolder IDs that belong to the given survey area IDs,
    including the root folder and all descendants.
    """
    from .models import SurveyArea, ProjectLayerFolder

    areas = SurveyArea.objects.filter(id__in=survey_area_ids, folder__isnull=False)
    root_ids = [a.folder_id for a in areas]
    all_ids: set[int] = set(root_ids)
    queue = list(root_ids)
    while queue:
        children = list(
            ProjectLayerFolder.objects
            .filter(parent_id__in=queue)
            .values_list('id', flat=True)
        )
        new = [c for c in children if c not in all_ids]
        all_ids.update(new)
        queue = new
    return all_ids


# ── External layer proximity check ───────────────────────────────────────────

def _check_external_layers(upload_geom, buffered, external_layer_ids=None, user=None,
                           upload_m=None, metric_srid=None) -> tuple[dict, dict]:
    """
    Check all active ExternalLayer records against the upload geometry.
    Fetches GeoJSON live from each external DB, reprojects to WGS84, and
    performs Python-side geometry operations via django.contrib.gis.geos.

    Returns two dicts: (intersecting_info, nearby_info)
      each with keys 'count' and 'features' (list of plain dicts).
    """
    from django.contrib.gis.geos import GEOSGeometry
    from apps.external_data.models import ExternalLayer
    from apps.external_data.db_utils import layer_geojson

    int_count   = 0
    near_count  = 0
    int_feats   = []
    near_feats  = []

    active_layers = ExternalLayer.objects.filter(is_active=True, database__is_active=True).select_related('database')
    if external_layer_ids is not None:
        active_layers = active_layers.filter(id__in=external_layer_ids)

    # Restrict the external DB query to the search envelope (buffered upload extent,
    # WGS84). Any feature that can intersect the upload or its buffer must lie inside
    # this bbox, so this is lossless for proximity — and it lets large layers (e.g.
    # GLR plans with tens of thousands of rows) use their spatial index instead of
    # returning an arbitrary truncated slice that omits the nearby features.
    try:
        xmin, ymin, xmax, ymax = buffered.extent  # (minLon, minLat, maxLon, maxLat)
        search_bbox = [xmin, ymin, xmax, ymax]
    except Exception:
        search_bbox = None

    for ext_layer in active_layers:
        try:
            # Passing user applies the same per-level office filtering used in the
            # map viewer: DGDE/superadmin → all rows; others → own office subtree.
            fc = layer_geojson(ext_layer, limit=10_000, user=user, bbox=search_bbox)
        except Exception as exc:
            logger.warning('External layer %s query failed during analysis: %s', ext_layer, exc)
            continue

        for feat in fc.get('features', []):
            geom_json = feat.get('geometry')
            if not geom_json:
                continue
            try:
                geom = GEOSGeometry(json.dumps(geom_json), srid=4326)
            except Exception:
                continue

            props = feat.get('properties') or {}
            label_col = ext_layer.label_column
            label = str(props.get(label_col, '')) if label_col else ext_layer.display_name

            # Use superadmin-configured analysis columns if set, else first 5
            analysis_cols = ext_layer.analysis_columns or []
            if analysis_cols:
                attr_items = [(k, props[k]) for k in analysis_cols if k in props]
            else:
                attr_items = list(props.items())[:5]

            if upload_geom.intersects(geom):
                int_count += 1
                int_feats.append({
                    'id':         f'ext:{ext_layer.id}',
                    'layer_name': ext_layer.display_name,
                    'project':    f'External: {ext_layer.database.name}',
                    'project_id': None,
                    'label':      label[:80],
                    'attributes': {k: str(v)[:80] for k, v in attr_items},
                    # Geometry retained so the report map can draw external features.
                    'geometry':   geom_json,
                })
                if int_count >= 20:
                    break
            elif buffered.intersects(geom):
                dist_m = None
                try:
                    if metric_srid is not None and upload_m is not None:
                        # Exact distance in metres via the projected geometries.
                        geom_m = geom.transform(metric_srid, clone=True)
                        dist_m = upload_m.distance(geom_m)
                    else:
                        dist_m = upload_geom.distance(geom) * 111_000  # fallback approx
                except Exception:
                    dist_m = None
                near_count += 1
                near_feats.append({
                    'id':          f'ext:{ext_layer.id}',
                    'layer_name':  ext_layer.display_name,
                    'project':     f'External: {ext_layer.database.name}',
                    'project_id':  None,
                    'label':       label[:80],
                    'attributes':  {k: str(v)[:80] for k, v in attr_items},
                    'distance_m':  round(dist_m, 0) if dist_m else None,
                    'distance_km': round(dist_m / 1000, 3) if dist_m else None,
                    'geometry':    geom_json,
                })

    return (
        {'count': int_count,  'features': int_feats[:20]},
        {'count': near_count, 'features': near_feats[:20]},
    )


# ── Core spatial analysis ─────────────────────────────────────────────────────

def _scope_survey_qs(qs, user):
    """
    Restrict a GISFeature queryset to what *user* may see, mirroring the
    Map Viewer's GISFeatureViewSet.get_queryset rules:
      - super admin / DGDE        → everything
      - PDDE                      → own command subtree
      - DEO                       → own office + subordinate offices' deo_visible data
      - CEO / ADEO / others       → own office only
      - explicit ProjectShare grants are always honoured
    user=None keeps the queryset unrestricted (internal/admin callers).
    """
    if user is None:
        return qs
    from django.db.models import Q
    from apps.accounts.permissions import (
        org_queryset_filter, deo_subordinate_org_ids, get_shared_project_ids,
    )
    if getattr(user, 'is_superadmin', False) or getattr(user, 'role', '') == 'SUPERADMIN':
        return qs
    own = org_queryset_filter(user, qs, org_field='project__organisation')
    if getattr(user, 'role', '') == 'PDDE_VIEWER':
        return own
    extra = Q(pk__in=[])
    shared_ids = get_shared_project_ids(user)
    if shared_ids:
        extra |= Q(project_id__in=shared_ids)
    deo_sub_ids = deo_subordinate_org_ids(user)
    if deo_sub_ids:
        extra |= Q(project__organisation_id__in=deo_sub_ids, deo_visible=True)
    return (own | qs.filter(extra)).distinct()


def run_defence_analysis(
    layer: 'TemporaryLayer',
    buffer_m: int = DEFAULT_BUFFER_M,
    survey_area_ids: 'list[int] | None' = None,
    external_layer_ids: 'list[int] | None' = None,
    user=None,
) -> dict:
    """
    Run spatial analysis for *layer*.

    buffer_m          : search radius in metres (must be in VALID_BUFFER_M).
    survey_area_ids   : None = all GISFeatures; [] = skip survey check;
                        [1,2] = only features in those survey areas.
    external_layer_ids: None = all active external layers; [] = skip external check;
                        [3,7] = only those specific external layers.
    user              : requesting user — scopes survey features and external-layer
                        rows to that user's jurisdiction (None = unrestricted).

    Returns a result dict with verdict, feature lists, and buffer_m included.
    """
    from .models import GISFeature
    from django.contrib.gis.db.models.functions import Distance as GeoDistance

    upload_geom = _union_geojson(layer.geojson)
    extent = list(upload_geom.extent)

    # Project to the UTM zone covering the upload's centroid so buffering and
    # distances are computed in true metres. A degree-space buffer (buffer_m/111000)
    # under-reaches by ~10-12% in the E-W direction at Indian latitudes, which makes
    # tight ranges (e.g. 50 m) miss features that are visibly within range.
    centroid = upload_geom.centroid
    utm_zone = int((centroid.x + 180) / 6) + 1
    metric_srid = 32600 + utm_zone            # WGS84 / UTM north (India is N hemisphere)
    upload_m = None
    try:
        upload_m = upload_geom.transform(metric_srid, clone=True)
    except Exception:
        metric_srid = None

    # Estimate area (polygon layers only)
    upload_area = None
    if upload_m is not None:
        try:
            upload_area = round(upload_m.area / 1_000_000, 4)   # m² → km²
        except Exception:
            pass

    # Accurate metric buffer, reprojected back to WGS84 for all spatial queries.
    if upload_m is not None:
        buffered = upload_m.buffer(buffer_m).transform(4326, clone=True)
    else:
        buffered = upload_geom.buffer(buffer_m / 111_000.0)  # fallback if projection fails

    intersecting_list  = []
    intersecting_count = 0
    nearby_list        = []
    nearby_count       = 0

    # ── Survey features (Defence Parcels / GISFeature) ────────────────────
    # survey_area_ids=[] means explicitly skip; None or non-empty list means run
    run_survey = survey_area_ids is None or len(survey_area_ids) > 0
    if run_survey:
        # Jurisdiction-scoped base queryset (own + permitted subordinate data).
        visible_qs = _scope_survey_qs(
            GISFeature.objects.filter(is_deleted=False), user
        ).select_related('project')
        survey_qs = visible_qs.filter(geometry__intersects=upload_geom)
        if survey_area_ids:  # non-None and non-empty → filter by folder tree
            folder_ids = _get_folder_ids_for_survey_areas(survey_area_ids)
            survey_qs = survey_qs.filter(folder_id__in=folder_ids)

        intersecting_list  = [_feature_dict(f) for f in survey_qs[:20]]
        intersecting_count = survey_qs.count()

        intersecting_ids = list(survey_qs.values_list('id', flat=True))
        nearby_base = (
            visible_qs
            .filter(geometry__intersects=buffered)
            .exclude(id__in=intersecting_ids)
        )
        if survey_area_ids:
            folder_ids = _get_folder_ids_for_survey_areas(survey_area_ids)
            nearby_base = nearby_base.filter(folder_id__in=folder_ids)

        nearby_qs = (
            nearby_base
            .annotate(dist=GeoDistance('geometry', upload_geom))
            .order_by('dist')
        )
        nearby_list  = [
            _feature_dict(f, f.dist.m if hasattr(f.dist, 'm') else None)
            for f in nearby_qs[:20]
        ]
        nearby_count = nearby_qs.count()

    # ── Active external DB layers ─────────────────────────────────────────
    # external_layer_ids=[] means explicitly skip; None or non-empty list means run
    run_external = external_layer_ids is None or len(external_layer_ids) > 0
    if run_external:
        ext_intersecting, ext_nearby = _check_external_layers(
            upload_geom, buffered, external_layer_ids=external_layer_ids, user=user,
            upload_m=upload_m, metric_srid=metric_srid,
        )
        intersecting_count += ext_intersecting['count']
        nearby_count       += ext_nearby['count']
        intersecting_list  += ext_intersecting['features']
        nearby_list        += ext_nearby['features']

    # ── Verdict ──────────────────────────────────────────────────────────
    buf_label = f'{buffer_m} m' if buffer_m < 1000 else f'{buffer_m // 1000} km'
    if intersecting_count > 0:
        verdict = 'FALLS_WITHIN'
        verdict_text = (
            f'The uploaded file FALLS WITHIN existing survey features '
            f'({intersecting_count} feature(s) intersect).'
        )
    elif nearby_count > 0:
        verdict = 'NEARBY'
        verdict_text = (
            f'The uploaded file does NOT intersect any survey feature, but is within '
            f'{buf_label} of {nearby_count} feature(s).'
        )
    else:
        verdict = 'CLEAR'
        verdict_text = (
            f'The uploaded file does NOT fall within or near any existing survey feature within {buf_label}.'
        )

    return {
        'verdict':               verdict,
        'verdict_text':          verdict_text,
        'intersecting_count':    intersecting_count,
        'nearby_count':          nearby_count,
        'intersecting_features': intersecting_list,
        'nearby_features':       nearby_list,
        'upload_extent':         extent,
        'upload_area_sqkm':      upload_area,
        'buffer_m':              buffer_m,
        'buffer_km':             buffer_m / 1000.0,
    }


def run_all_buffer_analyses(layer: 'TemporaryLayer',
                            buffer_values: list[int] | None = None) -> dict[str, dict]:
    """
    Run run_defence_analysis for each value in buffer_values.
    Returns a dict keyed by str(buffer_m): { result_dict }.
    Reuses the same upload_geom union across all runs for efficiency.
    """
    if buffer_values is None:
        buffer_values = VALID_BUFFER_M
    results: dict[str, dict] = {}
    for bm in buffer_values:
        try:
            results[str(bm)] = run_defence_analysis(layer, buffer_m=bm)
        except Exception as exc:
            logger.warning('Analysis failed for buffer %sm: %s', bm, exc)
    return results


# ── SVG map renderer ──────────────────────────────────────────────────────────

def _geom_to_svg_paths(geom_json: dict, to_svg, fill: str, stroke: str,
                        opacity: float = 0.45, sw: float = 1.0) -> str:
    def ring_to_points(ring):
        pts = []
        for c in ring:
            x, y = to_svg(c[0], c[1])
            pts.append(f'{x:.1f},{y:.1f}')
        return ' '.join(pts)

    gtype  = geom_json.get('type', '')
    coords = geom_json.get('coordinates', [])
    style  = (f'fill="{fill}" fill-opacity="{opacity}" '
              f'stroke="{stroke}" stroke-width="{sw}" stroke-linejoin="round"')
    parts  = []

    if gtype == 'Point':
        x, y = to_svg(coords[0], coords[1])
        parts.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="5" {style}/>')
    elif gtype == 'MultiPoint':
        for c in coords:
            x, y = to_svg(c[0], c[1])
            parts.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="5" {style}/>')
    elif gtype == 'LineString':
        parts.append(f'<polyline points="{ring_to_points(coords)}" fill="none" stroke="{stroke}" stroke-width="{sw}"/>')
    elif gtype == 'MultiLineString':
        for line in coords:
            parts.append(f'<polyline points="{ring_to_points(line)}" fill="none" stroke="{stroke}" stroke-width="{sw}"/>')
    elif gtype == 'Polygon':
        for ring in coords:
            parts.append(f'<polygon points="{ring_to_points(ring)}" {style}/>')
    elif gtype == 'MultiPolygon':
        for polygon in coords:
            for ring in polygon:
                parts.append(f'<polygon points="{ring_to_points(ring)}" {style}/>')
    elif gtype == 'GeometryCollection':
        for g in geom_json.get('geometries', []):
            parts.append(_geom_to_svg_paths(g, to_svg, fill, stroke, opacity, sw))
    return ''.join(parts)


def _build_svg_map(layer: 'TemporaryLayer', result: dict,
                   svg_w: int = 760, svg_h: int = 400) -> str:
    from .models import GISFeature
    from django.contrib.gis.geos import GEOSGeometry

    upload_geojson = layer.geojson or {}
    ext = result.get('upload_extent')
    min_lon, min_lat, max_lon, max_lat = (ext if ext else [68, 6, 98, 37])

    # Collect geometry IDs to draw — survey features come from the DB by integer id.
    int_ids  = [f['id'] for f in result.get('intersecting_features', [])]
    near_ids = [f['id'] for f in result.get('nearby_features', [])]
    all_ids  = int_ids + near_ids
    db_ids   = [i for i in all_ids if isinstance(i, int)]

    gis_features = list(GISFeature.objects.filter(id__in=db_ids)) if db_ids else []
    for f in gis_features:
        e = f.geometry.extent
        min_lon = min(min_lon, e[0]); min_lat = min(min_lat, e[1])
        max_lon = max(max_lon, e[2]); max_lat = max(max_lat, e[3])

    # External-layer features carry their own GeoJSON geometry in the result.
    def _ext_geoms(features):
        out = []
        for f in features:
            gj = f.get('geometry')
            if not gj:
                continue
            try:
                g = GEOSGeometry(json.dumps(gj), srid=4326)
            except Exception:
                continue
            out.append(g)
        return out

    ext_int_geoms  = _ext_geoms(result.get('intersecting_features', []))
    ext_near_geoms = _ext_geoms(result.get('nearby_features', []))
    has_ext = bool(ext_int_geoms or ext_near_geoms)
    for g in ext_int_geoms + ext_near_geoms:
        e = g.extent
        min_lon = min(min_lon, e[0]); min_lat = min(min_lat, e[1])
        max_lon = max(max_lon, e[2]); max_lat = max(max_lat, e[3])

    pad_lon = (max_lon - min_lon) * 0.15 or 0.01
    pad_lat = (max_lat - min_lat) * 0.15 or 0.01
    min_lon -= pad_lon; min_lat -= pad_lat
    max_lon += pad_lon; max_lat += pad_lat
    span_lon = max_lon - min_lon or 0.01
    span_lat = max_lat - min_lat or 0.01

    def to_svg(lon, lat):
        return (lon - min_lon) / span_lon * svg_w, (max_lat - lat) / span_lat * svg_h

    # width="100%" + viewBox → scales to container width without clipping right edge
    svg = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="100%" viewBox="0 0 {svg_w} {svg_h}" '
        f'preserveAspectRatio="xMidYMid meet" style="display:block">',
        f'<rect width="{svg_w}" height="{svg_h}" fill="#e8ecf0"/>',
    ]

    int_id_set = set(int_ids)
    for f in gis_features:
        fill   = '#ff4d4f' if f.id in int_id_set else '#fa8c16'
        stroke = '#c0392b' if f.id in int_id_set else '#d4711a'
        geom_json = json.loads(f.geometry.geojson)
        svg.append(_geom_to_svg_paths(geom_json, to_svg, fill, stroke, 0.4, 1.2))

    # External-layer features (e.g. GLR plans) — purple = intersecting, violet = nearby
    for g in ext_near_geoms:
        svg.append(_geom_to_svg_paths(json.loads(g.geojson), to_svg, '#b37feb', '#722ed1', 0.35, 1.0))
    for g in ext_int_geoms:
        svg.append(_geom_to_svg_paths(json.loads(g.geojson), to_svg, '#722ed1', '#531dab', 0.45, 1.2))

    for feat in upload_geojson.get('features', []):
        svg.append(_geom_to_svg_paths(feat.get('geometry', {}), to_svg, '#1890ff', '#0050b3', 0.5, 1.5))

    # Compass rose
    cx, cy, r = svg_w - 28, 28, 18
    svg.append(
        f'<circle cx="{cx}" cy="{cy}" r="{r}" fill="white" fill-opacity="0.85" stroke="#aaa" stroke-width="0.5"/>'
        f'<polygon points="{cx},{cy-r+3} {cx-5},{cy+6} {cx},{cy+2}" fill="#1a1a2e"/>'
        f'<polygon points="{cx},{cy-r+3} {cx+5},{cy+6} {cx},{cy+2}" fill="#ccc"/>'
        f'<text x="{cx}" y="{cy-r+14}" text-anchor="middle" font-size="8" font-weight="bold" font-family="Arial" fill="#1a1a2e">N</text>'
    )

    # Legend — entries depend on what was drawn
    legend_entries = [
        ('#1890ff', '#0050b3', 0.5, 'Uploaded Layer'),
        ('#ff4d4f', '#c0392b', 0.4, 'Survey Features (Intersects)'),
        ('#fa8c16', '#d4711a', 0.4, 'Survey Features (Nearby)'),
    ]
    if has_ext:
        legend_entries += [
            ('#722ed1', '#531dab', 0.45, 'External Layer (Intersects)'),
            ('#b37feb', '#722ed1', 0.35, 'External Layer (Nearby)'),
        ]
    lw, row_h = 185, 16
    lh = len(legend_entries) * row_h + 8
    lx, ly = 8, svg_h - lh - 8
    svg.append(f'<rect x="{lx}" y="{ly}" width="{lw}" height="{lh}" rx="3" '
               f'fill="white" fill-opacity="0.9" stroke="#bbb" stroke-width="0.5"/>')
    for i, (fill, stroke, op, text) in enumerate(legend_entries):
        ry = ly + 8 + i * row_h
        svg.append(
            f'<rect x="{lx+6}" y="{ry}" width="14" height="10" fill="{fill}" '
            f'fill-opacity="{op}" stroke="{stroke}" stroke-width="1"/>'
            f'<text x="{lx+26}" y="{ry+9}" font-size="9" font-family="Arial" fill="#222">{text}</text>'
        )

    svg.append(f'<rect x="0" y="0" width="{svg_w}" height="{svg_h}" fill="none" stroke="#1a3a6a" stroke-width="1.5"/>')
    svg.append('</svg>')
    return ''.join(svg)


# ── PDF report generator ──────────────────────────────────────────────────────

_VERDICT_CFG = {
    'FALLS_WITHIN': ('#ff4d4f', '#fff1f0', '#cf1322', '⚠ FALLS WITHIN SURVEY FEATURES'),
    'NEARBY':       ('#fa8c16', '#fff7e6', '#ad4e00', '⚡ NEARBY SURVEY FEATURES (< 1 km)'),
    'CLEAR':        ('#52c41a', '#f6ffed', '#237804', '✓ DOES NOT FALL IN ANY SURVEY FEATURE'),
}


def _feature_rows_html(features: list[dict], show_dist: bool = False) -> str:
    if not features:
        return '<tr><td colspan="4" style="color:#999;text-align:center;padding:8px">None found</td></tr>'
    rows = []
    for f in features:
        dist_cell = ''
        if show_dist:
            dkm = f.get('distance_km')
            dist_cell = f'<td style="text-align:right">{dkm:.3f} km</td>' if dkm is not None else '<td>—</td>'
        rows.append(
            f'<tr>'
            f'<td>{f["id"]}</td>'
            f'<td>{_html.escape(f["layer_name"])}</td>'
            f'<td>{_html.escape(f["project"])}</td>'
            f'{dist_cell}'
            f'</tr>'
        )
    return ''.join(rows)


def _buf_label(buffer_m: int) -> str:
    return f'{buffer_m} m' if buffer_m < 1000 else f'{buffer_m // 1000} km'


def _is_ext_feature(f: dict) -> bool:
    """External-layer result rows carry a string id like 'ext:6'."""
    fid = f.get('id')
    return isinstance(fid, str) and fid.startswith('ext:')


def _ext_feature_table_html(features: list[dict], show_dist: bool = False) -> str:
    """
    Render external-layer features as a full <table>, exposing every
    superadmin-configured analysis column (held in each feature's `attributes`)
    as its own column. The attribute key set is the union across the supplied
    features, preserving first-seen order.
    """
    if not features:
        return ''
    attr_keys: list[str] = []
    for f in features:
        for k in (f.get('attributes') or {}).keys():
            if k not in attr_keys:
                attr_keys.append(k)

    headers = ['Layer', 'Label'] + attr_keys + (['Distance'] if show_dist else [])
    thead = ''.join(f'<th>{_html.escape(str(h))}</th>' for h in headers)

    rows = []
    for f in features:
        attrs = f.get('attributes') or {}
        cells = [
            f'<td>{_html.escape(str(f.get("layer_name", "")))}</td>',
            f'<td>{_html.escape(str(f.get("label", "")))}</td>',
        ]
        cells += [f'<td>{_html.escape(str(attrs.get(k, "")))}</td>' for k in attr_keys]
        if show_dist:
            dkm = f.get('distance_km')
            cells.append(
                f'<td style="text-align:right">{dkm:.3f} km</td>' if dkm is not None else '<td>—</td>'
            )
        rows.append('<tr>' + ''.join(cells) + '</tr>')

    return (f'<table><thead><tr>{thead}</tr></thead><tbody>'
            + ''.join(rows) + '</tbody></table>')


def generate_analysis_report_html(layer: 'TemporaryLayer', result: dict) -> str:
    verdict      = result.get('verdict', 'CLEAR')
    verdict_text = _html.escape(result.get('verdict_text', ''))
    badge_color, badge_bg, badge_border, badge_label = _VERDICT_CFG.get(verdict, _VERDICT_CFG['CLEAR'])

    svg_map   = _build_svg_map(layer, result)
    today     = date.today().strftime('%d %b %Y')
    title     = _html.escape(layer.name)
    purpose   = _html.escape(layer.effective_purpose or '—')
    lr        = _html.escape(layer.effective_land_rights or '—')
    uploader  = _html.escape(layer.uploaded_by.get_full_name() or layer.uploaded_by.username)
    fmt       = layer.get_file_format_display()
    area_str  = f'{result["upload_area_sqkm"]:.4f} km²' if result.get('upload_area_sqkm') else '—'
    buf       = result.get('buffer_km', result.get('buffer_m', 1000) / 1000)

    int_count  = result.get('intersecting_count', 0)
    near_count = result.get('nearby_count', 0)

    int_all   = result.get('intersecting_features', [])
    near_all   = result.get('nearby_features', [])
    int_rows   = _feature_rows_html([f for f in int_all  if not _is_ext_feature(f)], show_dist=False)
    near_rows  = _feature_rows_html([f for f in near_all if not _is_ext_feature(f)], show_dist=True)
    # External-layer features get their own tables with the configured analysis columns.
    ext_int_html  = _ext_feature_table_html([f for f in int_all  if _is_ext_feature(f)], show_dist=False)
    ext_near_html = _ext_feature_table_html([f for f in near_all if _is_ext_feature(f)], show_dist=True)
    ext_int_section = (
        f'<div><div class="sec">External Layer Features — Intersecting</div>{ext_int_html}</div>'
        if ext_int_html else ''
    )
    ext_near_section = (
        f'<div><div class="sec">External Layer Features — Nearby within {buf} km</div>{ext_near_html}</div>'
        if ext_near_html else ''
    )

    th = 'background:#0d2b5e;color:#fff;padding:5px 8px;text-align:left;font-size:8pt'
    td = 'padding:4px 8px;font-size:8pt;border-bottom:0.5px solid #e0e0e0'

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<style>
*, *::before, *::after {{ box-sizing:border-box; margin:0; padding:0; }}
@page {{ size: A4 portrait; margin: 0; }}
body {{
  width:210mm;
  font-family:'Arial',Helvetica,sans-serif;
  background:#fff;
  -webkit-print-color-adjust:exact; print-color-adjust:exact;
  font-size:9pt; color:#1a1a2e;
}}
.page {{ width:100%; padding:10mm; display:flex; flex-direction:column; gap:4mm; }}
.header {{ background:#0d2b5e; color:#fff; padding:5mm 6mm; border-radius:2px; flex-shrink:0; }}
.header h1 {{ font-size:13pt; font-weight:bold; }}
.header .sub {{ font-size:7.5pt; color:#90b8d8; margin-top:2mm; display:flex; justify-content:space-between; }}
.verdict {{ border:1.5px solid {badge_border}; background:{badge_bg}; color:{badge_border};
  padding:3mm 5mm; border-radius:3px; font-size:10pt; font-weight:bold; text-align:center; flex-shrink:0; }}
.meta {{ display:grid; grid-template-columns:1fr 1fr; gap:2mm 6mm; flex-shrink:0;
  background:#f8fafc; border:0.5px solid #d0dae8; border-radius:2px; padding:3mm 4mm; }}
.ml {{ font-size:7pt; color:#888; text-transform:uppercase; letter-spacing:0.5px; }}
.mv {{ font-size:8.5pt; font-weight:500; }}
.map-section {{ flex-shrink:0; border:1.5px solid #1a3a6a; width:100%; }}
table {{ width:100%; border-collapse:collapse; table-layout:fixed; word-wrap:break-word; }}
th {{ {th}; }} td {{ {td}; }}
tr:nth-child(even) td {{ background:#f8fafc; }}
.sec {{ font-size:9pt; font-weight:bold; color:#0d2b5e;
  border-bottom:1.5px solid #0d2b5e; padding-bottom:1mm; margin-bottom:2mm; flex-shrink:0; }}
.footer {{ margin-top:4mm; border-top:0.5px solid #aaa; padding-top:2mm; flex-shrink:0;
  display:flex; justify-content:space-between; font-size:7pt; color:#666; }}
.fv {{ background:{badge_color}; color:#fff; padding:1mm 3mm; border-radius:2px;
  font-weight:bold; font-size:7.5pt; }}
</style>
</head>
<body>
<div class="page">
  <div class="header">
    <h1>Survey Feature Proximity Analysis Report</h1>
    <div class="sub">
      <span>RakshaGIS — DGDE Survey Platform</span>
      <span>Generated: {today} &nbsp;|&nbsp; {uploader}</span>
    </div>
  </div>

  <div class="verdict">{badge_label}</div>

  <div class="meta">
    <div><div class="ml">Layer Name</div><div class="mv">{title}</div></div>
    <div><div class="ml">File Format</div><div class="mv">{fmt}</div></div>
    <div><div class="ml">Purpose</div><div class="mv">{purpose}</div></div>
    <div><div class="ml">Land Rights Type</div><div class="mv">{lr}</div></div>
    <div><div class="ml">Features</div><div class="mv">{layer.feature_count}</div></div>
    <div><div class="ml">Upload Area (est.)</div><div class="mv">{area_str}</div></div>
  </div>

  <div class="map-section">{svg_map}</div>

  <div>
    <div class="sec">Intersecting Survey Features ({int_count})</div>
    <table>
      <thead><tr><th>ID</th><th>Layer Name</th><th>Project</th></tr></thead>
      <tbody>{int_rows}</tbody>
    </table>
  </div>

  {ext_int_section}

  <div>
    <div class="sec">Nearby Survey Features within {buf} km ({near_count})</div>
    <table>
      <thead><tr><th>ID</th><th>Layer Name</th><th>Project</th><th style="text-align:right">Distance</th></tr></thead>
      <tbody>{near_rows}</tbody>
    </table>
  </div>

  {ext_near_section}

  <div class="footer">
    <span>© RakshaGIS — DGDE Survey Platform &nbsp;|&nbsp; Buffer: {buf} km &nbsp;|&nbsp; CRS: WGS 84</span>
    <span class="fv">{verdict_text[:90]}{'…' if len(verdict_text)>90 else ''}</span>
  </div>
</div>
</body>
</html>"""


# ── Multi-range PDF report ─────────────────────────────────────────────────────

_VERDICT_SEVERITY = {'FALLS_WITHIN': 2, 'NEARBY': 1, 'CLEAR': 0}


def generate_multi_range_report_html(layer: 'TemporaryLayer',
                                     all_results: dict[str, dict]) -> str:
    """
    Generate a single HTML/PDF that contains analysis results for every
    buffer distance in all_results (keyed by str(buffer_m)).

    Structure:
      Page 1 — Header, file metadata, map (1 km view), summary table
      Page 2+ — One section per buffer range, each with feature tables
    """
    if not all_results:
        raise ValueError('No analysis results provided')

    today    = date.today().strftime('%d %b %Y')
    title    = _html.escape(layer.name)
    purpose  = _html.escape(layer.effective_purpose or '—')
    lr       = _html.escape(layer.effective_land_rights or '—')
    uploader = _html.escape(layer.uploaded_by.get_full_name() or layer.uploaded_by.username)
    fmt      = layer.get_file_format_display()

    # Sort ranges ascending
    sorted_keys = sorted(all_results.keys(), key=lambda k: int(k))

    # Use 1 km (or closest available) result for the map
    map_key = '1000' if '1000' in all_results else sorted_keys[-1]
    map_result = all_results[map_key]
    svg_map = _build_svg_map(layer, map_result)

    # Upload area from any result (same for all)
    first_result = all_results[sorted_keys[0]]
    area_str = (f'{first_result["upload_area_sqkm"]:.4f} km²'
                if first_result.get('upload_area_sqkm') else '—')

    # Overall worst verdict
    worst_verdict = max(
        (r.get('verdict', 'CLEAR') for r in all_results.values()),
        key=lambda v: _VERDICT_SEVERITY.get(v, 0),
    )
    wc, wbg, wb, wlabel = _VERDICT_CFG.get(worst_verdict, _VERDICT_CFG['CLEAR'])

    # ── Summary table rows ────────────────────────────────────────────────
    summary_rows = []
    for k in sorted_keys:
        r   = all_results[k]
        bm  = int(k)
        v   = r.get('verdict', 'CLEAR')
        vc, vbg, vb, _ = _VERDICT_CFG[v]
        ic  = r.get('intersecting_count', 0)
        nc  = r.get('nearby_count', 0)
        vbadge = f'<span style="background:{vc};color:#fff;padding:1px 6px;border-radius:3px;font-size:7.5pt">{v.replace("_"," ")}</span>'
        summary_rows.append(
            f'<tr>'
            f'<td style="text-align:center;font-weight:600">{_buf_label(bm)}</td>'
            f'<td style="text-align:center">{ic}</td>'
            f'<td style="text-align:center">{nc}</td>'
            f'<td style="text-align:center">{vbadge}</td>'
            f'</tr>'
        )
    summary_html = ''.join(summary_rows)

    # ── Per-range detail sections ─────────────────────────────────────────
    detail_sections = []
    for k in sorted_keys:
        r   = all_results[k]
        bm  = int(k)
        v   = r.get('verdict', 'CLEAR')
        vc, vbg, vb, _ = _VERDICT_CFG[v]
        ic  = r.get('intersecting_count', 0)
        nc  = r.get('nearby_count', 0)
        vt  = _html.escape(r.get('verdict_text', ''))

        int_all   = r.get('intersecting_features', [])
        near_all  = r.get('nearby_features', [])
        int_rows  = _feature_rows_html([f for f in int_all  if not _is_ext_feature(f)], show_dist=False)
        near_rows = _feature_rows_html([f for f in near_all if not _is_ext_feature(f)], show_dist=True)
        # External-layer features get dedicated tables exposing the configured columns.
        ext_int_html  = _ext_feature_table_html([f for f in int_all  if _is_ext_feature(f)], show_dist=False)
        ext_near_html = _ext_feature_table_html([f for f in near_all if _is_ext_feature(f)], show_dist=True)
        ext_int_block  = (f'<div style="margin-top:2mm"><div class="sec">External Layer — Intersecting</div>{ext_int_html}</div>'
                          if ext_int_html else '')
        ext_near_block = (f'<div style="margin-top:2mm"><div class="sec">External Layer — Nearby within {_buf_label(bm)}</div>{ext_near_html}</div>'
                          if ext_near_html else '')
        has_survey_int  = any(not _is_ext_feature(f) for f in int_all)
        has_survey_near = any(not _is_ext_feature(f) for f in near_all)

        detail_sections.append(f"""
  <div class="range-block" style="page-break-inside:avoid">
    <div class="range-header" style="background:{vb};color:#fff;">
      <span style="font-size:10pt;font-weight:bold">Buffer: {_buf_label(bm)}</span>
      <span style="font-size:9pt">{v.replace('_', ' ')} — {vt[:80]}{'…' if len(vt)>80 else ''}</span>
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:2mm;margin:2mm 0;
         background:#f8fafc;border:0.5px solid #d0dae8;padding:2mm 4mm;border-radius:2px">
      <div><span style="font-size:7pt;color:#888;text-transform:uppercase">Intersecting</span>
           <span style="font-size:9pt;font-weight:600;margin-left:6px">{ic}</span></div>
      <div><span style="font-size:7pt;color:#888;text-transform:uppercase">Nearby (&lt;{_buf_label(bm)})</span>
           <span style="font-size:9pt;font-weight:600;margin-left:6px">{nc}</span></div>
    </div>

    {'<div><div class="sec">Intersecting Survey Features ('+str(ic)+')</div><table><thead><tr><th>ID</th><th>Layer</th><th>Project</th></tr></thead><tbody>'+int_rows+'</tbody></table></div>' if has_survey_int else ''}
    {ext_int_block}
    {'<div style="margin-top:2mm"><div class="sec">Nearby Survey Features within '+_buf_label(bm)+' ('+str(nc)+')</div><table><thead><tr><th>ID</th><th>Layer</th><th>Project</th><th style="text-align:right">Distance</th></tr></thead><tbody>'+near_rows+'</tbody></table></div>' if has_survey_near else ''}
    {ext_near_block}
    {'<div style="color:#52c41a;font-size:8pt;padding:2mm 0">✓ No features found within this range.</div>' if ic == 0 and nc == 0 else ''}
  </div>""")

    detail_html = '\n  <div style="height:4mm"></div>\n'.join(detail_sections)

    th = 'background:#0d2b5e;color:#fff;padding:5px 8px;text-align:left;font-size:8pt'
    td = 'padding:4px 8px;font-size:8pt;border-bottom:0.5px solid #e0e0e0'

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<style>
*, *::before, *::after {{ box-sizing:border-box; margin:0; padding:0; }}
@page {{ size: A4 portrait; margin: 0; }}
body {{
  width:210mm; max-width:210mm; overflow-x:hidden;
  font-family:'Arial',Helvetica,sans-serif;
  background:#fff;
  -webkit-print-color-adjust:exact; print-color-adjust:exact;
  font-size:9pt; color:#1a1a2e;
}}
.page {{ padding:10mm; max-width:190mm; }}
.header {{ background:#0d2b5e; color:#fff; padding:5mm 6mm; border-radius:2px; }}
.header h1 {{ font-size:13pt; font-weight:bold; }}
.header .sub {{ font-size:7.5pt; color:#90b8d8; margin-top:2mm; display:flex; justify-content:space-between; flex-wrap:wrap; gap:2mm; }}
.verdict {{ border:1.5px solid {wb}; background:{wbg}; color:{wb};
  padding:3mm 5mm; border-radius:3px; font-size:10pt; font-weight:bold;
  text-align:center; margin:4mm 0; }}
.meta {{ display:grid; grid-template-columns:1fr 1fr; gap:2mm 6mm; margin:4mm 0;
  background:#f8fafc; border:0.5px solid #d0dae8; border-radius:2px; padding:3mm 4mm; }}
.ml {{ font-size:7pt; color:#888; text-transform:uppercase; letter-spacing:0.5px; }}
.mv {{ font-size:8.5pt; font-weight:500; word-break:break-word; }}
.map-section {{ border:1.5px solid #1a3a6a; margin:4mm 0; width:100%; }}
table {{ width:100%; border-collapse:collapse; table-layout:fixed; word-wrap:break-word; }}
th {{ {th}; }} td {{ {td}; word-break:break-word; }}
tr:nth-child(even) td {{ background:#f8fafc; }}
.sec {{ font-size:9pt; font-weight:bold; color:#0d2b5e;
  border-bottom:1.5px solid #0d2b5e; padding-bottom:1mm; margin-bottom:2mm; }}
.range-block {{ margin-bottom:6mm; }}
.range-header {{ display:flex; justify-content:space-between; align-items:center;
  flex-wrap:wrap; gap:2mm; padding:3mm 4mm; border-radius:2px; }}
.page-break {{ page-break-before:always; padding-top:10mm; }}
.footer {{ border-top:0.5px solid #aaa; padding-top:2mm; margin-top:6mm;
  display:flex; justify-content:space-between; flex-wrap:wrap; gap:2mm;
  font-size:7pt; color:#666; }}
.fv {{ background:{wc}; color:#fff; padding:1mm 3mm; border-radius:2px;
  font-weight:bold; font-size:7.5pt; }}
</style>
</head>
<body>
<div class="page">
  <!-- ── Page 1: header, meta, map, summary ── -->
  <div class="header">
    <h1>Survey Feature Multi-Range Proximity Analysis Report</h1>
    <div class="sub">
      <span>RakshaGIS — DGDE Survey Platform</span>
      <span>Generated: {today} &nbsp;|&nbsp; {uploader}</span>
    </div>
  </div>

  <div class="verdict">{wlabel} </div>

  <div class="meta">
    <div><div class="ml">Layer Name</div><div class="mv">{title}</div></div>
    <div><div class="ml">File Format</div><div class="mv">{fmt}</div></div>
    <div><div class="ml">Purpose</div><div class="mv">{purpose}</div></div>
    <div><div class="ml">Land Rights Type</div><div class="mv">{lr}</div></div>
    <div><div class="ml">Features</div><div class="mv">{layer.feature_count}</div></div>
    <div><div class="ml">Upload Area (est.)</div><div class="mv">{area_str}</div></div>
  </div>

  <div class="map-section">{svg_map}</div>

  <!-- Summary table -->
  <div class="sec" style="margin-top:4mm">Analysis Summary — All Buffer Ranges</div>
  <table>
    <thead><tr>
      <th style="text-align:center">Buffer</th>
      <th style="text-align:center">Intersecting</th>
      <th style="text-align:center">Nearby</th>
      <th style="text-align:center">Status</th>
    </tr></thead>
    <tbody>{summary_html}</tbody>
  </table>

  <!-- ── Page 2+: per-range detail ── -->
  <div class="page-break"></div>

  <div class="header" style="margin-bottom:6mm">
    <h1>Detailed Results by Buffer Range</h1>
    <div class="sub">
      <span>{title}</span>
      <span>{today} &nbsp;|&nbsp; {uploader}</span>
    </div>
  </div>

  {detail_html}

  <div class="footer">
    <span>© RakshaGIS — DGDE Survey Platform &nbsp;|&nbsp; Ranges: {', '.join(_buf_label(int(k)) for k in sorted_keys)} &nbsp;|&nbsp; CRS: WGS 84</span>
    <span class="fv">Overall: {worst_verdict.replace('_', ' ')}</span>
  </div>
</div>
</body>
</html>"""
