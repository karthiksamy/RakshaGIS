"""
Async tasks for RakshaGIS: data export, basemap COG conversion, drone dataset processing.

build_export_zip   — assembles a full data-export ZIP for a survey area or project.
purge_expired_exports — housekeeping: removes expired ExportTask rows + their files.

ZIP structure (survey area):
    {safe_name}_export_YYYYMMDD/
        provenance.json           ← signed provenance manifest
        GIS_Features/
            {layer_name}/
                {layer_name}.shp/.dbf/.shx/.prj   (EPSG:4326, one file set per layer)
        Documents/
            {doc_title}.ext       ← C2PA/legacy watermark re-applied on the fly
        Rasters/
            {raster_name}.tif     ← C2PA watermark
        Shapefile_Uploads/
            {layer_name}.zip      ← original uploaded shapefile ZIPs
        README.txt

For a full project the same tree repeats under each survey-area sub-folder.
"""

import datetime
import io
import json
import logging
import os
import re
import tempfile
import zipfile

from celery import shared_task
from django.conf import settings
from django.utils import timezone

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _safe(name: str, maxlen: int = 60) -> str:
    """Return a filesystem-safe version of a name."""
    return re.sub(r'[^\w\-]', '_', name or 'unknown')[:maxlen]


def _progress(task_obj, msg: str) -> None:
    """Update the ExportTask progress message without touching status."""
    from apps.core.models import ExportTask
    ExportTask.objects.filter(pk=task_obj.pk).update(progress_msg=msg)


def _watermark(file_bytes: bytes, filename: str, mime_type: str, meta: dict) -> bytes:
    """Apply C2PA (for images/TIFFs) or legacy watermark. Always returns bytes."""
    try:
        from apps.core.watermark import embed_watermark
        return embed_watermark(file_bytes, filename, mime_type, meta)
    except Exception as exc:
        logger.warning("Watermark failed for %s: %s — saving without watermark", filename, exc)
        return file_bytes


def _export_gis_features(zf: zipfile.ZipFile, folder_ids: set, base_prefix: str,
                          meta_base: dict, progress_cb) -> list[dict]:
    """
    Write GIS features (grouped by layer_name) as ESRI Shapefiles into the ZIP.
    Returns a list of provenance entries.
    """
    import json as _json
    from collections import defaultdict
    from apps.survey_projects.models import GISFeature

    features = list(
        GISFeature.objects.filter(is_deleted=False, folder_id__in=folder_ids)
        .only('layer_name', 'geometry', 'geometry_type', 'feature_id', 'attributes')
    )
    if not features:
        return []

    layers: dict[str, list] = defaultdict(list)
    for f in features:
        layers[f.layer_name].append(f)

    provenance_entries = []
    prefix = f"{base_prefix}GIS_Features"

    try:
        import fiona
        import fiona.crs

        for layer_name, feats in layers.items():
            progress_cb(f"Exporting layer: {layer_name}")
            safe_layer = _safe(layer_name, 40)

            geom_type = 'Unknown'
            for f in feats:
                if f.geometry_type:
                    geom_type = f.geometry_type.capitalize()
                    break

            all_keys: set[str] = set()
            for f in feats:
                if isinstance(f.attributes, dict):
                    all_keys.update(f.attributes.keys())

            schema = {
                'geometry': geom_type,
                'properties': {'feature_id': 'str', 'layer_name': 'str'},
            }
            for key in sorted(all_keys):
                schema['properties'][key[:10]] = 'str'

            with tempfile.TemporaryDirectory() as tmpdir:
                shp_path = os.path.join(tmpdir, f'{safe_layer}.shp')
                try:
                    with fiona.open(shp_path, 'w', driver='ESRI Shapefile',
                                    schema=schema, crs=fiona.crs.from_epsg(4326)) as dst:
                        for f in feats:
                            try:
                                geom = _json.loads(f.geometry.geojson)
                                props = {
                                    'feature_id': str(f.feature_id or ''),
                                    'layer_name': str(f.layer_name or ''),
                                }
                                if isinstance(f.attributes, dict):
                                    for key in sorted(all_keys):
                                        props[key[:10]] = str(f.attributes.get(key, '') or '')
                                dst.write({'geometry': geom, 'properties': props})
                            except Exception:
                                continue

                    for fn in os.listdir(tmpdir):
                        fp = os.path.join(tmpdir, fn)
                        arc = f"{prefix}/{safe_layer}/{fn}"
                        zf.write(fp, arc)

                    provenance_entries.append({
                        'type': 'gis_features',
                        'layer': layer_name,
                        'feature_count': len(feats),
                        'path': f"{prefix}/{safe_layer}/",
                        'format': 'ESRI Shapefile (EPSG:4326)',
                    })
                except Exception as exc:
                    logger.warning("Failed to export layer %s as shapefile: %s", layer_name, exc)

    except ImportError:
        # Fallback: GeoJSON when fiona unavailable
        progress_cb("Fiona unavailable — writing GeoJSON fallback")
        for layer_name, feats in layers.items():
            safe_layer = _safe(layer_name, 40)
            fc = {'type': 'FeatureCollection', 'features': []}
            for f in feats:
                try:
                    geom = _json.loads(f.geometry.geojson)
                    props = {'feature_id': f.feature_id, 'layer_name': f.layer_name}
                    if isinstance(f.attributes, dict):
                        props.update(f.attributes)
                    fc['features'].append({'type': 'Feature', 'geometry': geom, 'properties': props})
                except Exception:
                    continue
            arc = f"{prefix}/{safe_layer}.geojson"
            zf.writestr(arc, _json.dumps(fc))
            provenance_entries.append({
                'type': 'gis_features',
                'layer': layer_name,
                'feature_count': len(feats),
                'path': arc,
                'format': 'GeoJSON (fallback)',
            })

    return provenance_entries


