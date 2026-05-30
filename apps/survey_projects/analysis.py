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

BUFFER_KM  = 1.0
BUFFER_DEG = BUFFER_KM / 111.0   # ~0.009° ≈ 1 km at equator


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


# ── External layer proximity check ───────────────────────────────────────────

def _check_external_layers(upload_geom, buffered) -> tuple[dict, dict]:
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

    for ext_layer in active_layers:
        try:
            fc = layer_geojson(ext_layer, limit=10_000)
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

            if upload_geom.intersects(geom):
                int_count += 1
                int_feats.append({
                    'id':         f'ext:{ext_layer.id}',
                    'layer_name': ext_layer.display_name,
                    'project':    f'External: {ext_layer.database.name}',
                    'project_id': None,
                    'label':      label[:80],
                    'attributes': {k: str(v)[:80] for k, v in list(props.items())[:5]},
                })
                if int_count >= 20:
                    break
            elif buffered.intersects(geom):
                try:
                    dist_deg = upload_geom.distance(geom)
                    dist_m   = dist_deg * 111_000  # approximate
                except Exception:
                    dist_m = None
                near_count += 1
                near_feats.append({
                    'id':          f'ext:{ext_layer.id}',
                    'layer_name':  ext_layer.display_name,
                    'project':     f'External: {ext_layer.database.name}',
                    'project_id':  None,
                    'label':       label[:80],
                    'attributes':  {k: str(v)[:80] for k, v in list(props.items())[:5]},
                    'distance_m':  round(dist_m, 0) if dist_m else None,
                    'distance_km': round(dist_m / 1000, 3) if dist_m else None,
                })

    return (
        {'count': int_count,  'features': int_feats[:20]},
        {'count': near_count, 'features': near_feats[:20]},
    )


# ── Core spatial analysis ─────────────────────────────────────────────────────

