import json
import os
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

                for feat in src:
                    if feat.geometry is None:
                        continue

                    # Reproject to WGS84 if needed
                    geom_geojson = fiona.transform.transform_geom(
                        src_crs, 'EPSG:4326', feat.geometry
                    )

                    geom_type = geom_type_map.get(geom_geojson['type'], GISFeature.POLYGON)
                    geos_geom = GEOSGeometry(json.dumps(geom_geojson), srid=4326)

                    # Build attributes dict; filter to template fields if template is set
                    raw_props = dict(feat.properties or {})
                    if template_fields:
                        attrs = {k: raw_props.get(k) for k in template_fields}
                    else:
                        attrs = raw_props

                    features_to_create.append(GISFeature(
                        project=job.project,
                        layer_name=job.layer_name,
                        geometry_type=geom_type,
                        geometry=geos_geom,
                        attributes=attrs,
                        created_by=job.created_by,
                    ))

        GISFeature.objects.bulk_create(features_to_create, batch_size=500)

        job.status = ShapefileImport.DONE
        job.feature_count = len(features_to_create)
        job.error = ''

    except Exception as exc:
        job.status = ShapefileImport.FAILED
        job.error = str(exc)
        self.retry(exc=exc, countdown=15)

    finally:
        job.save(update_fields=['status', 'feature_count', 'error'])