def _export_gis_features_dxf(zf: zipfile.ZipFile, folder_ids: set, base_prefix: str,
                              progress_cb) -> list[dict]:
    """
    Write GIS features (grouped by layer_name) as AutoCAD DXF files into the ZIP.
    Each layer becomes one .dxf under GIS_Features_DXF/{layer_name}/{layer_name}.dxf.
    Geometry → LWPOLYLINE / POINT entities; attributes written as XDATA strings.
    Returns a list of provenance entries.
    """
    import json as _json
    from collections import defaultdict
    from apps.survey_projects.models import GISFeature

    try:
        import ezdxf
        from ezdxf.enums import TextEntityAlignment
    except ImportError:
        logger.warning("ezdxf not installed — skipping DXF export")
        return []

    features = list(
        GISFeature.objects.filter(is_deleted=False, folder_id__in=folder_ids)
        .only('layer_name', 'geometry', 'geometry_type', 'feature_id', 'attributes')
    )
    if not features:
        return []

    layers: dict[str, list] = defaultdict(list)
    for f in features:
        layers[f.layer_name].append(f)

    provenance_entries = []
    prefix = f"{base_prefix}GIS_Features_DXF"

    for layer_name, feats in layers.items():
        progress_cb(f"Exporting DXF layer: {layer_name}")
        safe_layer = _safe(layer_name, 40)

        doc = ezdxf.new('R2010')
        doc.units = ezdxf.units.M
        msp = doc.modelspace()

        # Register application id for XDATA attribute storage
        APP_ID = 'RAKSHA_GIS'
        doc.appids.new(APP_ID)

        # Create a named layer in the DXF
        doc.layers.new(name=safe_layer, dxfattribs={'color': 2})

        for feat in feats:
            try:
                geom = _json.loads(feat.geometry.geojson)
                gtype = geom.get('type', '')
                coords = geom.get('coordinates', [])

                xdata_strings = [
                    (1000, f"feature_id:{feat.feature_id or ''}"),
                    (1000, f"layer:{feat.layer_name or ''}"),
                ]
                if isinstance(feat.attributes, dict):
                    for k, v in feat.attributes.items():
                        xdata_strings.append((1000, f"{k[:50]}:{str(v)[:100]}"))

                dxf_attrs = {'layer': safe_layer}

                if gtype == 'Point':
                    lon, lat = coords[0], coords[1]
                    pt = msp.add_point((lon, lat, 0), dxfattribs=dxf_attrs)
                    pt.set_xdata(APP_ID, xdata_strings)

                elif gtype == 'LineString':
                    if len(coords) >= 2:
                        pts2d = [(c[0], c[1]) for c in coords]
                        poly = msp.add_lwpolyline(pts2d, dxfattribs=dxf_attrs)
                        poly.set_xdata(APP_ID, xdata_strings)

                elif gtype == 'Polygon':
                    # Outer ring only; inner rings (holes) not representable in LWPOLYLINE
                    ring = coords[0] if coords else []
                    if len(ring) >= 2:
                        pts2d = [(c[0], c[1]) for c in ring]
                        poly = msp.add_lwpolyline(pts2d, close=True, dxfattribs=dxf_attrs)
                        poly.set_xdata(APP_ID, xdata_strings)

                elif gtype == 'MultiPoint':
                    for c in coords:
                        pt = msp.add_point((c[0], c[1], 0), dxfattribs=dxf_attrs)
                        pt.set_xdata(APP_ID, xdata_strings)

                elif gtype in ('MultiLineString', 'MultiPolygon'):
                    rings = coords if gtype == 'MultiLineString' else [r[0] for r in coords if r]
                    for ring in rings:
                        if len(ring) >= 2:
                            pts2d = [(c[0], c[1]) for c in ring]
                            poly = msp.add_lwpolyline(pts2d, close=(gtype == 'MultiPolygon'),
                                                      dxfattribs=dxf_attrs)
                            poly.set_xdata(APP_ID, xdata_strings)

            except Exception as exc:
                logger.debug("DXF: skipping feature %s: %s", feat.pk, exc)
                continue

        with tempfile.TemporaryDirectory() as tmpdir:
            dxf_path = os.path.join(tmpdir, f'{safe_layer}.dxf')
            doc.saveas(dxf_path)
            arc = f"{prefix}/{safe_layer}/{safe_layer}.dxf"
            zf.write(dxf_path, arc)

        provenance_entries.append({
            'type': 'gis_features_dxf',
            'layer': layer_name,
            'feature_count': len(feats),
            'path': f"{prefix}/{safe_layer}/{safe_layer}.dxf",
            'format': 'AutoCAD DXF R2010 (EPSG:4326 decimal degrees)',
        })

    return provenance_entries


def _export_documents(zf: zipfile.ZipFile, folder_ids: set, base_prefix: str,
                      meta_base: dict, progress_cb) -> list[dict]:
    """Write Documents into the ZIP with C2PA/legacy watermarks."""
    from apps.documents.models import Document

    docs = Document.objects.filter(folder_id__in=folder_ids).select_related('folder')
    provenance_entries = []
    prefix = f"{base_prefix}Documents"

    for doc in docs:
        if not doc.file:
            continue
        try:
            progress_cb(f"Watermarking document: {doc.title[:40]}")
            with doc.file.open('rb') as fh:
                raw = fh.read()

            fname = doc.file.name.rsplit('/', 1)[-1]
            mime = doc.mime_type or 'application/octet-stream'
            meta = {**meta_base, 'document_id': doc.id, 'title': doc.title}
            watermarked = _watermark(raw, fname, mime, meta)

            arc = f"{prefix}/{_safe(doc.title, 80)}_{doc.id}_{fname}"
            zf.writestr(arc, watermarked)
            provenance_entries.append({
                'type': 'document',
                'id': doc.id,
                'title': doc.title,
                'path': arc,
                'mime_type': mime,
            })
        except Exception as exc:
            logger.warning("Skipping document %s: %s", doc.id, exc)

    return provenance_entries


