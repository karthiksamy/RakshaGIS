"""
psycopg2 utilities for querying external PostgreSQL databases.
All functions return plain Python types — no ORM, no Django DB involved.
"""
from __future__ import annotations

import json
import logging
from contextlib import contextmanager
from typing import TYPE_CHECKING

import psycopg2
import psycopg2.extras

if TYPE_CHECKING:
    from .models import ExternalDatabase, ExternalLayer

logger = logging.getLogger(__name__)


_LOCAL_HOSTS = {'localhost', '127.0.0.1', '::1', '0.0.0.0'}


def _resolve_host(host: str) -> str:
    """
    Translate loopback addresses to host.docker.internal so the Django container
    can reach a PostgreSQL server running on the Docker host.
    The docker-compose.yml already maps host.docker.internal → host-gateway.
    """
    return 'host.docker.internal' if host.strip().lower() in _LOCAL_HOSTS else host


@contextmanager
def external_conn(db: 'ExternalDatabase'):
    """Context manager that yields a read-only psycopg2 connection to the external DB."""
    params = db.get_connection_params()
    params['host'] = _resolve_host(params['host'])
    conn = psycopg2.connect(**params)
    conn.set_session(readonly=True, autocommit=True)
    try:
        yield conn
    finally:
        conn.close()


# ── Connection test ──────────────────────────────────────────────────────────

def test_connection(db: 'ExternalDatabase') -> tuple[bool, str]:
    """Return (success, message)."""
    resolved = _resolve_host(db.host)
    try:
        with external_conn(db) as conn:
            with conn.cursor() as cur:
                cur.execute('SELECT version()')
                ver = cur.fetchone()[0]
        suffix = f' [via {resolved}]' if resolved != db.host else ''
        return True, ver[:120] + suffix
    except Exception as exc:
        suffix = f' [tried {resolved}:{db.port}]' if resolved != db.host else f' [tried {db.host}:{db.port}]'
        return False, str(exc)[:280] + suffix


# ── Spatial table discovery ──────────────────────────────────────────────────

def list_spatial_tables(db: 'ExternalDatabase') -> list[dict]:
    """
    Return all tables/views with geometry columns visible in the external DB.
    Each dict: {schema, table, geom_column, geom_type, srid, row_count}
    """
    sql = """
        SELECT
            f.f_table_schema   AS schema,
            f.f_table_name     AS table_name,
            f.f_geometry_column AS geom_column,
            UPPER(f.type)      AS geom_type,
            f.srid             AS srid
        FROM geometry_columns f
        ORDER BY f.f_table_schema, f.f_table_name
    """
    results = []
    try:
        with external_conn(db) as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute(sql)
                rows = cur.fetchall()
                for row in rows:
                    schema = row['schema']
                    table  = row['table_name']
                    # Estimate row count via pg_class stats (fast)
                    try:
                        cur.execute(
                            "SELECT reltuples::bigint FROM pg_class c "
                            "JOIN pg_namespace n ON n.oid = c.relnamespace "
                            "WHERE n.nspname = %s AND c.relname = %s",
                            (schema, table),
                        )
                        cnt_row = cur.fetchone()
                        row_count = int(cnt_row[0]) if cnt_row else None
                    except Exception:
                        row_count = None
                    results.append({
                        'schema':      schema,
                        'table':       table,
                        'geom_column': row['geom_column'],
                        'geom_type':   row['geom_type'],
                        'srid':        row['srid'],
                        'row_count':   row_count,
                    })
    except Exception as exc:
        logger.error('list_spatial_tables failed: %s', exc)
        raise
    return results


def table_columns(db: 'ExternalDatabase', schema: str, table: str) -> list[dict]:
    """Return non-geometry column metadata for a table."""
    sql = """
        SELECT column_name, data_type, character_maximum_length
        FROM information_schema.columns
        WHERE table_schema = %s AND table_name = %s
        ORDER BY ordinal_position
    """
    with external_conn(db) as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(sql, (schema, table))
            return [dict(r) for r in cur.fetchall()]


