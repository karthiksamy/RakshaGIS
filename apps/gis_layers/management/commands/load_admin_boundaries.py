"""
Load administrative boundary shapefiles into RakshaGIS master data tables.

Usage:
  # States from GADM (GID_1 / NAME_1 convention)
  manage.py load_admin_boundaries --level state \\
      --file /data/gadm41_IND_1.shp \\
      --name-field NAME_1 --code-field GID_1

  # Districts — GID_1 in the shapefile must match State.code values already loaded
  manage.py load_admin_boundaries --level district \\
      --file /data/gadm41_IND_2.shp \\
      --name-field NAME_2 --code-field GID_2 --parent-code-field GID_1

  # Taluks
  manage.py load_admin_boundaries --level taluk \\
      --file /data/gadm41_IND_3.shp \\
      --name-field NAME_3 --code-field GID_3 --parent-code-field GID_2

  # Villages
  manage.py load_admin_boundaries --level village \\
      --file /data/gadm41_IND_4.shp \\
      --name-field NAME_4 --code-field GID_4 --parent-code-field GID_3

  # Census of India convention (states)
  manage.py load_admin_boundaries --level state \\
      --file /data/india_states.shp \\
      --name-field STATE --code-field STATE_ID

  # Truncate before loading, then import
  manage.py load_admin_boundaries --level state \\
      --file /data/states.shp --name-field NAME --code-field CODE --clear

  # Zip archive supported (one .shp inside)
  manage.py load_admin_boundaries --level district \\
      --file /data/districts.zip \\
      --name-field DISTRICT --code-field DIST_CODE --parent-code-field STATE_CODE

  # Preview without writing
  manage.py load_admin_boundaries --level state \\
      --file /data/states.shp --name-field NAME --code-field CODE --dry-run
"""

import json
import os
import tempfile
import zipfile

from django.contrib.gis.geos import GEOSGeometry, MultiPolygon, Polygon
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction


LEVEL_CHOICES = ('state', 'district', 'taluk', 'village')