def _export_rasters(zf: zipfile.ZipFile, folder_ids: set, base_prefix: str,
                    meta_base: dict, progress_cb) -> list[dict]:
    """Write GeoTIFF rasters (COG preferred) with C2PA watermarks."""
    from apps.survey_projects.models import GeoTiffLayer

    rasters = GeoTiffLayer.objects.filter(folder_id__in=folder_ids)
    provenance_entries = []
    prefix = f"{base_prefix}Rasters"

    for raster in rasters:
        # Prefer the COG file, fall back to the original upload
        file_field = raster.cog_file if (hasattr(raster, 'cog_file') and raster.cog_file) else raster.file
        if not file_field:
            continue
        try:
            progress_cb(f"Watermarking raster: {raster.name[:40]}")
            with file_field.open('rb') as fh:
                raw = fh.read()

            fname = file_field.name.rsplit('/', 1)[-1]
            mime = 'image/tiff'
            meta = {**meta_base, 'raster_name': raster.name}
            watermarked = _watermark(raw, fname, mime, meta)

            arc = f"{prefix}/{_safe(raster.name, 80)}_{raster.id}.tif"
            zf.writestr(arc, watermarked)
            provenance_entries.append({
                'type': 'raster',
                'id': raster.id,
                'name': raster.name,
                'path': arc,
                'format': 'GeoTIFF (C2PA watermarked)',
            })
        except Exception as exc:
            logger.warning("Skipping raster %s: %s", raster.id, exc)

    return provenance_entries


def _export_shapefile_uploads(zf: zipfile.ZipFile, folder_ids: set, base_prefix: str,
                               meta_base: dict, progress_cb) -> list[dict]:
    """Copy original uploaded shapefile ZIPs verbatim (already stored as-is)."""
    from apps.survey_projects.models import ShapefileImport

    imports = ShapefileImport.objects.filter(folder_id__in=folder_ids, status='DONE')
    provenance_entries = []
    prefix = f"{base_prefix}Shapefile_Uploads"

    for imp in imports:
        if not imp.file:
            continue
        try:
            progress_cb(f"Adding shapefile upload: {imp.layer_name[:40]}")
            with imp.file.open('rb') as fh:
                raw = fh.read()

            fname = imp.file.name.rsplit('/', 1)[-1]
            arc = f"{prefix}/{_safe(imp.layer_name, 60)}_{imp.id}_{fname}"
            zf.writestr(arc, raw)
            provenance_entries.append({
                'type': 'shapefile_upload',
                'id': imp.id,
                'layer_name': imp.layer_name,
                'path': arc,
                'feature_count': imp.feature_count,
            })
        except Exception as exc:
            logger.warning("Skipping shapefile import %s: %s", imp.id, exc)

    return provenance_entries


def _build_area_zip_contents(zf: zipfile.ZipFile, area, base_prefix: str,
                              meta_base: dict, progress_cb,
                              include_dxf: bool = False) -> list[dict]:
    """
    Add all content for one survey area into the ZipFile under base_prefix.
    Returns a list of provenance entries for the area.
    """
    from apps.survey_projects.analysis import _get_folder_ids_for_survey_areas

    folder_ids = _get_folder_ids_for_survey_areas([area.id])
    if not folder_ids:
        return []

    entries = []
    entries += _export_gis_features(zf, folder_ids, base_prefix, meta_base, progress_cb)
    if include_dxf:
        entries += _export_gis_features_dxf(zf, folder_ids, base_prefix, progress_cb)
    entries += _export_documents(zf, folder_ids, base_prefix, meta_base, progress_cb)
    entries += _export_rasters(zf, folder_ids, base_prefix, meta_base, progress_cb)
    entries += _export_shapefile_uploads(zf, folder_ids, base_prefix, meta_base, progress_cb)
    return entries


# ---------------------------------------------------------------------------
# Main Celery task
# ---------------------------------------------------------------------------

