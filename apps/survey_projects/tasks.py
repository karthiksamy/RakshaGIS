import json
import os
import shutil
import subprocess
import tempfile
import zipfile

from celery import shared_task
from django.utils import timezone


@shared_task(bind=True, max_retries=1)
def import_shapefile(self, job_id: int):
    """
    Reads a .zip shapefile, reprojects to SRID 4326, and bulk-creates GISFeature rows.
    Validates attributes against AttributeTemplate if one is attached to the job.
    """
    from django.conf import settings
    from apps.survey_projects.models import ShapefileImport, GISFeature

    job = ShapefileImport.objects.select_related('project', 'created_by', 'attribute_template').get(id=job_id)
    job.status = ShapefileImport.RUNNING
    job.save(update_fields=['status'])

    try:
        import fiona
        import fiona.transform
        from django.contrib.gis.geos import GEOSGeometry

        zip_path = os.path.join(settings.MEDIA_ROOT, job.file.name)

        geom_type_map = {
            'Point':           GISFeature.POINT,
            'MultiPoint':      GISFeature.POINT,
            'LineString':      GISFeature.LINE,
            'MultiLineString': GISFeature.LINE,
            'Polygon':         GISFeature.POLYGON,
            'MultiPolygon':    GISFeature.POLYGON,
        }

        template_fields = {}
        if job.attribute_template:
            template_fields = {
                f['name']: f for f in (job.attribute_template.fields or [])
            }

        features_to_create = []

        with tempfile.TemporaryDirectory() as tmpdir:
            with zipfile.ZipFile(zip_path, 'r') as zf:
                zf.extractall(tmpdir)

            shp_files = [f for f in os.listdir(tmpdir) if f.lower().endswith('.shp')]
            if not shp_files:
                raise ValueError("No .shp file found in the uploaded zip archive.")

            shp_path = os.path.join(tmpdir, shp_files[0])

            with fiona.open(shp_path) as src:
                src_crs = src.crs_wkt or 'EPSG:4326'
                detected_columns = list(src.schema.get('properties', {}).keys())

                for feat in src:
                    if feat.geometry is None:
                        continue

                    # Reproject to WGS84 if needed
                    geom_geojson = fiona.transform.transform_geom(
                        src_crs, 'EPSG:4326', feat.geometry
                    )
                    # fiona ≥1.9 returns fiona.model.Geometry objects — convert
                    # to a plain dict or json.dumps fails ("not JSON serializable")
                    try:
                        from fiona.model import to_dict as _to_dict
                        geom_geojson = _to_dict(geom_geojson)
                    except ImportError:
                        pass

                    geom_type = geom_type_map.get(geom_geojson['type'], GISFeature.POLYGON)
                    geos_geom = GEOSGeometry(json.dumps(geom_geojson), srid=4326)

                    # Build attributes dict; filter to template fields if template is set
                    raw_props = dict(feat.properties or {})
                    if template_fields:
                        attrs = {k: raw_props.get(k) for k in template_fields}
                    else:
                        attrs = raw_props

                    # Assign Land_Parcel_ID (eNLI) — bulk_create bypasses model.save()
                    from apps.survey_projects.enli_utils import ensure_land_parcel_id
                    attrs = ensure_land_parcel_id(attrs, geos_geom)

                    features_to_create.append(GISFeature(
                        project=job.project,
                        layer_name=job.layer_name,
                        geometry_type=geom_type,
                        geometry=geos_geom,
                        attributes=attrs,
                        created_by=job.created_by,
                        folder=job.folder,
                        deo_visible=job.deo_visible,
                    ))

        GISFeature.objects.bulk_create(features_to_create, batch_size=500)

        job.status = ShapefileImport.DONE
        job.feature_count = len(features_to_create)
        job.columns = detected_columns
        job.error = ''

        # ── Post-import attribute QA (rule-based, instant) ────────────────────
        try:
            job.validation_warnings = _validate_imported_features(job)
        except Exception:
            job.validation_warnings = []

    except Exception as exc:
        job.status = ShapefileImport.FAILED
        job.error = str(exc)
        self.retry(exc=exc, countdown=15)

    finally:
        job.save(update_fields=['status', 'feature_count', 'columns', 'error',
                                'validation_warnings'])

    # AI review runs async after the import is saved (LLM may be slow/offline)
    if job.status == ShapefileImport.DONE:
        try:
            from apps.ai_assistant.models import AITask
            from apps.ai_assistant.tasks import validate_import_attributes
            ai_task = AITask.objects.create(
                task_type=AITask.ATTRIBUTE_VALIDATION,
                requested_by=job.created_by,
                input_data={'shapefile_import_id': job.id},
            )
            validate_import_attributes.delay(ai_task.id)
        except Exception:
            pass


# Rough India envelope incl. island territories — flags obviously wrong CRS/data
_EXPECTED_BBOX = (66.0, 5.0, 100.0, 38.0)   # minLon, minLat, maxLon, maxLat


