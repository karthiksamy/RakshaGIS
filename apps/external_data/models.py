"""
External Data Sources
=======================
Allows super admins to register two types of external spatial data sources:

1. External PostgreSQL databases (ExternalDatabase / ExternalLayer)
   — served live via psycopg2 queries, returned as GeoJSON

2. External GIS Servers (GISServerConnection / GISServerLayer)
   — GeoServer, ArcGIS REST, MapServer, QGIS Server, WMS/WFS/WMTS endpoints
   — vector protocols (WFS, ArcGIS Feature Service) proxied as GeoJSON
   — raster protocols (WMS, WMTS) rendered as tile layers directly in the browser
"""
from django.db import models
from django.conf import settings


class ExternalDatabase(models.Model):
    """Connection profile for an external PostgreSQL database."""

    STATUS_UNTESTED = 'UNTESTED'
    STATUS_OK       = 'OK'
    STATUS_ERROR    = 'ERROR'
    STATUS_CHOICES  = [
        (STATUS_UNTESTED, 'Not tested yet'),
        (STATUS_OK,       'Connected successfully'),
        (STATUS_ERROR,    'Connection failed'),
    ]

    name        = models.CharField(max_length=200,
                      help_text='Friendly name, e.g. "DGDE Operational DB"')
    host        = models.CharField(max_length=200)
    port        = models.IntegerField(default=5432)
    database    = models.CharField(max_length=100, help_text='Database name')
    schema      = models.CharField(max_length=50, default='public',
                      help_text='Default schema (usually "public")')
    username    = models.CharField(max_length=100)
    password    = models.CharField(max_length=200,
                      help_text='Stored in plain text — restrict access to super admins')
    is_active   = models.BooleanField(default=True)
    description = models.TextField(blank=True)

    test_status     = models.CharField(max_length=10, choices=STATUS_CHOICES,
                          default=STATUS_UNTESTED)
    test_message    = models.TextField(blank=True)
    last_tested_at  = models.DateTimeField(null=True, blank=True)
    last_sync_at    = models.DateTimeField(null=True, blank=True)

    added_by    = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True,
        on_delete=models.SET_NULL, related_name='+'
    )
    created_at  = models.DateTimeField(auto_now_add=True)
    updated_at  = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['name']

    def __str__(self):
        return f'{self.name} ({self.host}:{self.port}/{self.database})'

    def get_connection_params(self) -> dict:
        return dict(
            host=self.host, port=self.port,
            dbname=self.database, user=self.username,
            password=self.password, connect_timeout=10,
            options=f'-c search_path={self.schema},public',
            sslmode='prefer',
        )