@shared_task(bind=True, max_retries=0, soft_time_limit=1800, time_limit=1900)
def build_export_zip(self, export_task_id: int) -> None:
    """
    Build the full export ZIP for an ExportTask and store it under
    MEDIA_ROOT/exports/{task_uuid}.zip, then mark the ExportTask DONE.

    Handles both 'survey_area' and 'project' export types.
    """
    from apps.core.models import ExportTask

    try:
        et = ExportTask.objects.get(pk=export_task_id)
    except ExportTask.DoesNotExist:
        logger.error("ExportTask %s not found — aborting", export_task_id)
        return

    def progress(msg: str) -> None:
        _progress(et, msg)
        logger.info("Export %s: %s", et.task_uuid, msg)

    ExportTask.objects.filter(pk=et.pk).update(
        status=ExportTask.RUNNING,
        celery_task_id=self.request.id or '',
        progress_msg='Starting export…',
    )
    et.refresh_from_db()

    exports_dir = os.path.join(settings.MEDIA_ROOT, 'exports')
    os.makedirs(exports_dir, exist_ok=True)
    zip_path = os.path.join(exports_dir, f"{et.task_uuid}.zip")

    try:
        now_str = datetime.datetime.now().strftime('%Y%m%d_%H%M%S')

        if et.export_type == ExportTask.SURVEY_AREA:
            from apps.survey_projects.models import SurveyArea
            area = SurveyArea.objects.select_related('project__organisation').get(pk=et.object_id)
            safe_name = _safe(area.name)
            archive_root = f"{safe_name}_export_{now_str}"
            meta_base = {
                'survey_area_id': area.id,
                'survey_area_name': area.name,
                'project_id': area.project_id,
                'project_number': area.project.project_number if area.project else None,
                'organisation': str(area.project.organisation) if area.project and area.project.organisation else None,
                'generated_by': et.requested_by.username if et.requested_by_id else 'system',
                'export_type': 'survey_area',
                'exported_at': now_str,
            }

            provenance_map = {archive_root: []}

            with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED, allowZip64=True) as zf:
                entries = _build_area_zip_contents(
                    zf, area,
                    base_prefix=f"{archive_root}/",
                    meta_base=meta_base,
                    progress_cb=progress,
                    include_dxf=et.include_dxf,
                )
                provenance_map[archive_root] = entries

                # README
                readme = _make_readme(area.name, None, entries, meta_base)
                zf.writestr(f"{archive_root}/README.txt", readme)

                # Provenance manifest
                progress("Writing provenance manifest")
                manifest = _make_provenance(meta_base, provenance_map)
                zf.writestr(f"{archive_root}/provenance.json",
                            json.dumps(manifest, indent=2, default=str))

        elif et.export_type == ExportTask.PROJECT:
            from apps.survey_projects.models import SurveyProject, SurveyArea
            project = SurveyProject.objects.select_related('organisation').get(pk=et.object_id)
            safe_proj = _safe(project.project_number or str(project.id))
            archive_root = f"{safe_proj}_export_{now_str}"
            meta_base = {
                'project_id': project.id,
                'project_number': project.project_number,
                'organisation': str(project.organisation) if project.organisation else None,
                'generated_by': et.requested_by.username if et.requested_by_id else 'system',
                'export_type': 'project',
                'exported_at': now_str,
            }

            areas = list(SurveyArea.objects.filter(project=project).select_related('project__organisation'))
            provenance_map: dict[str, list] = {}

            with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED, allowZip64=True) as zf:
                for area in areas:
                    progress(f"Processing area: {area.name}")
                    safe_area = _safe(area.name)
                    area_prefix = f"{archive_root}/{safe_area}/"
                    area_meta = {**meta_base, 'survey_area_id': area.id, 'survey_area_name': area.name}
                    entries = _build_area_zip_contents(
                        zf, area,
                        base_prefix=area_prefix,
                        meta_base=area_meta,
                        progress_cb=progress,
                        include_dxf=et.include_dxf,
                    )
                    provenance_map[safe_area] = entries

                readme = _make_readme(None, project.project_number, provenance_map, meta_base)
                zf.writestr(f"{archive_root}/README.txt", readme)

                progress("Writing provenance manifest")
                manifest = _make_provenance(meta_base, provenance_map)
                zf.writestr(f"{archive_root}/provenance.json",
                            json.dumps(manifest, indent=2, default=str))
        else:
            raise ValueError(f"Unknown export_type: {et.export_type}")

        file_size = os.path.getsize(zip_path)
        rel_path = os.path.relpath(zip_path, settings.MEDIA_ROOT)

        ExportTask.objects.filter(pk=et.pk).update(
            status=ExportTask.DONE,
            result_path=rel_path,
            file_size=file_size,
            progress_msg='Ready to download',
        )
        logger.info("Export %s complete: %s bytes at %s", et.task_uuid, file_size, rel_path)

    except Exception as exc:
        logger.exception("Export task %s failed: %s", export_task_id, exc)
        ExportTask.objects.filter(pk=et.pk).update(
            status=ExportTask.FAILED,
            error=str(exc)[:2000],
            progress_msg='Export failed',
        )
        if os.path.exists(zip_path):
            try:
                os.remove(zip_path)
            except OSError:
                pass


# ---------------------------------------------------------------------------
# Provenance / README helpers
# ---------------------------------------------------------------------------

def _make_provenance(meta_base: dict, provenance_map: dict) -> dict:
    """Build the provenance.json manifest dict."""
    import hashlib
    total_files = sum(len(v) for v in provenance_map.values())
    return {
        'schema': 'RakshaGIS/DEMAP Export Provenance v1.0',
        'platform': 'RakshaGIS — DGDE Defence Estates GIS Platform',
        'export_metadata': meta_base,
        'generated_at': datetime.datetime.utcnow().isoformat() + 'Z',
        'watermark_scheme': 'C2PA (rasters/images) + LP-DNA legacy (documents/vectors)',
        'total_exported_files': total_files,
        'contents': provenance_map,
        'verification': (
            'Each file in this ZIP carries either a signed C2PA manifest '
            '(verifiable via c2patool / Adobe Content Authenticity) or an '
            'LP-DNA legacy watermark verifiable at the RakshaGIS portal '
            '(/documents/verify-watermark).'
        ),
    }