class Command(BaseCommand):
    help = 'Import administrative boundary shapefiles into State/District/Taluk/Village tables.'

    def add_arguments(self, parser):
        parser.add_argument('--level', required=True, choices=LEVEL_CHOICES,
                            help='Hierarchy level to load.')
        parser.add_argument('--file', required=True,
                            help='Path to .shp or .zip shapefile.')
        parser.add_argument('--name-field', default='NAME',
                            help='Shapefile attribute for the record name. (default: NAME)')
        parser.add_argument('--code-field', default='CODE',
                            help='Shapefile attribute for the unique code. (default: CODE)')
        parser.add_argument('--parent-code-field', default=None,
                            help='Attribute whose value matches the parent table\'s code. '
                                 'Required for district/taluk/village unless --spatial-parent is used.')
        parser.add_argument('--spatial-parent', action='store_true',
                            help='Resolve parent by spatial centroid-in-polygon instead of code field.')
        parser.add_argument('--code-max-len', type=int, default=None,
                            help='Truncate generated code to this length (matches model field max_length).')
        parser.add_argument('--clear', action='store_true',
                            help='Delete all existing records for this level before importing.')
        parser.add_argument('--dry-run', action='store_true',
                            help='Parse and validate but do not write to the database.')
        parser.add_argument('--batch-size', type=int, default=500,
                            help='Bulk-create batch size. (default: 500)')

    # ------------------------------------------------------------------

    def handle(self, *args, **options):
        try:
            import fiona
            import fiona.transform
        except ImportError:
            raise CommandError('fiona is required. Install it with: pip install fiona')

        level = options['level']
        shp_path = options['file']
        name_field = options['name_field']
        code_field = options['code_field']
        parent_code_field = options['parent_code_field']
        spatial_parent = options['spatial_parent']
        clear = options['clear']
        dry_run = options['dry_run']
        batch_size = options['batch_size']

        if level in ('district', 'taluk', 'village') and not parent_code_field and not spatial_parent:
            raise CommandError(
                f'--parent-code-field is required for level "{level}" '
                f'(or use --spatial-parent to resolve parents geometrically).'
            )

        code_max_len = options['code_max_len'] or _CODE_MAX_LEN[level]

        # Resolve shapefile path (handle .zip)
        tmpdir_obj = None
        try:
            if shp_path.lower().endswith('.zip'):
                tmpdir_obj = tempfile.TemporaryDirectory()
                with zipfile.ZipFile(shp_path, 'r') as zf:
                    zf.extractall(tmpdir_obj.name)
                shp_files = [f for f in os.listdir(tmpdir_obj.name) if f.lower().endswith('.shp')]
                if not shp_files:
                    raise CommandError('No .shp file found inside the zip archive.')
                shp_path = os.path.join(tmpdir_obj.name, shp_files[0])

            if not os.path.isfile(shp_path):
                raise CommandError(f'File not found: {shp_path}')

            self._run(
                level=level,
                shp_path=shp_path,
                name_field=name_field,
                code_field=code_field,
                parent_code_field=parent_code_field,
                spatial_parent=spatial_parent,
                code_max_len=code_max_len,
                clear=clear,
                dry_run=dry_run,
                batch_size=batch_size,
                fiona=fiona,
            )
        finally:
            if tmpdir_obj:
                tmpdir_obj.cleanup()

    # ------------------------------------------------------------------

    def _run(self, *, level, shp_path, name_field, code_field, parent_code_field,
             spatial_parent, code_max_len, clear, dry_run, batch_size, fiona):
        from apps.gis_layers.models import State, District, Taluk, Village

        ModelClass = {'state': State, 'district': District, 'taluk': Taluk, 'village': Village}[level]

        # Preview shapefile schema
        with fiona.open(shp_path) as src:
            props = list(src.schema.get('properties', {}).keys())
            self.stdout.write(f'Shapefile CRS : {src.crs_wkt[:80] if src.crs_wkt else "unknown"}')
            self.stdout.write(f'Feature count : {len(src)}')
            self.stdout.write(f'Attributes    : {", ".join(props)}')

        missing = []
        for f in [name_field, code_field] + ([parent_code_field] if parent_code_field else []):
            if f not in props:
                missing.append(f)
        if missing:
            raise CommandError(
                f'These attribute fields were not found in the shapefile: {missing}\n'
                f'Available fields: {props}'
            )

        # Build parent lookup
        parent_lookup = {}
        if level == 'district':
            parent_lookup = {s.code: s for s in State.objects.all()}
        elif level == 'taluk':
            parent_lookup = {d.code: d for d in District.objects.all()}
        elif level == 'village':
            parent_lookup = {t.code: t for t in Taluk.objects.all()}

        if level in ('district', 'taluk', 'village') and not spatial_parent and not parent_lookup:
            raise CommandError(
                f'No parent records found for level "{level}". '
                f'Load the parent level first.'
            )

        # Spatial parent index (centroid-in-polygon)
        parent_geoms = None
        if spatial_parent and level in ('district', 'taluk', 'village'):
            parent_geoms = list(parent_lookup.values())

        if clear and not dry_run:
            count, _ = ModelClass.objects.all().delete()
            self.stdout.write(self.style.WARNING(f'Cleared {count} existing {level} records.'))

        created = updated = skipped = errors = 0
        to_create = []
        to_update = []

        with fiona.open(shp_path) as src:
            src_crs = src.crs_wkt or 'EPSG:4326'
            total = len(src)

            for i, feat in enumerate(src, start=1):
                if i % 200 == 0:
                    self.stdout.write(f'  Processing {i}/{total}…')

                if feat.geometry is None:
                    self.stderr.write(f'  [skip] Feature {i}: null geometry')
                    skipped += 1
                    continue

                props_dict = dict(feat.properties or {})
                name = str(props_dict.get(name_field, '') or '').strip()
                code = str(props_dict.get(code_field, '') or '').strip()

                if not name:
                    self.stderr.write(f'  [skip] Feature {i}: empty name')
                    skipped += 1
                    continue
                if not code:
                    self.stderr.write(f'  [skip] Feature {i}: empty code')
                    skipped += 1
                    continue

                code = code[:code_max_len]

                # Reproject and convert geometry
                try:
                    import fiona.transform
                    geom_geojson = fiona.transform.transform_geom(src_crs, 'EPSG:4326', feat.geometry)
                    geos_geom = GEOSGeometry(json.dumps(geom_geojson), srid=4326)
                    geos_geom = _force_multipolygon(geos_geom)
                except Exception as exc:
                    self.stderr.write(f'  [error] Feature {i} ({name}): geometry error — {exc}')
                    errors += 1
                    continue

                # Resolve parent
                parent = None
                if level in ('district', 'taluk', 'village'):
                    if spatial_parent and parent_geoms:
                        parent = _find_parent_spatial(geos_geom, parent_geoms)
                    elif parent_code_field:
                        parent_code = str(props_dict.get(parent_code_field, '') or '').strip()
                        parent = parent_lookup.get(parent_code)

                    if parent is None:
                        ref = parent_code if not spatial_parent else 'spatial'
                        self.stderr.write(
                            f'  [skip] Feature {i} ({name}): parent not found (ref={ref})'
                        )
                        skipped += 1
                        continue

                record = {'name': name, 'geometry': geos_geom}
                if level == 'district':
                    record['state'] = parent
                elif level == 'taluk':
                    record['district'] = parent
                elif level == 'village':
                    record['taluk'] = parent

                to_create.append((code, record))

        if dry_run:
            self.stdout.write(self.style.SUCCESS(
                f'\n[DRY RUN] Would process {len(to_create)} records '
                f'(skipped={skipped}, errors={errors}). No database changes made.'
            ))
            return

        # Write to DB in batches using update_or_create
        with transaction.atomic():
            for code, record in to_create:
                obj, was_created = ModelClass.objects.update_or_create(
                    code=code, defaults=record
                )
                if was_created:
                    created += 1
                else:
                    updated += 1

        self.stdout.write(self.style.SUCCESS(
            f'\nDone. created={created}, updated={updated}, skipped={skipped}, errors={errors}'
        ))


# ------------------------------------------------------------------
# Helpers
# ------------------------------------------------------------------

_CODE_MAX_LEN = {'state': 5, 'district': 10, 'taluk': 15, 'village': 20}


def _force_multipolygon(geom):
    if isinstance(geom, MultiPolygon):
        return geom
    if isinstance(geom, Polygon):
        return MultiPolygon(geom, srid=4326)
    # For GeometryCollection or other types, extract polygons
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
    """Return the parent whose geometry contains the centroid of child_geom."""
    centroid = child_geom.centroid
    for parent in parent_objects:
        if parent.geometry and parent.geometry.contains(centroid):
            return parent
    # Fallback: nearest parent by distance
    best = None
    best_dist = float('inf')
    for parent in parent_objects:
        if parent.geometry:
            d = parent.geometry.distance(centroid)
            if d < best_dist:
                best_dist = d
                best = parent
    return best