class ExternalLayer(models.Model):
    """A spatial table in an ExternalDatabase that the super admin has selected for display."""

    GEOM_POINT   = 'POINT'
    GEOM_LINE    = 'LINESTRING'
    GEOM_POLY    = 'POLYGON'
    GEOM_MULTI_POINT = 'MULTIPOINT'
    GEOM_MULTI_LINE  = 'MULTILINESTRING'
    GEOM_MULTI_POLY  = 'MULTIPOLYGON'
    GEOM_COLLECTION  = 'GEOMETRYCOLLECTION'
    GEOM_UNKNOWN     = 'GEOMETRY'
    GEOM_CHOICES = [
        (GEOM_POINT,       'Point'),
        (GEOM_LINE,        'Line'),
        (GEOM_POLY,        'Polygon'),
        (GEOM_MULTI_POINT, 'Multi-Point'),
        (GEOM_MULTI_LINE,  'Multi-Line'),
        (GEOM_MULTI_POLY,  'Multi-Polygon'),
        (GEOM_COLLECTION,  'Geometry Collection'),
        (GEOM_UNKNOWN,     'Unknown / Mixed'),
    ]

    database        = models.ForeignKey(ExternalDatabase, on_delete=models.CASCADE,
                          related_name='layers')
    table_name      = models.CharField(max_length=100)
    schema_name     = models.CharField(max_length=50, default='public')
    display_name    = models.CharField(max_length=200)
    description     = models.TextField(blank=True)

    # Spatial metadata (discovered when layer is added)
    geometry_column = models.CharField(max_length=50, default='geom')
    geometry_type   = models.CharField(max_length=20, choices=GEOM_CHOICES,
                          default=GEOM_UNKNOWN)
    srid            = models.IntegerField(default=4326)
    id_column       = models.CharField(max_length=50, default='gid',
                          help_text='Primary key column in the external table')
    label_column    = models.CharField(max_length=50, blank=True,
                          help_text='Column to use as feature tooltip/label')
    # Optional attribute columns to include (empty = all)
    include_columns = models.JSONField(default=list, blank=True,
                          help_text='List of column names to include; empty = all non-geometry')
    # Columns to surface in temp-layer proximity analysis result tables.
    # Empty = first 5 available columns.
    analysis_columns = models.JSONField(default=list, blank=True,
                          help_text='Columns to show in Intersecting/Nearby analysis tables; empty = first 5')

    # ── Office-based row-level filtering ──────────────────────────────────
    # Whether this layer holds data INSIDE a cantonment (rows keyed by the
    # cantonment/CEO office code) or OUTSIDE (general office hierarchy).
    #   OUTSIDE → filter by the user's office + parent-subtree descendants.
    #   INSIDE  → filter by cantonment (officelevelid='CB') office codes resolved
    #             per level: PDDE via controllingoffice, DEO via parentofficeid,
    #             CEO via own office code. DGDE always sees all.
    SCOPE_OUTSIDE = 'OUTSIDE'
    SCOPE_INSIDE  = 'INSIDE'
    SCOPE_CHOICES = [
        (SCOPE_OUTSIDE, 'Outside Cantonment (office hierarchy)'),
        (SCOPE_INSIDE,  'Inside Cantonment (CB office codes)'),
    ]
    cantonment_scope = models.CharField(max_length=10, choices=SCOPE_CHOICES,
                              default=SCOPE_OUTSIDE,
                              help_text='How office filtering resolves the allowed rows.')

    # Column in the external table that holds the office code (e.g. 'officeid').
    # When set, non-DGDE users only see rows whose value is within their office
    # subtree.  DGDE-level users and super admins always see every row.
    office_filter_field = models.CharField(max_length=63, blank=True,
                              help_text='Fallback column for filtering (used when no '
                                        'per-level override is set). Empty = no filter.')

    # Per-level column overrides: which column to match against the user's office code
    # for each org level.  DGDE is always unrestricted (no entry needed).
    # e.g. {"PDDE": "pdde_code", "DEO": "officeid", "CEO": "officeid", "ADEO": "officeid"}
    level_filter_fields = models.JSONField(default=dict, blank=True,
                              help_text='Per-level column map: '
                                        '{"PDDE":"col","DEO":"col","CEO":"col","ADEO":"col"}. '
                                        'Overrides office_filter_field for the matched level.')

    # Display configuration
    style           = models.JSONField(default=dict, blank=True,
                          help_text='OpenLayers-compatible style: {color, fillColor, weight, opacity}')

    # ── Rendering type for INSIDE-cantonment layers ───────────────────────
    # GLR_PLAN → classification-based (thematic) colouring by classification_field.
    # OTHERS   → flat single colour from `style` (color + opacity).
    # Ignored for OUTSIDE-cantonment layers, which are always flat.
    INSIDE_GLR    = 'GLR_PLAN'
    INSIDE_OTHERS = 'OTHERS'
    INSIDE_RENDER_CHOICES = [
        (INSIDE_GLR,    'GLR Plan (classification colours)'),
        (INSIDE_OTHERS, 'Others (single colour)'),
    ]
    inside_render_type = models.CharField(max_length=10, choices=INSIDE_RENDER_CHOICES,
                              default=INSIDE_OTHERS,
                              help_text='Inside-cantonment layers: GLR Plan → classification '
                                        'colouring; Others → flat colour.')

    # ── Classification-based (thematic) rendering ─────────────────────────
    # Used only when cantonment_scope=INSIDE and inside_render_type=GLR_PLAN.
    # Polygons/features are coloured by the unique values of this attribute column.
    classification_field  = models.CharField(max_length=63, blank=True,
                                help_text='Attribute column whose unique values drive thematic colours. '
                                          'Empty = flat single-colour style.')
    # Map of {value: {"color": "#RRGGBB", "opacity": 0.0-1.0}}. The key '__null__'
    # (or empty string) styles features whose classification value is NULL/blank.
    classification_colors = models.JSONField(default=dict, blank=True,
                                help_text='{"A1": {"color": "#1b5e20", "opacity": 0.6}, ...}. '
                                          'Use "__null__" for NULL/empty values.')

    min_zoom        = models.IntegerField(default=5)
    is_active       = models.BooleanField(default=True,
                          help_text='Shown in map viewer when True')
    display_order   = models.IntegerField(default=0)

    # Cached stats (refreshed by sync/test)
    feature_count   = models.IntegerField(null=True, blank=True)
    bbox            = models.JSONField(null=True, blank=True,
                          help_text='[minLon, minLat, maxLon, maxLat] in WGS84')
    last_synced_at  = models.DateTimeField(null=True, blank=True)

    added_by        = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True,
        on_delete=models.SET_NULL, related_name='+'
    )
    created_at      = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering            = ['display_order', 'display_name']
        unique_together     = [('database', 'schema_name', 'table_name')]

    def __str__(self):
        return f'{self.display_name} ({self.schema_name}.{self.table_name})'