def distinct_column_values(layer: 'ExternalLayer', field: str, limit: int = 200) -> list[str]:
    """
    Return up to *limit* distinct, non-null values of *field* in the layer's table,
    ordered alphabetically. Used by the admin UI to auto-generate a classification
    colour map. `field` is validated against the table's real columns to prevent
    SQL injection (it is interpolated as an identifier).
    """
    db     = layer.database
    schema = layer.schema_name or 'public'
    table  = layer.table_name

    valid_cols = {c['column_name'] for c in table_columns(db, schema, table)}
    if field not in valid_cols:
        raise ValueError(f'Unknown column: {field}')

    sql = (
        f'SELECT DISTINCT "{field}"::text AS v '
        f'FROM "{schema}"."{table}" '
        f'WHERE "{field}" IS NOT NULL AND TRIM("{field}"::text) <> \'\' '
        f'ORDER BY v LIMIT %s'
    )
    with external_conn(db) as conn:
        with conn.cursor() as cur:
            cur.execute(sql, (int(limit),))
            return [row[0].strip() for row in cur.fetchall() if row[0] is not None]


# ── Office-based row filtering ────────────────────────────────────────────────

def _inside_cantonment_codes(org) -> list[str]:
    """
    Cantonment (officelevelid='CB') office codes visible to *org* for an
    INSIDE-cantonment layer, mirroring the authoritative mst_office queries:

      PDDE → CB offices where controllingoffice = <PDDE officeid>
      DEO  → CB offices where parentofficeid    = <DEO officeid>
      CEO  → own office code (the cantonment itself)
      ADEO → own office code

    Resolved against the local Organisation mirror (controlling_office / parent FKs).
    """
    from apps.accounts.models import Organisation
    from django.db.models import Q

    # A cantonment board: raw officelevelid 'CB', or the normalised CEO level.
    is_cb = Q(office_level_code='CB') | Q(level=Organisation.CEO)

    if org.level == Organisation.PDDE:
        qs = Organisation.objects.filter(is_cb, controlling_office_id=org.id)
    elif org.level == Organisation.DEO:
        qs = Organisation.objects.filter(is_cb, parent_id=org.id)
    else:
        # CEO / ADEO (and any other) → just their own cantonment code
        return [org.office_id] if org.office_id else []

    return list(qs.exclude(office_id='').values_list('office_id', flat=True))


def allowed_office_codes(user, scope: str = 'OUTSIDE') -> list[str] | None:
    """
    Return the list of office codes a user is allowed to see, or None meaning
    "no restriction — show all rows". Resolved against the local Organisation
    mirror of mst_office.

    Common to both scopes:
      - super admin / DGDE → None (all rows; never hidden, NULL filter values shown)
      - no org             → [] (nothing)

    scope='OUTSIDE' (default — general office hierarchy):
      own office_id + all parent-subtree descendants.

    scope='INSIDE' (cantonment-keyed data):
      cantonment (CB) office codes resolved per level — PDDE via controllingoffice,
      DEO via parentofficeid, CEO/ADEO via own office code. See _inside_cantonment_codes.
    """
    if user is None:
        return None
    if getattr(user, 'is_superadmin', False) or getattr(user, 'role', '') == 'SUPERADMIN':
        return None

    org = getattr(user, 'organisation', None)
    if org is None:
        return []

    from apps.accounts.models import Organisation
    if org.level == Organisation.DGDE:
        return None

    if scope == 'INSIDE':
        return _inside_cantonment_codes(org)

    # OUTSIDE: own + descendant organisations (parent-based subtree)
    subtree_ids = org.get_subtree_ids()
    codes = list(
        Organisation.objects
        .filter(id__in=subtree_ids)
        .exclude(office_id='')
        .values_list('office_id', flat=True)
    )
    if org.office_id and org.office_id not in codes:
        codes.append(org.office_id)
    return codes