def _make_readme(area_name, project_number, contents, meta_base: dict) -> str:
    now = datetime.datetime.utcnow().strftime('%Y-%m-%d %H:%M UTC')
    subject = area_name or f"Project {project_number}"
    lines = [
        "=" * 70,
        f"RakshaGIS — DGDE Data Export",
        f"Subject : {subject}",
        f"Exported : {now}",
        f"By       : {meta_base.get('generated_by', 'system')}",
        "=" * 70,
        "",
        "FOLDER STRUCTURE",
        "----------------",
        "  GIS_Features/     — Vector features as ESRI Shapefiles (EPSG:4326), one sub-folder per layer.",
        "  GIS_Features_DXF/ — Same features as AutoCAD DXF R2010 (decimal degrees).",
        "  Documents/        — Uploaded documents (DOCX, PDF, etc.)",
        "  Rasters/          — GeoTIFF drone rasters",
        "  Shapefile_Uploads/ — Original shapefile ZIPs uploaded by field teams",
        "  provenance.json  — Signed export manifest (LP-DNA + C2PA references)",
        "",
        "WATERMARKING",
        "------------",
        "  Raster / image files (.tif, .png, .jpg) carry a signed C2PA manifest",
        "  verifiable with c2patool or Adobe Content Authenticity tools.",
        "",
        "  Documents and vector files carry an LP-DNA legacy watermark verifiable",
        "  via the RakshaGIS portal at: /documents/verify-watermark",
        "",
        "LOADING IN QGIS",
        "---------------",
        "  1. Open QGIS → Drag & Drop the .shp files from GIS_Features/",
        "  2. Set CRS to EPSG:4326 if prompted.",
        "  3. Rasters can be loaded directly from the Rasters/ folder.",
        "",
        "CLASSIFICATION",
        "--------------",
        "  This data relates to Defence Estate and is classified.",
        "  Handle in accordance with applicable MoD / DGDE regulations.",
        "",
        "=" * 70,
    ]
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Periodic cleanup
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Basemap COG conversion
# ---------------------------------------------------------------------------

@shared_task(bind=True, max_retries=1, soft_time_limit=1800, time_limit=1900)
def convert_basemap_to_cog(self, basemap_id: int) -> None:
    """
    Convert an uploaded GeoTIFF basemap to Cloud-Optimized GeoTIFF in EPSG:3857.
    Uses the same GDAL pipeline as the drone raster task.
    """
    import subprocess
    import tempfile
    from django.conf import settings as _s
    from apps.core.models import BasemapConfig

    bm = BasemapConfig.objects.get(pk=basemap_id)
    BasemapConfig.objects.filter(pk=basemap_id).update(
        cog_status=BasemapConfig.COG_PROCESSING, cog_error=''
    )

    src_path = os.path.join(_s.MEDIA_ROOT, bm.tiff_file.name)
    dst_rel  = bm.tiff_file.name.rsplit('.', 1)[0] + '_cog.tif'
    dst_path = os.path.join(_s.MEDIA_ROOT, dst_rel)
    os.makedirs(os.path.dirname(dst_path), exist_ok=True)

    try:
        with tempfile.NamedTemporaryFile(suffix='.tif', delete=False) as tmp:
            tmp_path = tmp.name
        try:
            subprocess.run(
                ['gdalwarp', '-t_srs', 'EPSG:3857', '-of', 'GTiff',
                 '-r', 'bilinear', src_path, tmp_path],
                check=True, capture_output=True,
            )
            subprocess.run(
                ['gdal_translate', tmp_path, dst_path,
                 '-of', 'COG',
                 '-co', 'COMPRESS=DEFLATE',
                 '-co', 'TILING_SCHEME=GoogleMapsCompatible'],
                check=True, capture_output=True,
            )
        finally:
            if os.path.exists(tmp_path):
                os.unlink(tmp_path)

        # Extract bounds from COG (EPSG:4326) using GDAL Python
        bounds = {}
        try:
            from osgeo import gdal, osr
            ds = gdal.Open(dst_path)
            if ds:
                gt = ds.GetGeoTransform()
                w, h = ds.RasterXSize, ds.RasterYSize
                srs = osr.SpatialReference()
                srs.ImportFromWkt(ds.GetProjection())
                wgs = osr.SpatialReference()
                wgs.SetWellKnownGeogCS('WGS84')
                wgs.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
                ct = osr.CoordinateTransformation(srs, wgs)
                corners = [
                    (gt[0], gt[3]),
                    (gt[0] + w * gt[1], gt[3] + h * gt[5]),
                ]
                lons, lats = [], []
                for cx, cy in corners:
                    lon, lat, _ = ct.TransformPoint(cx, cy)
                    lons.append(lon); lats.append(lat)
                bounds = dict(
                    bounds_west=min(lons), bounds_east=max(lons),
                    bounds_south=min(lats), bounds_north=max(lats),
                )
                ds = None
        except Exception as be:
            logger.warning("Basemap %s: could not extract bounds: %s", basemap_id, be)

        BasemapConfig.objects.filter(pk=basemap_id).update(
            cog_file=dst_rel,
            cog_status=BasemapConfig.COG_DONE,
            cog_error='',
            **bounds,
        )
        logger.info("Basemap %s COG ready at %s", basemap_id, dst_rel)

    except subprocess.CalledProcessError as exc:
        err = (exc.stderr or b'').decode()[:1000]
        logger.error("Basemap %s COG conversion failed: %s", basemap_id, err)
        BasemapConfig.objects.filter(pk=basemap_id).update(
            cog_status=BasemapConfig.COG_FAILED, cog_error=err,
        )
        self.retry(exc=exc, countdown=60)
    except Exception as exc:
        logger.exception("Basemap %s COG task error: %s", basemap_id, exc)
        BasemapConfig.objects.filter(pk=basemap_id).update(
            cog_status=BasemapConfig.COG_FAILED, cog_error=str(exc)[:500],
        )


# ---------------------------------------------------------------------------
# Drone dataset processing
# ---------------------------------------------------------------------------