# ──────────────────────────────────────────────────────────────────────────────
# GIS Server integration
# ──────────────────────────────────────────────────────────────────────────────

class GISServerConnection(models.Model):
    """
    Connection profile for an external GIS server (GeoServer, ArcGIS, MapServer, etc.).
    Super admin manages; no credentials are exposed to end users.
    """
    TYPE_GEOSERVER  = 'GEOSERVER'
    TYPE_ARCGIS     = 'ARCGIS'
    TYPE_MAPSERVER  = 'MAPSERVER'
    TYPE_QGIS       = 'QGIS'
    TYPE_GENERIC    = 'GENERIC'
    TYPE_CHOICES = [
        (TYPE_GEOSERVER, 'GeoServer (OGC WMS / WFS / WMTS)'),
        (TYPE_ARCGIS,    'ArcGIS REST Server'),
        (TYPE_MAPSERVER, 'MapServer (OGC WMS / WFS)'),
        (TYPE_QGIS,      'QGIS Server'),
        (TYPE_GENERIC,   'Generic OGC Server'),
    ]

    AUTH_NONE  = 'NONE'
    AUTH_BASIC = 'BASIC'
    AUTH_TOKEN = 'TOKEN'
    AUTH_CHOICES = [
        (AUTH_NONE,  'No Authentication'),
        (AUTH_BASIC, 'HTTP Basic (username + password)'),
        (AUTH_TOKEN, 'Token / API Key (Authorization header)'),
    ]

    STATUS_UNTESTED = 'UNTESTED'
    STATUS_OK       = 'OK'
    STATUS_ERROR    = 'ERROR'
    STATUS_CHOICES  = [
        (STATUS_UNTESTED, 'Not tested yet'),
        (STATUS_OK,       'Connected successfully'),
        (STATUS_ERROR,    'Connection failed'),
    ]

    name        = models.CharField(max_length=200)
    server_type = models.CharField(max_length=20, choices=TYPE_CHOICES, default=TYPE_GENERIC)
    base_url    = models.URLField(max_length=500,
                      help_text='Root URL of the GIS server (no trailing slash)')
    auth_type   = models.CharField(max_length=10, choices=AUTH_CHOICES, default=AUTH_NONE)
    username    = models.CharField(max_length=100, blank=True)
    password    = models.CharField(max_length=200, blank=True)
    token       = models.CharField(max_length=500, blank=True,
                      help_text='Bearer / API key token (used when auth_type=TOKEN)')
    is_active   = models.BooleanField(default=True)
    description = models.TextField(blank=True)

    test_status    = models.CharField(max_length=10, choices=STATUS_CHOICES, default=STATUS_UNTESTED)
    test_message   = models.TextField(blank=True)
    last_tested_at = models.DateTimeField(null=True, blank=True)

    added_by   = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True,
        on_delete=models.SET_NULL, related_name='+',
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['name']

    def __str__(self):
        return f'{self.name} ({self.server_type})'

    def auth_headers(self) -> dict:
        """Build HTTP auth headers for requests to this server."""
        if self.auth_type == self.AUTH_BASIC and self.username:
            import base64
            creds = base64.b64encode(f'{self.username}:{self.password}'.encode()).decode()
            return {'Authorization': f'Basic {creds}'}
        if self.auth_type == self.AUTH_TOKEN and self.token:
            return {'Authorization': f'Bearer {self.token}'}
        return {}


