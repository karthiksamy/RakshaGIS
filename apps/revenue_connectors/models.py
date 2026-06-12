"""
Revenue Portal Connectors
==========================
Allows administrators to register government revenue portal endpoints
(DILRMP, Bhuvan, Bhu-Naksha, any state WFS/REST portal) and cross-reference
registered DefenceParcels against the state revenue records pulled from those portals.

All connection parameters — URL, layer name, auth, portal-specific options — are
fully user-configurable; no defaults are hard-coded.
"""
from django.conf import settings
from django.db import models


class RevenuePortalConnector(models.Model):
    """
    Connection profile for one revenue portal endpoint.

    portal_type drives which fetch adapter is used; the adapter reads all its
    parameters (layer name, field mappings, extra query params) from the model
    fields — nothing is hard-coded per portal.
    """

    # ── Portal type ───────────────────────────────────────────────────────────
    DILRMP_WFS = 'DILRMP_WFS'
    BHUVAN_WFS = 'BHUVAN_WFS'
    BHU_NAKSHA = 'BHU_NAKSHA'
    STATE_WFS  = 'STATE_WFS'
    STATE_REST = 'STATE_REST'

    PORTAL_TYPE_CHOICES = [
        (DILRMP_WFS, 'DILRMP — OGC WFS (NIC GeoServer)'),
        (BHUVAN_WFS, 'Bhuvan — OGC WFS (ISRO / NRSC)'),
        (BHU_NAKSHA, 'Bhu-Naksha — REST (NIC cadastral maps)'),
        (STATE_WFS,  'State Land Portal — OGC WFS'),
        (STATE_REST, 'State Land Portal — ArcGIS / REST'),
    ]

    # ── Auth type ─────────────────────────────────────────────────────────────
    AUTH_NONE    = 'NONE'
    AUTH_API_KEY = 'API_KEY'
    AUTH_BEARER  = 'BEARER'
    AUTH_BASIC   = 'BASIC'

    AUTH_CHOICES = [
        (AUTH_NONE,    'No authentication'),
        (AUTH_API_KEY, 'API key / token (added as query parameter)'),
        (AUTH_BEARER,  'Bearer token (Authorization header)'),
        (AUTH_BASIC,   'HTTP Basic auth (username + password)'),
    ]

    # ── Test status ───────────────────────────────────────────────────────────
    STATUS_UNTESTED = 'UNTESTED'
    STATUS_OK       = 'OK'
    STATUS_ERROR    = 'ERROR'

    STATUS_CHOICES = [
        (STATUS_UNTESTED, 'Not tested yet'),
        (STATUS_OK,       'Connected successfully'),
        (STATUS_ERROR,    'Connection failed'),
    ]

    # ── Core fields ───────────────────────────────────────────────────────────
    name         = models.CharField(max_length=200,
                       help_text='Friendly label, e.g. "Karnataka Bhoomi WFS"')
    portal_type  = models.CharField(max_length=20, choices=PORTAL_TYPE_CHOICES)
    state        = models.ForeignKey('gis_layers.State', on_delete=models.PROTECT,
                       related_name='revenue_connectors',
                       help_text='State whose revenue records this portal serves')
    organisation = models.ForeignKey('accounts.Organisation', on_delete=models.CASCADE,
                       related_name='revenue_connectors')

    # ── Endpoint ──────────────────────────────────────────────────────────────
    base_url   = models.URLField(
                     help_text=(
                         'WFS endpoint, Bhu-Naksha base URL, or ArcGIS service root. '
                         'Example WFS: https://host/geoserver/wfs  '
                         'Example ArcGIS: https://host/arcgis/rest/services/Cadastral/FeatureServer/0'
                     ))
    layer_name = models.CharField(max_length=300, blank=True,
                     help_text=(
                         'WFS typename (e.g. "revenue:cadastral_plots") or ArcGIS layer ID. '
                         'Leave blank for Bhu-Naksha (village code drives the query instead).'
                     ))

    # ── Auth ──────────────────────────────────────────────────────────────────
    auth_type = models.CharField(max_length=10, choices=AUTH_CHOICES, default=AUTH_NONE)
    api_key   = models.CharField(max_length=500, blank=True,
                    help_text='API key (for API_KEY or BEARER auth types)')
    username  = models.CharField(max_length=100, blank=True)
    password  = models.CharField(max_length=200, blank=True,
                    help_text='Stored in plain text — restrict access to super admins')

    # ── Portal-specific parameters ────────────────────────────────────────────
    extra_params = models.JSONField(default=dict, blank=True, help_text=(
        'Portal-specific options (all optional). '
        'WFS: {"version":"1.1.0","max_features":500,"output_format":"application/json"}. '
        'Bhu-Naksha: {"state_code":"09","district_code":"01","taluk_code":"","village_code":""}. '
        'ArcGIS: {"out_fields":"*","result_record_count":1000}. '
        'Field name mappings (for any type): '
        '{"survey_number_fields":["plot_no"],"owner_fields":["pattadar_nm"],'
        '"area_fields":["area_ha"],"land_type_fields":["land_use"]}. '
        'API key query-param name (API_KEY auth): {"api_key_param":"token"}.'
    ))

    is_active = models.BooleanField(default=True)

    # ── Test status ───────────────────────────────────────────────────────────
    test_status    = models.CharField(max_length=10, choices=STATUS_CHOICES,
                         default=STATUS_UNTESTED)
    test_message   = models.TextField(blank=True)
    last_tested_at = models.DateTimeField(null=True, blank=True)

    created_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.SET_NULL,
                     null=True, related_name='+')
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['state__name', 'name']
        indexes = [
            models.Index(fields=['organisation', 'is_active']),
            models.Index(fields=['state', 'portal_type']),
        ]

    def __str__(self):
        return f'{self.name} [{self.get_portal_type_display()}]'