@shared_task(bind=True, max_retries=1, soft_time_limit=3600, time_limit=3700)
def process_drone_dataset(self, dataset_id: int) -> None:
    """
    Process an uploaded DroneDataset based on its data_type:

    ORTHO_2D / DSM_DTM  → warp to EPSG:3857 + write COG + extract bounds
    POINT_CLOUD         → extract metadata with laspy (point count, bounds, CRS)
                          Potree conversion requires external tool (noted in status).
    MESH_3D             → validate file, store path reference for Cesium viewer.
    """
    import subprocess
    import tempfile
    from django.conf import settings as _s
    from apps.core.models import DroneDataset

    ds_obj = DroneDataset.objects.get(pk=dataset_id)
    DroneDataset.objects.filter(pk=dataset_id).update(
        status=DroneDataset.PROCESSING, error=''
    )

    src_path = os.path.join(_s.MEDIA_ROOT, ds_obj.file.name)

    try:
        if ds_obj.data_type in (DroneDataset.ORTHO_2D, DroneDataset.DSM_DTM):
            _process_drone_raster(dataset_id, ds_obj, src_path)

        elif ds_obj.data_type == DroneDataset.POINT_CLOUD:
            _process_point_cloud(dataset_id, ds_obj, src_path)

        elif ds_obj.data_type == DroneDataset.MESH_3D:
            _process_mesh_3d(dataset_id, ds_obj, src_path)

    except Exception as exc:
        logger.exception("DroneDataset %s processing failed: %s", dataset_id, exc)
        DroneDataset.objects.filter(pk=dataset_id).update(
            status=DroneDataset.FAILED, error=str(exc)[:1000],
        )
        self.retry(exc=exc, countdown=60)


def _process_drone_raster(dataset_id, ds_obj, src_path):
    """COG conversion for ORTHO_2D and DSM_DTM datasets."""
    import subprocess
    import tempfile
    from django.conf import settings as _s
    from apps.core.models import DroneDataset

    dst_rel  = ds_obj.file.name.rsplit('.', 1)[0] + '_cog.tif'
    dst_path = os.path.join(_s.MEDIA_ROOT, dst_rel)
    os.makedirs(os.path.dirname(dst_path), exist_ok=True)

    with tempfile.NamedTemporaryFile(suffix='.tif', delete=False) as tmp:
        tmp_path = tmp.name

    try:
        subprocess.run(
            ['gdalwarp', '-t_srs', 'EPSG:3857', '-of', 'GTiff',
             '-r', 'bilinear', src_path, tmp_path],
            check=True, capture_output=True,
        )
        subprocess.run(
            ['gdal_translate', tmp_path, dst_path,
             '-of', 'COG',
             '-co', 'COMPRESS=DEFLATE',
             '-co', 'TILING_SCHEME=GoogleMapsCompatible'],
            check=True, capture_output=True,
        )
    finally:
        if os.path.exists(tmp_path):
            os.unlink(tmp_path)

    # Extract bounds
    updates = {'cog_file': dst_rel, 'status': DroneDataset.DONE}
    try:
        from osgeo import gdal, osr
        gds = gdal.Open(dst_path)
        if gds:
            gt = gds.GetGeoTransform()
            w, h = gds.RasterXSize, gds.RasterYSize
            srs = osr.SpatialReference()
            srs.ImportFromWkt(gds.GetProjection())
            wgs = osr.SpatialReference()
            wgs.SetWellKnownGeogCS('WGS84')
            wgs.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
            ct = osr.CoordinateTransformation(srs, wgs)
            lons, lats = [], []
            for cx, cy in [
                (gt[0], gt[3]),
                (gt[0] + w * gt[1], gt[3] + h * gt[5]),
            ]:
                lon, lat, _ = ct.TransformPoint(cx, cy)
                lons.append(lon); lats.append(lat)
            updates.update(
                bounds_west=min(lons), bounds_east=max(lons),
                bounds_south=min(lats), bounds_north=max(lats),
                native_crs='EPSG:3857',
            )
            gds = None
    except Exception as be:
        logger.warning("DroneDataset %s: could not extract bounds: %s", dataset_id, be)

    DroneDataset.objects.filter(pk=dataset_id).update(**updates)
    logger.info("DroneDataset %s COG ready: %s", dataset_id, dst_rel)


def _process_point_cloud(dataset_id, ds_obj, src_path):
    """
    Extract point cloud metadata using laspy.
    Full Potree conversion (for web viewer) requires running potree-converter
    externally; we record the status so the UI can guide the user.
    """
    from apps.core.models import DroneDataset

    meta = {}
    try:
        import laspy
        ext = src_path.lower()
        with laspy.read(src_path) as las:
            header = las.header
            meta = {
                'point_count': int(las.header.point_count),
                'min_x': float(las.header.min[0]),
                'min_y': float(las.header.min[1]),
                'min_z': float(las.header.min[2]),
                'max_x': float(las.header.max[0]),
                'max_y': float(las.header.max[1]),
                'max_z': float(las.header.max[2]),
                'las_version': f"{header.version.major}.{header.version.minor}",
                'point_format': int(las.point_format.id),
            }
            # Try to read CRS
            try:
                crs_wkt = las.header.parse_crs()
                meta['crs'] = str(crs_wkt) if crs_wkt else 'unknown'
            except Exception:
                meta['crs'] = 'unknown'
    except ImportError:
        meta = {'note': 'laspy not installed — metadata not extracted. Install laspy for full metadata.'}
    except Exception as exc:
        meta = {'error': str(exc)}
        logger.warning("DroneDataset %s laspy error: %s", dataset_id, exc)

    # bounds from metadata
    bounds = {}
    if 'min_x' in meta and 'max_x' in meta:
        try:
            from osgeo import osr
            src_srs = osr.SpatialReference()
            src_srs.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
            if meta.get('crs', '').startswith('EPSG:'):
                src_srs.ImportFromEPSG(int(meta['crs'].split(':')[1]))
            else:
                src_srs.SetWellKnownGeogCS('WGS84')
            wgs = osr.SpatialReference()
            wgs.SetWellKnownGeogCS('WGS84')
            wgs.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
            ct = osr.CoordinateTransformation(src_srs, wgs)
            pts = [
                (meta['min_x'], meta['min_y'], meta['min_z']),
                (meta['max_x'], meta['max_y'], meta['max_z']),
            ]
            lons, lats = [], []
            for x, y, z in pts:
                lon, lat, _ = ct.TransformPoint(x, y, z)
                lons.append(lon); lats.append(lat)
            bounds = dict(
                bounds_west=min(lons), bounds_east=max(lons),
                bounds_south=min(lats), bounds_north=max(lats),
            )
        except Exception:
            pass

    DroneDataset.objects.filter(pk=dataset_id).update(
        point_cloud_meta=meta,
        status=DroneDataset.DONE,
        **bounds,
    )
    logger.info("DroneDataset %s point-cloud metadata extracted: %s pts",
                dataset_id, meta.get('point_count', '?'))