def _validate_imported_features(job):
    """Deterministic QA checks on the features created by a shapefile import.

    Returns a list of {level, code, message} dicts stored on the import record
    and rendered inline in the import modal.
    """
    from apps.survey_projects.models import GISFeature

    warnings = []
    feats = GISFeature.objects.filter(
        project=job.project, layer_name=job.layer_name, is_deleted=False,
    ).only('feature_id', 'attributes', 'geometry', 'geometry_type')

    required = []
    if job.attribute_template:
        required = [f['name'] for f in (job.attribute_template.fields or [])
                    if f.get('required')]

    seen_ids: set = set()
    dup_ids: set = set()
    missing = {name: 0 for name in required}
    zero_area = out_of_bbox = empty_attrs = total = 0

    for f in feats.iterator(chunk_size=500):
        total += 1
        fid = (f.feature_id or '').strip()
        if fid:
            if fid in seen_ids:
                dup_ids.add(fid)
            seen_ids.add(fid)

        attrs = f.attributes or {}
        if not attrs:
            empty_attrs += 1
        for name in required:
            v = attrs.get(name)
            if v is None or v == '':
                missing[name] += 1

        try:
            xmin, ymin, xmax, ymax = f.geometry.extent
            if (xmin < _EXPECTED_BBOX[0] or ymin < _EXPECTED_BBOX[1] or
                    xmax > _EXPECTED_BBOX[2] or ymax > _EXPECTED_BBOX[3]):
                out_of_bbox += 1
            if f.geometry_type == GISFeature.POLYGON and f.geometry.area == 0:
                zero_area += 1
        except Exception:
            pass

    if dup_ids:
        sample = ', '.join(sorted(dup_ids)[:5])
        warnings.append({
            'level': 'error', 'code': 'duplicate_ids',
            'message': f'{len(dup_ids)} duplicate feature ID(s) found (e.g. {sample}).',
        })
    for name, count in missing.items():
        if count:
            warnings.append({
                'level': 'error', 'code': 'missing_required',
                'message': f'Required attribute "{name}" is empty on {count} of {total} features.',
            })
    if zero_area:
        warnings.append({
            'level': 'warning', 'code': 'zero_area',
            'message': f'{zero_area} polygon(s) have zero area (degenerate geometry).',
        })
    if out_of_bbox:
        warnings.append({
            'level': 'warning', 'code': 'out_of_bbox',
            'message': f'{out_of_bbox} feature(s) fall outside the expected India extent '
                       f'— check the source CRS.',
        })
    if empty_attrs:
        warnings.append({
            'level': 'warning', 'code': 'empty_attributes',
            'message': f'{empty_attrs} feature(s) have no attributes at all.',
        })
    if not warnings:
        warnings.append({
            'level': 'info', 'code': 'ok',
            'message': f'All {total} features passed attribute and geometry checks.',
        })
    return warnings


@shared_task(bind=True, max_retries=1)
def convert_geotiff_to_cog(self, geotiff_id: int):
    """Convert an uploaded GeoTiff to Cloud-Optimized GeoTIFF (COG) using GDAL."""
    from django.conf import settings
    from apps.survey_projects.models import GeoTiffLayer

    layer = GeoTiffLayer.objects.get(id=geotiff_id)
    layer.status = GeoTiffLayer.PROCESSING
    layer.save(update_fields=['status'])

    try:
        src_path = os.path.join(settings.MEDIA_ROOT, layer.file.name)
        dst_rel = layer.file.name.rsplit('.', 1)[0] + '_cog.tif'
        dst_path = os.path.join(settings.MEDIA_ROOT, dst_rel)

        os.makedirs(os.path.dirname(dst_path), exist_ok=True)

        # Reproject to EPSG:3857 (Web Mercator) for OL display, then write COG
        with tempfile.NamedTemporaryFile(suffix='.tif', delete=False) as tmp:
            tmp_path = tmp.name

        try:
            # Step 1: Warp to 3857
            subprocess.run(
                ['gdalwarp', '-t_srs', 'EPSG:3857', '-of', 'GTiff', src_path, tmp_path],
                check=True, capture_output=True,
            )
            # Step 2: Translate to COG
            subprocess.run(
                [
                    'gdal_translate', tmp_path, dst_path,
                    '-of', 'COG',
                    '-co', 'COMPRESS=DEFLATE',
                    '-co', 'TILING_SCHEME=GoogleMapsCompatible',
                ],
                check=True, capture_output=True,
            )
        finally:
            if os.path.exists(tmp_path):
                os.unlink(tmp_path)

        layer.cog_file = dst_rel
        layer.status = GeoTiffLayer.DONE
        layer.error = ''

    except subprocess.CalledProcessError as exc:
        layer.status = GeoTiffLayer.FAILED
        layer.error = (exc.stderr or b'').decode()[:500]
        self.retry(exc=exc, countdown=30)
    except Exception as exc:
        layer.status = GeoTiffLayer.FAILED
        layer.error = str(exc)
        self.retry(exc=exc, countdown=30)
    finally:
        layer.save(update_fields=['status', 'cog_file', 'error'])
