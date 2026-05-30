"""
External Data Sources
=======================
Allows super admins to register external PostgreSQL databases (e.g. the existing
DGDE operational database that holds mst_office and spatial layer tables) and
select which tables to display in the RakshaGIS map viewer as read-only layers.

Layers are NOT copied/migrated — they are served live via proxied psycopg2 queries.
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

    # ── Office-based row-level filtering ──────────────────────────────────
    # Column in the external table that holds the office code (e.g. 'officeid').
    # When set, non-DGDE users only see rows whose value is within their office
    # subtree.  DGDE-level users and super admins always see every row.
    office_filter_field = models.CharField(max_length=63, blank=True,
                              help_text='Column holding the office code used to '
                                        'filter rows per logged-in office. Empty = no filter.')

    # Display configuration
    style           = models.JSONField(default=dict, blank=True,
                          help_text='OpenLayers-compatible style: {color, fillColor, weight, opacity}')
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