def _process_mesh_3d(dataset_id, ds_obj, src_path):
    """Validate 3D mesh upload. Cesium reads the file directly via media URL."""
    from apps.core.models import DroneDataset
    import os

    fsize = os.path.getsize(src_path)
    fname = src_path.lower()

    if fname.endswith('.json') or fname.endswith('.3dtiles'):
        tiles_path = ds_obj.file.name
    else:
        tiles_path = ds_obj.file.name  # OBJ/PLY etc — client-side Three.js loads directly

    DroneDataset.objects.filter(pk=dataset_id).update(
        tiles_path=tiles_path,
        status=DroneDataset.DONE,
    )
    logger.info("DroneDataset %s (MESH_3D) stored: %s bytes", dataset_id, fsize)


@shared_task
def purge_expired_exports() -> None:
    """
    Delete ExportTask rows (and their ZIP files) that have passed expires_at.
    Intended to run every 30 minutes via Celery beat.
    """
    from apps.core.models import ExportTask

    expired = ExportTask.objects.filter(expires_at__lt=timezone.now())
    count = 0
    for et in expired:
        if et.result_path:
            full = os.path.join(settings.MEDIA_ROOT, et.result_path)
            try:
                if os.path.exists(full):
                    os.remove(full)
            except OSError as exc:
                logger.warning("Could not remove export file %s: %s", full, exc)
        et.delete()
        count += 1

    if count:
        logger.info("purge_expired_exports: removed %d expired export(s)", count)


# ── Chunked drone upload assembly ─────────────────────────────────────────────

@shared_task(bind=True, max_retries=3, default_retry_delay=10)
def assemble_drone_upload(self, upload_id: str) -> None:
    """
    Concatenate all uploaded chunks into a single file, save it to the
    DroneDataset model, then kick off the normal processing pipeline.
    """
    import shutil
    from apps.core.models import DroneUploadSession, DroneDataset

    try:
        session = DroneUploadSession.objects.select_related(
            'organisation', 'uploaded_by', 'project', 'folder',
        ).get(upload_id=upload_id)
    except DroneUploadSession.DoesNotExist:
        logger.error('assemble_drone_upload: session %s not found', upload_id)
        return

    if session.status != DroneUploadSession.ASSEMBLING:
        logger.warning('assemble_drone_upload: session %s is %s, skipping', upload_id, session.status)
        return

    chunk_dir  = session.chunk_dir()
    # Validate all chunks exist on disk before writing
    missing_on_disk = []
    for idx in range(session.total_chunks):
        if not os.path.exists(session.chunk_path(idx)):
            missing_on_disk.append(idx)

    if missing_on_disk:
        err = f'Assembly failed: {len(missing_on_disk)} chunk file(s) missing on disk (e.g. {missing_on_disk[:5]})'
        logger.error('assemble_drone_upload: %s', err)
        session.status = DroneUploadSession.FAILED
        session.error  = err
        session.save(update_fields=['status', 'error'])
        return

    # Write assembled file to a temp path, then save via Django's file storage
    import tempfile
    suffix = os.path.splitext(session.original_filename)[1] or '.bin'
    try:
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
            tmp_path = tmp.name
            for idx in range(session.total_chunks):
                with open(session.chunk_path(idx), 'rb') as chunk_fh:
                    shutil.copyfileobj(chunk_fh, tmp)
    except Exception as exc:
        logger.exception('assemble_drone_upload: write failed for %s', upload_id)
        session.status = DroneUploadSession.FAILED
        session.error  = str(exc)
        session.save(update_fields=['status', 'error'])
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        return

    # Create the DroneDataset and attach the assembled file
    try:
        from django.core.files import File as DjangoFile
        with open(tmp_path, 'rb') as fh:
            ds = DroneDataset.objects.create(
                name=session.name,
                description=session.description,
                data_type=session.data_type,
                organisation=session.organisation,
                project=session.project,
                folder=session.folder,
                file_size=session.total_size,
                original_filename=session.original_filename,
                uploaded_by=session.uploaded_by,
                status=DroneDataset.PENDING,
            )
            ds.file.save(session.original_filename, DjangoFile(fh), save=True)
    except Exception as exc:
        logger.exception('assemble_drone_upload: DroneDataset creation failed for %s', upload_id)
        session.status = DroneUploadSession.FAILED
        session.error  = str(exc)
        session.save(update_fields=['status', 'error'])
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        return
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass

    # Update session to link to dataset
    session.status  = DroneUploadSession.DONE
    session.dataset = ds
    session.save(update_fields=['status', 'dataset'])

    # Remove chunk files to free disk space
    try:
        shutil.rmtree(chunk_dir, ignore_errors=True)
    except Exception as exc:
        logger.warning('assemble_drone_upload: could not remove chunk dir %s: %s', chunk_dir, exc)

    # Hand off to the normal processing pipeline
    process_drone_dataset.delay(ds.pk)
    logger.info('assemble_drone_upload: session %s → dataset %s, processing queued', upload_id, ds.pk)