def _resolve_filter_column(layer: 'ExternalLayer', user) -> str:
    """
    Return the external-table column name to use for office-based row filtering,
    given the logged-in user's organisation level.  Returns '' if no filter applies.

    Priority:
      1. level_filter_fields[user_org_level]  — per-level override
      2. office_filter_field                  — legacy single-column fallback
      3. ''                                   — no filter
    """
    if user is None:
        return ''
    org = getattr(user, 'organisation', None)
    user_level = org.level if org else ''
    level_fields: dict = layer.level_filter_fields or {}
    if user_level and user_level in level_fields:
        return (level_fields[user_level] or '').strip()
    return (layer.office_filter_field or '').strip()


# ── Layer GeoJSON proxy ──────────────────────────────────────────────────────

def layer_geojson(layer: 'ExternalLayer', limit: int = 5000, user=None, bbox=None,
                  attr_field: str = None, attr_value=None) -> dict:
    """
    Query the external DB and return a GeoJSON FeatureCollection for the layer.
    Always reprojects to WGS84 (EPSG:4326) via ST_Transform so the frontend
    can safely read as GeoJSON regardless of the source SRID.

    If *user* is provided and a filter column is configured for the user's level
    (via level_filter_fields or the fallback office_filter_field), rows are
    restricted to the user's office subtree.  DGDE-level users and super admins
    always see every row.

    If *bbox* is given as [minLon, minLat, maxLon, maxLat] in WGS84, only features
    intersecting that envelope are returned (viewport loading). The envelope is
    transformed to the layer SRID so the source geometry's spatial index is used.
    """
    db     = layer.database
    schema = f'"{layer.schema_name or "public"}"'
    table  = f'"{layer.table_name}"'
    geom_col = layer.geometry_column or 'geom'
    srid = layer.srid if layer.srid and layer.srid != 0 else 4326

    # Build column list
    include = layer.include_columns or []

    # Determine the filter column for this user's org level
    filter_field = _resolve_filter_column(layer, user)

    # Determine allowed office codes (None = no restriction)
    office_codes = None
    if filter_field and user is not None:
        office_codes = allowed_office_codes(user, scope=getattr(layer, 'cantonment_scope', 'OUTSIDE'))

    with external_conn(db) as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            # Discover columns if not specified
            if not include:
                cur.execute(
                    "SELECT column_name FROM information_schema.columns "
                    "WHERE table_schema = %s AND table_name = %s "
                    "ORDER BY ordinal_position",
                    (layer.schema_name or 'public', layer.table_name),
                )
                all_cols = [r['column_name'] for r in cur.fetchall()]
                cur.execute(
                    "SELECT f_geometry_column FROM geometry_columns "
                    "WHERE f_table_schema = %s AND f_table_name = %s",
                    (layer.schema_name or 'public', layer.table_name),
                )
                geom_cols = {r['f_geometry_column'] for r in cur.fetchall()}
                include = [c for c in all_cols if c not in geom_cols]

            # Always carry the thematic classification column so the frontend can
            # colour features by it, even when include_columns is a curated subset.
            cls_field = (layer.classification_field or '').strip()
            if cls_field and cls_field not in include:
                include = list(include) + [cls_field]

            safe_cols = ', '.join(f'"{c}"' for c in include)

            # ST_SetSRID guards against SRID=0; ST_Transform → 4326 for the frontend
            geojson_expr = (
                f'ST_AsGeoJSON(ST_Transform(ST_SetSRID("{geom_col}"::geometry, {srid}), 4326), 6)::json'
            )

            where_parts = [f'"{geom_col}" IS NOT NULL']
            params: list = []

            # Viewport (bbox) filter — uses the native-SRID spatial index on geom.
            if bbox is not None and len(bbox) == 4:
                where_parts.append(
                    f'"{geom_col}" && ST_Transform(ST_MakeEnvelope(%s, %s, %s, %s, 4326), {srid})'
                )
                params.extend([float(bbox[0]), float(bbox[1]), float(bbox[2]), float(bbox[3])])

            # Apply office-based row filter
            if office_codes is not None:
                if len(office_codes) == 0:
                    # User has no permitted office codes → return empty set
                    return {'type': 'FeatureCollection', 'features': []}
                placeholders = ', '.join(['%s'] * len(office_codes))
                # TRIM handles char(5) padding in mst_office-style columns
                where_parts.append(f'TRIM("{filter_field}"::text) IN ({placeholders})')
                params.extend([c.strip() for c in office_codes])

            # Optional attribute filter (user-driven, e.g. classification value).
            # The column name cannot be parameterised, so validate it against the
            # layer's known columns to prevent SQL injection.
            if attr_field and attr_value not in (None, '') and attr_field in include:
                where_parts.append(f'TRIM("{attr_field}"::text) = %s')
                params.append(str(attr_value).strip())

            where_sql = ' AND '.join(where_parts)
            sql = (
                f'SELECT {geojson_expr} AS __geometry__, {safe_cols} '
                f'FROM {schema}.{table} '
                f'WHERE {where_sql} '
                f'LIMIT {int(limit)}'
            )
            cur.execute(sql, params)
            rows = cur.fetchall()

    features = []
    for row in rows:
        geom = row.pop('__geometry__', None)
        if geom is None:
            continue
        props = {}
        for k, v in row.items():
            if isinstance(v, (bytes, memoryview)):
                props[k] = None
            elif hasattr(v, 'isoformat'):
                props[k] = v.isoformat()
            else:
                props[k] = v
        features.append({'type': 'Feature', 'geometry': geom, 'properties': props})

    return {'type': 'FeatureCollection', 'features': features}