def run_defence_analysis(layer: 'TemporaryLayer') -> dict:
    """
    Run spatial analysis for *layer* against all GISFeature records in the DB.

    Returns:
    {
        'verdict':              'FALLS_WITHIN' | 'NEARBY' | 'CLEAR',
        'verdict_text':         str,
        'intersecting_count':   int,
        'nearby_count':         int,
        'intersecting_features': [...],
        'nearby_features':       [...],
        'upload_extent':        [minLon, minLat, maxLon, maxLat],
        'upload_area_sqkm':     float | None,
        'buffer_km':            float,
    }
    """
    from .models import GISFeature
    from django.contrib.gis.db.models.functions import Distance as GeoDistance

    upload_geom = _union_geojson(layer.geojson)
    extent = list(upload_geom.extent)

    # Estimate area (polygon layers only)
    upload_area = None
    try:
        projected = upload_geom.transform(32644, clone=True)  # UTM 44N
        upload_area = round(projected.area / 1_000_000, 4)   # m² → km²
    except Exception:
        pass

    # ── Intersecting features ─────────────────────────────────────────────
    intersecting_qs = (
        GISFeature.objects
        .filter(geometry__intersects=upload_geom)
        .select_related('project')
    )
    intersecting_list = [_feature_dict(f) for f in intersecting_qs[:20]]
    intersecting_count = intersecting_qs.count()

    # ── Nearby features (within buffer, not intersecting) ─────────────────
    intersecting_ids = list(intersecting_qs.values_list('id', flat=True))
    buffered = upload_geom.buffer(BUFFER_DEG)

    nearby_qs = (
        GISFeature.objects
        .filter(geometry__intersects=buffered)
        .exclude(id__in=intersecting_ids)
        .select_related('project')
        .annotate(dist=GeoDistance('geometry', upload_geom))
        .order_by('dist')
    )
    nearby_list = [
        _feature_dict(f, f.dist.m if hasattr(f.dist, 'm') else None)
        for f in nearby_qs[:20]
    ]
    nearby_count = nearby_qs.count()

    # ── Also check active external DB layers ─────────────────────────────
    ext_intersecting, ext_nearby = _check_external_layers(upload_geom, buffered)
    intersecting_count += ext_intersecting['count']
    nearby_count       += ext_nearby['count']
    intersecting_list  += ext_intersecting['features']
    nearby_list        += ext_nearby['features']

    # ── Verdict ──────────────────────────────────────────────────────────
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
            f'{BUFFER_KM} km of {nearby_count} feature(s).'
        )
    else:
        verdict = 'CLEAR'
        verdict_text = (
            'The uploaded file does NOT fall within or near any existing survey feature.'
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
        'buffer_km':             BUFFER_KM,
    }


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

    upload_geojson = layer.geojson or {}
    ext = result.get('upload_extent')
    min_lon, min_lat, max_lon, max_lat = (ext if ext else [68, 6, 98, 37])

    # Collect geometry IDs to draw
    int_ids  = [f['id'] for f in result.get('intersecting_features', [])]
    near_ids = [f['id'] for f in result.get('nearby_features', [])]
    all_ids  = int_ids + near_ids

    gis_features = list(GISFeature.objects.filter(id__in=all_ids)) if all_ids else []
    for f in gis_features:
        e = f.geometry.extent
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

    svg = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{svg_w}" height="{svg_h}" viewBox="0 0 {svg_w} {svg_h}">',
        f'<rect width="{svg_w}" height="{svg_h}" fill="#e8ecf0"/>',
    ]

    int_id_set = set(int_ids)
    for f in gis_features:
        fill   = '#ff4d4f' if f.id in int_id_set else '#fa8c16'
        stroke = '#c0392b' if f.id in int_id_set else '#d4711a'
        geom_json = json.loads(f.geometry.geojson)
        svg.append(_geom_to_svg_paths(geom_json, to_svg, fill, stroke, 0.4, 1.2))

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

    # Legend
    lx, ly = 8, svg_h - 70
    svg.append(
        f'<rect x="{lx}" y="{ly}" width="165" height="62" rx="3" fill="white" fill-opacity="0.9" stroke="#bbb" stroke-width="0.5"/>'
        f'<rect x="{lx+6}" y="{ly+8}" width="14" height="10" fill="#1890ff" fill-opacity="0.5" stroke="#0050b3" stroke-width="1"/>'
        f'<text x="{lx+26}" y="{ly+18}" font-size="9" font-family="Arial" fill="#222">Uploaded Layer</text>'
        f'<rect x="{lx+6}" y="{ly+24}" width="14" height="10" fill="#ff4d4f" fill-opacity="0.4" stroke="#c0392b" stroke-width="1"/>'
        f'<text x="{lx+26}" y="{ly+34}" font-size="9" font-family="Arial" fill="#222">Survey Features (Intersects)</text>'
        f'<rect x="{lx+6}" y="{ly+40}" width="14" height="10" fill="#fa8c16" fill-opacity="0.4" stroke="#d4711a" stroke-width="1"/>'
        f'<text x="{lx+26}" y="{ly+50}" font-size="9" font-family="Arial" fill="#222">Survey Features (Nearby &lt;1 km)</text>'
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
    buf       = result.get('buffer_km', 1.0)

    int_count  = result.get('intersecting_count', 0)
    near_count = result.get('nearby_count', 0)
    int_rows   = _feature_rows_html(result.get('intersecting_features', []), show_dist=False)
    near_rows  = _feature_rows_html(result.get('nearby_features', []), show_dist=True)

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
  width:210mm; height:297mm;
  font-family:'Arial',Helvetica,sans-serif;
  background:#fff; overflow:hidden;
  -webkit-print-color-adjust:exact; print-color-adjust:exact;
  font-size:9pt; color:#1a1a2e;
}}
.page {{ width:100%; height:100%; padding:10mm; display:flex; flex-direction:column; gap:4mm; }}
.header {{ background:#0d2b5e; color:#fff; padding:5mm 6mm; border-radius:2px; flex-shrink:0; }}
.header h1 {{ font-size:13pt; font-weight:bold; }}
.header .sub {{ font-size:7.5pt; color:#90b8d8; margin-top:2mm; display:flex; justify-content:space-between; }}
.verdict {{ border:1.5px solid {badge_border}; background:{badge_bg}; color:{badge_border};
  padding:3mm 5mm; border-radius:3px; font-size:10pt; font-weight:bold; text-align:center; flex-shrink:0; }}
.meta {{ display:grid; grid-template-columns:1fr 1fr; gap:2mm 6mm; flex-shrink:0;
  background:#f8fafc; border:0.5px solid #d0dae8; border-radius:2px; padding:3mm 4mm; }}
.ml {{ font-size:7pt; color:#888; text-transform:uppercase; letter-spacing:0.5px; }}
.mv {{ font-size:8.5pt; font-weight:500; }}
.map-section {{ flex-shrink:0; border:1.5px solid #1a3a6a; overflow:hidden; }}
table {{ width:100%; border-collapse:collapse; }}
th {{ {th}; }} td {{ {td}; }}
tr:nth-child(even) td {{ background:#f8fafc; }}
.sec {{ font-size:9pt; font-weight:bold; color:#0d2b5e;
  border-bottom:1.5px solid #0d2b5e; padding-bottom:1mm; margin-bottom:2mm; flex-shrink:0; }}
.footer {{ margin-top:auto; border-top:0.5px solid #aaa; padding-top:2mm; flex-shrink:0;
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

  <div>
    <div class="sec">Nearby Survey Features within {buf} km ({near_count})</div>
    <table>
      <thead><tr><th>ID</th><th>Layer Name</th><th>Project</th><th style="text-align:right">Distance</th></tr></thead>
      <tbody>{near_rows}</tbody>
    </table>
  </div>

  <div class="footer">
    <span>© RakshaGIS — DGDE Survey Platform &nbsp;|&nbsp; Buffer: {buf} km &nbsp;|&nbsp; CRS: WGS 84</span>
    <span class="fv">{verdict_text[:90]}{'…' if len(verdict_text)>90 else ''}</span>
  </div>
</div>
</body>
</html>"""