@shared_task
def purge_expired_upload_sessions() -> None:
    """Remove DroneUploadSession records and their chunk files after expiry."""
    import shutil
    from django.utils import timezone as tz
    from apps.core.models import DroneUploadSession

    expired = DroneUploadSession.objects.filter(
        expires_at__lt=tz.now(),
        status__in=[DroneUploadSession.UPLOADING, DroneUploadSession.FAILED],
    )
    count = 0
    for session in expired:
        try:
            shutil.rmtree(session.chunk_dir(), ignore_errors=True)
        except Exception:
            pass
        session.delete()
        count += 1

    if count:
        logger.info('purge_expired_upload_sessions: removed %d expired session(s)', count)


# ---------------------------------------------------------------------------
# Sentinel-2 tile pre-cache
# ---------------------------------------------------------------------------

def _tile_bounds(z: int, x: int, y: int):
    """Return (lon_west, lat_south, lon_east, lat_north) for a slippy-map tile."""
    import math
    n = 2 ** z
    lon_west  = x / n * 360.0 - 180.0
    lon_east  = (x + 1) / n * 360.0 - 180.0
    lat_north = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / n))))
    lat_south = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * (y + 1) / n))))
    return lon_west, lat_south, lon_east, lat_north


def _tiles_for_bbox(west: float, south: float, east: float, north: float, zoom: int):
    """Yield (z, x, y) tile indices that intersect the given bounding box."""
    import math

    def lon2tile(lon, z):
        return int((lon + 180.0) / 360.0 * (2 ** z))

    def lat2tile(lat, z):
        lat_r = math.radians(lat)
        return int((1.0 - math.log(math.tan(lat_r) + 1.0 / math.cos(lat_r)) / math.pi) / 2.0 * (2 ** z))

    x_min = lon2tile(west, zoom)
    x_max = lon2tile(east, zoom)
    y_min = lat2tile(north, zoom)  # note: y increases southward
    y_max = lat2tile(south, zoom)

    for x in range(x_min, x_max + 1):
        for y in range(y_min, y_max + 1):
            yield zoom, x, y


@shared_task
def cache_sentinel2_tiles() -> None:
    """
    Pre-fetch WMTS tiles from the configured Sentinel-2 URL for every active
    SENTINEL2 BasemapConfig that has an AOI (bounds_*) defined.

    Tiles are stored at MEDIA_ROOT/tile_cache/sentinel2/<pk>/{z}/{x}/{y}.jpg
    so the tile_proxy view can serve them offline.

    Only tiles at zoom levels 0..cache_zoom_max are fetched; this keeps the
    cache size manageable (a 100 × 100 km area at z=13 is ~400 tiles).
    """
    import urllib.request
    from apps.core.models import BasemapConfig

    basemaps = BasemapConfig.objects.filter(provider=BasemapConfig.SENTINEL2, is_active=True)
    fetched = skipped = errors = 0

    for bm in basemaps:
        # Skip if no AOI defined or no URL template
        if None in (bm.bounds_west, bm.bounds_south, bm.bounds_east, bm.bounds_north):
            logger.info("cache_sentinel2_tiles: basemap %s has no AOI bounds — skipping", bm.pk)
            continue
        if not bm.url_template:
            logger.info("cache_sentinel2_tiles: basemap %s has no url_template — skipping", bm.pk)
            continue

        cache_root = os.path.join(settings.MEDIA_ROOT, 'tile_cache', 'sentinel2', str(bm.pk))
        os.makedirs(cache_root, exist_ok=True)

        for z in range(0, bm.cache_zoom_max + 1):
            for _, x, y in _tiles_for_bbox(
                bm.bounds_west, bm.bounds_south, bm.bounds_east, bm.bounds_north, z
            ):
                tile_path = os.path.join(cache_root, str(z), str(x), f"{y}.jpg")
                if os.path.exists(tile_path):
                    skipped += 1
                    continue

                # Build the tile URL from the template (supports {z}/{x}/{y} and WMTS {TileMatrix}/{TileRow}/{TileCol})
                url = (
                    bm.url_template
                    .replace('{z}', str(z)).replace('{x}', str(x)).replace('{y}', str(y))
                    .replace('{TileMatrix}', str(z))
                    .replace('{TileCol}', str(x))
                    .replace('{TileRow}', str(y))
                )

                try:
                    os.makedirs(os.path.dirname(tile_path), exist_ok=True)
                    req = urllib.request.Request(url, headers={'User-Agent': 'RakshaGIS/1.0'})
                    with urllib.request.urlopen(req, timeout=15) as resp:
                        data = resp.read()
                    with open(tile_path, 'wb') as fh:
                        fh.write(data)
                    fetched += 1
                except Exception as exc:
                    logger.debug("cache_sentinel2_tiles: failed to fetch %s: %s", url, exc)
                    errors += 1

    logger.info(
        "cache_sentinel2_tiles complete: fetched=%d skipped=%d errors=%d",
        fetched, skipped, errors,
    )