def search_external_layer(layer: 'ExternalLayer', q: str, user=None, limit: int = 15) -> list[dict]:
    """
    Keyword-search one external layer's attribute columns (case-insensitive,
    substring) and return matching features with their WGS84 geometry so the map
    can fly to them.

    The SAME per-level office filtering as the map viewer is applied (DGDE → all,
    PDDE/DEO/CEO → their jurisdiction, inside/outside cantonment honoured), so a
    user can only find features they are allowed to see.
    """
    db     = layer.database
    schema = layer.schema_name or 'public'
    table  = layer.table_name
    geom_col = layer.geometry_column or 'geom'
    srid = layer.srid if layer.srid and layer.srid != 0 else 4326

    # Same office filtering as layer_geojson
    filter_field = _resolve_filter_column(layer, user)
    office_codes = None
    if filter_field and user is not None:
        office_codes = allowed_office_codes(user, scope=getattr(layer, 'cantonment_scope', 'OUTSIDE'))
    if office_codes is not None and len(office_codes) == 0:
        return []

    with external_conn(db) as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            # Always read the real schema so we can validate id/include columns.
            cur.execute(
                "SELECT column_name FROM information_schema.columns "
                "WHERE table_schema = %s AND table_name = %s ORDER BY ordinal_position",
                (schema, table),
            )
            all_cols = [r['column_name'] for r in cur.fetchall()]
            cur.execute(
                "SELECT f_geometry_column FROM geometry_columns "
                "WHERE f_table_schema = %s AND f_table_name = %s",
                (schema, table),
            )
            geom_cols = {r['f_geometry_column'] for r in cur.fetchall()}
            valid = set(all_cols)

            include = [c for c in (layer.include_columns or []) if c in valid] \
                or [c for c in all_cols if c not in geom_cols]
            if not include:
                return []

            ilike_parts = [f'"{c}"::text ILIKE %s' for c in include]
            where_parts = [f'"{geom_col}" IS NOT NULL', '(' + ' OR '.join(ilike_parts) + ')']
            params: list = [f'%{q}%'] * len(include)

            if office_codes is not None:
                ph = ', '.join(['%s'] * len(office_codes))
                where_parts.append(f'TRIM("{filter_field}"::text) IN ({ph})')
                params.extend([c.strip() for c in office_codes])

            geojson_expr = (
                f'ST_AsGeoJSON(ST_Transform(ST_SetSRID("{geom_col}"::geometry, {srid}), 4326), 6)::json'
            )
            # Use configured id_column only if it really exists; else no explicit id.
            id_col   = layer.id_column if layer.id_column in valid else None
            id_select = f'"{id_col}" AS __id__, ' if id_col else 'NULL AS __id__, '
            cols_sql = ', '.join(f'"{c}"' for c in include)
            sql = (
                f'SELECT {id_select}{geojson_expr} AS __geom__, {cols_sql} '
                f'FROM "{schema}"."{table}" '
                f'WHERE {" AND ".join(where_parts)} '
                f'LIMIT {int(limit)}'
            )
            cur.execute(sql, params)
            rows = cur.fetchall()

    ql = q.lower()
    label_col = layer.label_column
    results = []
    for row in rows:
        geom = row.pop('__geom__', None)
        fid  = row.pop('__id__', None)
        if geom is None:
            continue
        match_field, match_value = None, None
        for k, v in row.items():
            if v is not None and ql in str(v).lower():
                match_field, match_value = k, str(v)
                break
        label = (str(row.get(label_col)) if label_col and row.get(label_col) is not None
                 else (match_value or str(fid)))
        results.append({
            'layer_id':    layer.id,
            'layer_name':  layer.display_name,
            'id':          fid,
            'label':       label,
            'match_field': match_field,
            'match_value': match_value,
            'geometry':    geom,
        })
    return results