class GISServerLayer(models.Model):
    """
    A single layer (WMS, WFS, WMTS, ArcGIS Feature/Map) from a GISServerConnection.
    Vector protocols (WFS, ArcGIS Feature Service) are proxied as GeoJSON by the API.
    Raster protocols (WMS, WMTS, ArcGIS Map Service) are rendered as tile layers in the browser.
    """
    PROTO_WMS            = 'WMS'
    PROTO_WFS            = 'WFS'
    PROTO_WMTS           = 'WMTS'
    PROTO_ARCGIS_FEATURE = 'ARCGIS_FEATURE'
    PROTO_ARCGIS_MAP     = 'ARCGIS_MAP'
    PROTO_XYZ            = 'XYZ'
    PROTO_CHOICES = [
        (PROTO_WMS,            'WMS (raster tiles)'),
        (PROTO_WFS,            'WFS (vector features)'),
        (PROTO_WMTS,           'WMTS (tiled raster)'),
        (PROTO_ARCGIS_FEATURE, 'ArcGIS Feature Service (vector)'),
        (PROTO_ARCGIS_MAP,     'ArcGIS Map Service (raster tiles)'),
        (PROTO_XYZ,            'XYZ Tile URL template'),
    ]

    VECTOR_PROTOCOLS = {PROTO_WFS, PROTO_ARCGIS_FEATURE}
    TILE_PROTOCOLS   = {PROTO_WMS, PROTO_WMTS, PROTO_ARCGIS_MAP, PROTO_XYZ}

    connection   = models.ForeignKey(GISServerConnection, on_delete=models.CASCADE,
                       related_name='layers')
    protocol     = models.CharField(max_length=20, choices=PROTO_CHOICES)
    layer_name   = models.CharField(max_length=300,
                       help_text='WMS/WFS type name, WMTS layer name, ArcGIS layer ID, or XYZ URL template')
    display_name = models.CharField(max_length=200)
    description  = models.TextField(blank=True)

    # ── Raster (WMS / WMTS / ArcGIS Map) options ────────────────────────────
    wms_version  = models.CharField(max_length=10, default='1.1.1')
    wms_format   = models.CharField(max_length=50, default='image/png')
    wms_params   = models.JSONField(default=dict, blank=True,
                       help_text='Extra WMS/WMTS params passed to the tile source (JSON)')
    wmts_matrix_set = models.CharField(max_length=100, blank=True,
                       help_text='WMTS TileMatrixSet identifier (e.g. "EPSG:3857")')
    # ArcGIS Map Service specific: ?dpi=&format=png&...
    arcgis_map_params = models.JSONField(default=dict, blank=True)

    # ── Vector (WFS / ArcGIS Feature) options ───────────────────────────────
    wfs_version    = models.CharField(max_length=10, default='2.0.0')
    wfs_output_fmt = models.CharField(max_length=80, default='application/json',
                         help_text='WFS outputFormat parameter')
    # ArcGIS Feature Service: query endpoint suffix relative to layer_name
    arcgis_query_suffix = models.CharField(max_length=100, default='/query',
                              help_text='Suffix appended to the layer URL for feature queries')
    # Geometry type for vector layers (auto-detected on first fetch when blank)
    geometry_type  = models.CharField(max_length=20, blank=True)

    # ── Style / thematic rendering (same as ExternalLayer) ───────────────────
    style                = models.JSONField(default=dict, blank=True)
    classification_field = models.CharField(max_length=63, blank=True)
    classification_colors = models.JSONField(default=dict, blank=True)

    # ── Common display settings ───────────────────────────────────────────────
    opacity       = models.FloatField(default=1.0)
    min_zoom      = models.IntegerField(default=5)
    is_active     = models.BooleanField(default=True)
    display_order = models.IntegerField(default=0)

    # Cached stats
    feature_count  = models.IntegerField(null=True, blank=True)
    bbox           = models.JSONField(null=True, blank=True,
                         help_text='[minLon, minLat, maxLon, maxLat] in WGS84')
    last_synced_at = models.DateTimeField(null=True, blank=True)

    # Organisation that owns this layer.
    # NULL = added by SUPERADMIN → visible to all authenticated users.
    # Non-null = added by an admin at that org → visible only within that org.
    organisation = models.ForeignKey(
        'accounts.Organisation', null=True, blank=True,
        on_delete=models.SET_NULL, related_name='gis_server_layers',
        help_text='Owning organisation (null = global / SUPERADMIN layer)',
    )

    added_by   = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True,
        on_delete=models.SET_NULL, related_name='+',
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['display_order', 'display_name']

    def __str__(self):
        return f'{self.display_name} ({self.protocol}) — {self.connection.name}'

    @property
    def is_vector(self) -> bool:
        return self.protocol in self.VECTOR_PROTOCOLS

    @property
    def is_tile(self) -> bool:
        return self.protocol in self.TILE_PROTOCOLS
