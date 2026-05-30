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


# ── Office-based row filtering ────────────────────────────────────────────────

def allowed_office_codes(user) -> list[str] | None:
    """
    Return the list of office codes a user is allowed to see, or None meaning
    "no restriction — show all rows".

    - super admin                  → None (all)
    - organisation.level == DGDE   → None (all)
    - any other level              → own office_id + all descendant office_ids
    - user without an organisation → [] (nothing)
    """
    from apps.accounts.models import Organisation

    if user is None:
        return None
    if getattr(user, 'is_superadmin', False) or getattr(user, 'role', '') == 'SUPERADMIN':
        return None

    org = getattr(user, 'organisation', None)
    if org is None:
        return []
    if org.level == Organisation.DGDE:
        return None  # national level sees everything

    # Own + descendant organisations → collect their office_id codes
    subtree_ids = org.get_subtree_ids()
    codes = list(
        Organisation.objects
        .filter(id__in=subtree_ids)
        .exclude(office_id='')
        .values_list('office_id', flat=True)
    )
    # Always include this org's own office_id even if blank-guarded above
    if org.office_id and org.office_id not in codes:
        codes.append(org.office_id)
    return codes


# ── Layer GeoJSON proxy ──────────────────────────────────────────────────────

def layer_geojson(layer: 'ExternalLayer', limit: int = 5000, user=None) -> dict:
    """
    Query the external DB and return a GeoJSON FeatureCollection for the layer.
    Reprojects to WGS84 (EPSG:4326) if the source SRID differs.

    If *user* is provided and the layer has an office_filter_field configured,
    rows are restricted to the user's office subtree (DGDE / super admin see all).
    """
    db     = layer.database
    schema = psycopg2.extensions.quote_ident(layer.schema_name, None) if layer.schema_name else 'public'
    table  = psycopg2.extensions.quote_ident(layer.table_name, None)
    geom_col = layer.geometry_column or 'geom'
    id_col   = layer.id_column or 'gid'

    # Build column list
    include = layer.include_columns or []

    # Determine office filter (None = no restriction)
    office_codes = None
    filter_field = (layer.office_filter_field or '').strip()
    if filter_field and user is not None:
        office_codes = allowed_office_codes(user)

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
                # Exclude geometry columns (udt_name = 'geometry')
                cur.execute(
                    "SELECT f_geometry_column FROM geometry_columns "
                    "WHERE f_table_schema = %s AND f_table_name = %s",
                    (layer.schema_name or 'public', layer.table_name),
                )
                geom_cols = {r['f_geometry_column'] for r in cur.fetchall()}
                include = [c for c in all_cols if c not in geom_cols]

            safe_cols = ', '.join(
                f'"{c}"' for c in include
            )

            geojson_expr = (
                f'ST_AsGeoJSON(ST_Transform("{geom_col}", 4326), 6)::json'
                if layer.srid != 4326
                else f'ST_AsGeoJSON("{geom_col}", 6)::json'
            )

            where_parts = [f'"{geom_col}" IS NOT NULL']
            params: list = []

            # Apply office-based row filter
            if office_codes is not None:
                if len(office_codes) == 0:
                    # User has no permitted offices → return empty set
                    return {'type': 'FeatureCollection', 'features': []}
                placeholders = ', '.join(['%s'] * len(office_codes))
                # TRIM handles char(5) padding in mst_office-style columns
                where_parts.append(f'TRIM("{filter_field}"::text) IN ({placeholders})')
                params.extend([c.strip() for c in office_codes])

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


def layer_bbox_and_count(layer: 'ExternalLayer') -> tuple[list | None, int | None]:
    """Return ([minLon,minLat,maxLon,maxLat], feature_count) from the external DB."""
    db     = layer.database
    schema = layer.schema_name or 'public'
    table  = layer.table_name
    geom   = layer.geometry_column or 'geom'
    try:
        with external_conn(db) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    f'SELECT COUNT(*), '
                    f'ST_XMin(ST_Transform(ST_Extent("{geom}"), 4326)), '
                    f'ST_YMin(ST_Transform(ST_Extent("{geom}"), 4326)), '
                    f'ST_XMax(ST_Transform(ST_Extent("{geom}"), 4326)), '
                    f'ST_YMax(ST_Transform(ST_Extent("{geom}"), 4326)) '
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
    LEVEL_MAP = {
        'DG': Organisation.DGDE,
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

    created = 0
    updated = 0
    errors  = []

    # Pass 1 — create/update without parent/controlling (avoids FK ordering issues)
    for row in offices:
        oid  = (row['officeid'] or '').strip()
        name = (row['officename'] or '').strip()
        if not oid or not name:
            continue

        level_code = (row['officelevelid'] or '').strip()
        level      = LEVEL_MAP.get(level_code.upper(), Organisation.DEO)
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

    return {'created': created, 'updated': updated, 'errors': errors[:20]}