def layer_bbox_and_count(layer: 'ExternalLayer') -> tuple[list | None, int | None]:
    """Return ([minLon,minLat,maxLon,maxLat], feature_count) from the external DB."""
    db     = layer.database
    schema = layer.schema_name or 'public'
    table  = layer.table_name
    geom   = layer.geometry_column or 'geom'
    srid = layer.srid if layer.srid and layer.srid != 0 else 4326
    try:
        with external_conn(db) as conn:
            with conn.cursor() as cur:
                # ST_SetSRID guards against SRID=0 geometries (unregistered in geometry_columns)
                cur.execute(
                    f'SELECT COUNT(*), '
                    f'ST_XMin(ST_Transform(ST_SetSRID(ST_Extent("{geom}"), {srid}), 4326)), '
                    f'ST_YMin(ST_Transform(ST_SetSRID(ST_Extent("{geom}"), {srid}), 4326)), '
                    f'ST_XMax(ST_Transform(ST_SetSRID(ST_Extent("{geom}"), {srid}), 4326)), '
                    f'ST_YMax(ST_Transform(ST_SetSRID(ST_Extent("{geom}"), {srid}), 4326)) '
                    f'FROM "{schema}"."{table}" WHERE "{geom}" IS NOT NULL'
                )
                row = cur.fetchone()
                if row and row[1] is not None:
                    count = int(row[0])
                    bbox  = [float(row[1]), float(row[2]), float(row[3]), float(row[4])]
                    return bbox, count
    except Exception as exc:
        logger.warning('layer_bbox_and_count failed for %s: %s', layer, exc)
    return None, None


# ── mst_office import ────────────────────────────────────────────────────────