class ParcelRevenueLink(models.Model):
    """
    Cross-reference result: a cadastral record fetched from a revenue portal
    and matched against a DefenceParcel.

    One row per (parcel, connector, remote_survey_number) triplet.  Re-running
    the connector upserts the row so stale data is replaced automatically.
    """
    defence_parcel       = models.ForeignKey('survey_projects.DefenceParcel',
                               on_delete=models.CASCADE, related_name='revenue_links')
    connector            = models.ForeignKey(RevenuePortalConnector, on_delete=models.CASCADE,
                               related_name='parcel_links')

    # ── Remote record (sourced verbatim from the portal) ─────────────────────
    remote_survey_number = models.CharField(max_length=200)
    remote_owner         = models.CharField(max_length=500, blank=True)
    remote_area_ha       = models.DecimalField(max_digits=14, decimal_places=4,
                               null=True, blank=True)
    remote_land_type     = models.CharField(max_length=300, blank=True)
    raw_attributes       = models.JSONField(default=dict,
                               help_text='All attributes returned by the remote portal')

    # ── Computed cross-reference result ───────────────────────────────────────
    overlap_area_ha = models.DecimalField(max_digits=14, decimal_places=4,
                          null=True, blank=True,
                          help_text='Intersection area between remote parcel and defence parcel (ha)')
    overlap_pct     = models.DecimalField(max_digits=6, decimal_places=2,
                          null=True, blank=True,
                          help_text='Overlap as % of the remote parcel area')

    discrepancy_flag  = models.BooleanField(default=False,
                            help_text='Set when ownership or area conflicts with RakshaGIS records')
    discrepancy_notes = models.TextField(blank=True)

    fetched_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering        = ['-fetched_at']
        unique_together = [['defence_parcel', 'connector', 'remote_survey_number']]
        indexes         = [
            models.Index(fields=['defence_parcel', 'connector']),
            models.Index(fields=['discrepancy_flag']),
        ]

    def __str__(self):
        return (f'Link({self.defence_parcel_id} ↔ SN:{self.remote_survey_number}'
                f' via {self.connector.name})')
