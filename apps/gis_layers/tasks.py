import io
import json
import os
import tempfile
import zipfile
from datetime import datetime, timezone

from celery import shared_task
from django.conf import settings
from django.contrib.gis.geos import GEOSGeometry, MultiPolygon, Polygon
from django.db import transaction


@shared_task(bind=True, max_retries=0, name='gis_layers.import_boundary_shapefile')
def import_boundary_shapefile(self, job_id: int):
    from apps.gis_layers.models import BoundaryImportJob, State, District, Taluk, Village

    job = BoundaryImportJob.objects.get(id=job_id)
    job.status = BoundaryImportJob.RUNNING
    job.save(update_fields=['status'])

    errors_log = []

    try:
        import fiona
        import fiona.transform

        zip_path = os.path.join(settings.MEDIA_ROOT, job.file.name)

        with tempfile.TemporaryDirectory() as tmpdir:
            if zip_path.lower().endswith('.zip'):
                with zipfile.ZipFile(zip_path, 'r') as zf:
                    zf.extractall(tmpdir)
                shp_files = [f for f in os.listdir(tmpdir) if f.lower().endswith('.shp')]
                if not shp_files:
                    raise ValueError('No .shp file found in the uploaded zip archive.')
                shp_path = os.path.join(tmpdir, shp_files[0])
            else:
                shp_path = zip_path

            # Build parent lookup
            ModelClass = {'state': State, 'district': District,
                          'taluk': Taluk, 'village': Village}[job.level]

            parent_lookup = {}
            if job.level == 'district':
                parent_lookup = {s.code: s for s in State.objects.all()}
            elif job.level == 'taluk':
                parent_lookup = {d.code: d for d in District.objects.all()}
            elif job.level == 'village':
                parent_lookup = {t.code: t for t in Taluk.objects.all()}

            code_max_len = {'state': 5, 'district': 10, 'taluk': 15, 'village': 20}[job.level]

            if job.clear_existing:
                ModelClass.objects.all().delete()

            created = updated = skipped = errors = 0

            with fiona.open(shp_path) as src:
                src_crs = src.crs_wkt or 'EPSG:4326'

                records = []
                for feat in src:
                    if feat.geometry is None:
                        skipped += 1
                        continue

                    props = dict(feat.properties or {})
                    name = str(props.get(job.name_field, '') or '').strip()
                    code = str(props.get(job.code_field, '') or '').strip()[:code_max_len]

                    if not name or not code:
                        skipped += 1
                        continue

                    try:
                        geom_geojson = fiona.transform.transform_geom(
                            src_crs, 'EPSG:4326', feat.geometry
                        )
                        geos_geom = GEOSGeometry(json.dumps(geom_geojson), srid=4326)
                        geos_geom = _force_multipolygon(geos_geom)
                    except Exception as exc:
                        errors += 1
                        errors_log.append(f'{name}: geometry error — {exc}')
                        continue

                    record = {'name': name, 'geometry': geos_geom}
                    parent = None

                    if job.level in ('district', 'taluk', 'village'):
                        if job.spatial_parent:
                            parent = _find_parent_spatial(geos_geom, list(parent_lookup.values()))
                        elif job.parent_code_field:
                            pcode = str(props.get(job.parent_code_field, '') or '').strip()
                            parent = parent_lookup.get(pcode)

                        if parent is None:
                            skipped += 1
                            errors_log.append(f'{name}: parent not found')
                            continue

                        if job.level == 'district':
                            record['state'] = parent
                        elif job.level == 'taluk':
                            record['district'] = parent
                        elif job.level == 'village':
                            record['taluk'] = parent

                    records.append((code, record))

            with transaction.atomic():
                for code, record in records:
                    _, was_created = ModelClass.objects.update_or_create(
                        code=code, defaults=record
                    )
                    if was_created:
                        created += 1
                    else:
                        updated += 1

        job.status = BoundaryImportJob.DONE
        job.result = {
            'created': created, 'updated': updated,
            'skipped': skipped, 'errors': errors,
        }
        job.error_log = '\n'.join(errors_log[:200])
        job.completed_at = datetime.now(tz=timezone.utc)
        job.save(update_fields=['status', 'result', 'error_log', 'completed_at'])

    except Exception as exc:
        job.status = BoundaryImportJob.FAILED
        job.error_log = str(exc)
        job.completed_at = datetime.now(tz=timezone.utc)
        job.save(update_fields=['status', 'error_log', 'completed_at'])
        raise


def _force_multipolygon(geom):
    if isinstance(geom, MultiPolygon):
        return geom
    if isinstance(geom, Polygon):
        return MultiPolygon(geom, srid=4326)
    polys = []
    for i in range(geom.num_geom if hasattr(geom, 'num_geom') else 1):
        sub = geom[i] if hasattr(geom, '__getitem__') else geom
        if isinstance(sub, Polygon):
            polys.append(sub)
        elif isinstance(sub, MultiPolygon):
            polys.extend(list(sub))
    if polys:
        return MultiPolygon(polys, srid=4326)
    raise ValueError(f'Cannot convert geometry type {geom.geom_type} to MultiPolygon')


def _find_parent_spatial(child_geom, parent_objects):
    centroid = child_geom.centroid
    for parent in parent_objects:
        if parent.geometry and parent.geometry.contains(centroid):
            return parent
    best, best_dist = None, float('inf')
    for parent in parent_objects:
        if parent.geometry:
            d = parent.geometry.distance(centroid)
            if d < best_dist:
                best_dist, best = d, parent
    return best