def import_mst_office(db: 'ExternalDatabase', schema: str = 'public') -> dict:
    """
    Read mst_office from the external DB and upsert into
    accounts.Organisation using office_id as the natural key.

    Returns {'created': n, 'updated': n, 'errors': [...]}
    """
    from apps.accounts.models import Organisation
    from apps.gis_layers.models import State, District

    sql = f"""
        SELECT
            officeid, officename, officelevelid, officeurl,
            creationdate, closedate, doe, dou,
            enby, upby, csum, dorder,
            address1, address2, address3,
            distcity, stateid,
            phonenos, faxnos,
            controllingoffice, officepincode, officeemail,
            parentofficeid, circle
        FROM {schema}.mst_office
        ORDER BY dorder
    """

    # Map mst_office.officelevelid → Organisation.level choice
    #   DG → DGDE, PE → PDDE, DO → DEO, CB → CEO, AE → ADEO
    #   MD → DGDE  (Ministry of Defence — national)
    #   DE → DGDE  (NIDEM — National Institute of Defence Estates Management, national)
    LEVEL_MAP = {
        'DG': Organisation.DGDE,
        'MD': Organisation.DGDE,
        'DE': Organisation.DGDE,
        'PE': Organisation.PDDE,
        'DO': Organisation.DEO,
        'CB': Organisation.CEO,
        'AE': Organisation.ADEO,
    }

    with external_conn(db) as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(sql)
            offices = [dict(r) for r in cur.fetchall()]

    # Build index of raw rows by officeid (for parent/controlling lookups)
    office_map: dict[str, dict] = {o['officeid'].strip(): o for o in offices}

    created  = 0
    updated  = 0
    errors   = []
    unknown_levels: set[str] = set()

    # Pass 1 — create/update without parent/controlling (avoids FK ordering issues)
    for row in offices:
        oid  = (row['officeid'] or '').strip()
        name = (row['officename'] or '').strip()
        if not oid or not name:
            continue

        level_code = (row['officelevelid'] or '').strip()
        level_upper = level_code.upper()
        if level_upper and level_upper not in LEVEL_MAP:
            unknown_levels.add(level_upper)
        level = LEVEL_MAP.get(level_upper, Organisation.DEO)
        code       = oid   # use office_id as the code too

        # Resolve state / district by their codes
        state    = None
        district = None
        stateid  = (row.get('stateid') or '').strip()
        distcity = (row.get('distcity') or '').strip()
        if stateid:
            state = State.objects.filter(code=stateid).first()
        if distcity and state:
            district = District.objects.filter(code=distcity, state=state).first()

        defaults = dict(
            name              = name,
            level             = level,
            office_level_code = level_code,
            office_url        = (row.get('officeurl') or '')[:75],
            address1          = (row.get('address1') or '')[:75],
            address2          = (row.get('address2') or '')[:75],
            address3          = (row.get('address3') or '')[:75],
            circle            = (row.get('circle') or '')[:50],
            display_order     = int(row.get('dorder') or 0),
            landline          = (row.get('phonenos') or '')[:50],
            fax_nos           = (row.get('faxnos') or '')[:25],
            email             = (row.get('officeemail') or '')[:254],
            pincode           = (row.get('officepincode') or '')[:6],
            enby              = (row.get('enby') or '')[:15],
            upby              = (row.get('upby') or '')[:15],
            csum              = row.get('csum') or '',
            creation_date     = row.get('creationdate'),
            close_date        = row.get('closedate'),
            doe               = row.get('doe'),
            dou               = row.get('dou'),
            state             = state,
            district          = district,
        )
        # Keep code unique
        try:
            obj, was_created = Organisation.objects.update_or_create(
                office_id=oid,
                defaults={**defaults, 'code': code},
            )
            if was_created:
                created += 1
            else:
                updated += 1
        except Exception as exc:
            errors.append(f'{oid}: {exc}')

    # Pass 2 — wire up parent and controlling_office FKs
    for row in offices:
        oid         = (row['officeid'] or '').strip()
        parent_id   = (row.get('parentofficeid') or '').strip()
        ctrl_id     = (row.get('controllingoffice') or '').strip()
        if not oid:
            continue
        try:
            org = Organisation.objects.get(office_id=oid)
            changed = False
            if parent_id and parent_id != oid:
                parent = Organisation.objects.filter(office_id=parent_id).first()
                if parent and org.parent_id != parent.pk:
                    org.parent = parent
                    changed = True
            if ctrl_id and ctrl_id != oid:
                ctrl = Organisation.objects.filter(office_id=ctrl_id).first()
                if ctrl and org.controlling_office_id != ctrl.pk:
                    org.controlling_office = ctrl
                    changed = True
            if changed:
                org.save(update_fields=['parent', 'controlling_office'])
        except Exception as exc:
            errors.append(f'{oid} (FK): {exc}')

    if unknown_levels:
        logger.warning('import_mst_office: unrecognised officelevelid codes: %s (defaulted to DEO)',
                       sorted(unknown_levels))

    return {
        'created': created,
        'updated': updated,
        'errors':  errors[:20],
        'unknown_level_codes': sorted(unknown_levels),
    }
