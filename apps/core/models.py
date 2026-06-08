import uuid
from django.conf import settings
from django.db import models
from django.utils import timezone


class BrandingConfig(models.Model):
    """Singleton model — always use BrandingConfig.get_solo()."""

    app_title        = models.CharField(max_length=100, default='RakshaGIS')
    app_subtitle     = models.CharField(max_length=200, default='DGDE — Defence Estates GIS Platform')
    login_tagline    = models.CharField(max_length=300, blank=True,
                           default='Precision mapping for Defence Estate management')
    primary_color    = models.CharField(max_length=20, default='#1890ff',
                           help_text='Hex color code, e.g. #1890ff')
    logo_url         = models.CharField(max_length=500, blank=True,
                           help_text='Optional absolute or relative URL to logo image')
    updated_at       = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = 'Branding Config'

    @classmethod
    def get_solo(cls):
        obj, _ = cls.objects.get_or_create(pk=1)
        return obj

    def save(self, *args, **kwargs):
        self.pk = 1
        super().save(*args, **kwargs)

    def __str__(self):
        return self.app_title


def _basemap_tiff_upload_path(instance, filename):
    org_id = instance.organisation_id or 'global'
    return f"basemaps/org_{org_id}/{filename}"


class BasemapConfig(models.Model):
    OSM       = 'OSM'
    XYZ       = 'XYZ'
    WMS       = 'WMS'
    WMTS      = 'WMTS'
    BING      = 'BING'
    BHUVAN    = 'BHUVAN'
    ARCGIS    = 'ARCGIS'
    LOCAL_COG = 'LOCAL_COG'   # Field-office uploaded GeoTIFF, converted to COG

    PROVIDER_CHOICES = [
        (OSM,       'OpenStreetMap'),
        (XYZ,       'Custom XYZ Tiles'),
        (WMS,       'WMS Service'),
        (WMTS,      'WMTS Service'),
        (BING,      'Bing Maps'),
        (BHUVAN,    'Bhuvan (ISRO India)'),
        (ARCGIS,    'ArcGIS Map Service'),
        (LOCAL_COG, 'Local Basemap (uploaded GeoTIFF)'),
    ]

    # COG processing states (used when provider == LOCAL_COG)
    COG_PENDING    = 'PENDING'
    COG_PROCESSING = 'PROCESSING'
    COG_DONE       = 'DONE'
    COG_FAILED     = 'FAILED'
    COG_STATUS_CHOICES = [
        (COG_PENDING,    'Pending'),
        (COG_PROCESSING, 'Processing'),
        (COG_DONE,       'Done'),
        (COG_FAILED,     'Failed'),
    ]

    name         = models.CharField(max_length=100)
    provider     = models.CharField(max_length=12, choices=PROVIDER_CHOICES)
    url_template = models.CharField(
        max_length=500, blank=True,
        help_text='Tile URL template. For ARCGIS, enter the MapServer base URL (e.g. https://services.arcgisonline.com/arcgis/rest/services/World_Imagery/MapServer).',
    )
    api_key      = models.CharField(
        max_length=500, blank=True,
        help_text='API key / token for authenticated services (ArcGIS, Bing, etc.).',
    )
    attribution  = models.CharField(max_length=300, blank=True)
    is_active    = models.BooleanField(default=True)
    is_default   = models.BooleanField(
        default=False,
        help_text='Default basemap for this scope. Only one may be default per organisation.',
    )
    is_system    = models.BooleanField(
        default=False,
        help_text='Built-in config — cannot be deleted via API.',
    )

    # ── LOCAL_COG fields ──────────────────────────────────────────────────────
    # Organisation that owns this basemap (null = global / superadmin-managed).
    organisation  = models.ForeignKey(
        'accounts.Organisation', on_delete=models.CASCADE,
        null=True, blank=True, related_name='local_basemaps',
    )
    # Original uploaded TIFF (any projection)
    tiff_file     = models.FileField(
        upload_to=_basemap_tiff_upload_path, null=True, blank=True,
    )
    # Cloud-Optimised GeoTIFF in EPSG:3857 — populated after COG processing
    cog_file      = models.FileField(
        upload_to=_basemap_tiff_upload_path, null=True, blank=True,
    )
    cog_status    = models.CharField(
        max_length=12, choices=COG_STATUS_CHOICES,
        default=COG_PENDING, blank=True,
    )
    cog_error     = models.TextField(blank=True)
    # Approx bounds in EPSG:4326 (populated from COG metadata after processing)
    bounds_west   = models.FloatField(null=True, blank=True)
    bounds_south  = models.FloatField(null=True, blank=True)
    bounds_east   = models.FloatField(null=True, blank=True)
    bounds_north  = models.FloatField(null=True, blank=True)

    created_by    = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name='basemap_configs',
    )
    created_at    = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['-is_default', 'name']

    def __str__(self):
        org = f" [{self.organisation}]" if self.organisation_id else ''
        return f"{self.name} ({self.get_provider_display()}){org}"

    def save(self, *args, **kwargs):
        if self.is_default and not self.is_active:
            self.is_active = True
        super().save(*args, **kwargs)
        # Enforce a single default per organisation scope
        if self.is_default:
            qs = BasemapConfig.objects.exclude(pk=self.pk).filter(is_default=True)
            if self.organisation_id:
                qs = qs.filter(organisation_id=self.organisation_id)
            else:
                qs = qs.filter(organisation__isnull=True)
            qs.update(is_default=False)


class ProvenanceRecord(models.Model):
    """
    Trust Registry DB model for Living Provenance DNA (LP-DNA).
    Logs all files exported or saved from the RakshaGIS/DEMAP platform.
    """
    dna_hash       = models.CharField(max_length=64, unique=True, db_index=True)
    file_name      = models.CharField(max_length=255)
    project_id     = models.IntegerField(null=True, blank=True)
    project_number = models.CharField(max_length=100, null=True, blank=True)
    generated_by   = models.CharField(max_length=150)
    generated_at   = models.DateTimeField(auto_now_add=True)
    file_hash      = models.CharField(max_length=64, null=True, blank=True, db_index=True)

    class Meta:
        ordering = ['-generated_at']
        verbose_name = 'Provenance Record'
        verbose_name_plural = 'Provenance Records'

    def __str__(self):
        return f"{self.file_name} ({self.project_number or 'No Project'})"


class ExportTask(models.Model):
    """
    Tracks an asynchronous data-export job (survey area or full project ZIP).

    Lifecycle:
        PENDING  → Celery task queued
        RUNNING  → ZIP being assembled (streaming writes to temp file)
        DONE     → result_path is populated; file is ready to download
        FAILED   → error field describes what went wrong

    Expiry:
        expires_at defaults to 2 hours after creation.  A periodic Celery beat
        task (purge_expired_exports) removes stale files and rows.

    Concurrency guard:
        export_type + object_id + requested_by + status=RUNNING is checked
        before queuing to prevent one user from spawning many identical jobs.
        A per-organisation cap (settings.EXPORT_MAX_CONCURRENT_PER_ORG, default 3)
        blocks runaway concurrent downloads across an entire office.
    """
    PENDING = 'PENDING'
    RUNNING = 'RUNNING'
    DONE    = 'DONE'
    FAILED  = 'FAILED'
    STATUS_CHOICES = [(s, s) for s in (PENDING, RUNNING, DONE, FAILED)]

    SURVEY_AREA = 'survey_area'
    PROJECT     = 'project'
    EXPORT_TYPE_CHOICES = [(SURVEY_AREA, 'Survey Area'), (PROJECT, 'Project')]

    task_uuid      = models.UUIDField(default=uuid.uuid4, unique=True, db_index=True)
    export_type    = models.CharField(max_length=20, choices=EXPORT_TYPE_CHOICES)
    object_id      = models.IntegerField(db_index=True)
    object_name    = models.CharField(max_length=255, blank=True)
    status         = models.CharField(max_length=10, choices=STATUS_CHOICES, default=PENDING, db_index=True)
    celery_task_id = models.CharField(max_length=255, blank=True)
    # Relative path under MEDIA_ROOT — set when DONE
    result_path    = models.CharField(max_length=500, blank=True)
    file_size      = models.BigIntegerField(null=True, blank=True)
    # Progress message surfaced to the frontend
    progress_msg   = models.CharField(max_length=255, blank=True)
    error          = models.TextField(blank=True)
    requested_by   = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name='export_tasks'
    )
    organisation_id = models.IntegerField(null=True, blank=True, db_index=True)
    created_at     = models.DateTimeField(auto_now_add=True)
    expires_at     = models.DateTimeField()

    class Meta:
        ordering = ['-created_at']
        indexes = [
            models.Index(fields=['export_type', 'object_id', 'status']),
            models.Index(fields=['organisation_id', 'status']),
        ]

    def __str__(self):
        return f"Export({self.export_type}/{self.object_id}) [{self.status}] by {self.requested_by_id}"

    def save(self, *args, **kwargs):
        if not self.expires_at:
            self.expires_at = timezone.now() + timezone.timedelta(hours=2)
        super().save(*args, **kwargs)


def _drone_upload_path(instance, filename):
    return f"drone/{instance.organisation_id or 'shared'}/{filename}"


class DroneDataset(models.Model):
    """
    Drone survey dataset uploaded by CEO / SDO field offices.

    Supports four broad data types:
      ORTHO_2D   — 2D orthomosaic GeoTIFF  → COG pipeline → WebGL map overlay
      DSM_DTM    — Digital Surface/Terrain Model (elevation GeoTIFF) → COG + hillshade
      POINT_CLOUD — LAS / LAZ / COPC point cloud → metadata extracted; Potree viewer
      MESH_3D    — 3D mesh (OBJ / PLY / B3DM / 3D Tiles) → Cesium 3D viewer

    Large-file upload is handled by the chunked-upload endpoint
    (POST /api/core/drone/upload-chunk/).  Processing is always async via Celery.
    """
    ORTHO_2D    = 'ORTHO_2D'
    DSM_DTM     = 'DSM_DTM'
    POINT_CLOUD = 'POINT_CLOUD'
    MESH_3D     = 'MESH_3D'

    DATA_TYPE_CHOICES = [
        (ORTHO_2D,    '2D Orthomosaic (GeoTIFF)'),
        (DSM_DTM,     'DSM / DTM (Elevation Raster)'),
        (POINT_CLOUD, 'Point Cloud (LAS / LAZ / COPC)'),
        (MESH_3D,     '3D Mesh / 3D Tiles'),
    ]

    PENDING    = 'PENDING'
    PROCESSING = 'PROCESSING'
    DONE       = 'DONE'
    FAILED     = 'FAILED'
    STATUS_CHOICES = [(s, s) for s in (PENDING, PROCESSING, DONE, FAILED)]

    name          = models.CharField(max_length=255)
    description   = models.TextField(blank=True)
    data_type     = models.CharField(max_length=15, choices=DATA_TYPE_CHOICES)
    organisation  = models.ForeignKey(
        'accounts.Organisation', on_delete=models.CASCADE, related_name='drone_datasets',
    )
    # Optional link to a survey project / folder
    project       = models.ForeignKey(
        'survey_projects.SurveyProject', on_delete=models.SET_NULL,
        null=True, blank=True, related_name='drone_datasets',
    )
    folder        = models.ForeignKey(
        'survey_projects.ProjectLayerFolder', on_delete=models.SET_NULL,
        null=True, blank=True, related_name='drone_datasets',
    )

    # Original uploaded file (may be very large — up to 50 GB for point clouds)
    file          = models.FileField(upload_to=_drone_upload_path, null=True, blank=True)
    file_size     = models.BigIntegerField(default=0)
    original_filename = models.CharField(max_length=500, blank=True)

    # ── ORTHO_2D / DSM_DTM fields ─────────────────────────────────────────────
    cog_file      = models.FileField(upload_to=_drone_upload_path, null=True, blank=True)
    # Approx WGS-84 bounds populated from COG metadata
    bounds_west   = models.FloatField(null=True, blank=True)
    bounds_south  = models.FloatField(null=True, blank=True)
    bounds_east   = models.FloatField(null=True, blank=True)
    bounds_north  = models.FloatField(null=True, blank=True)
    # Native CRS EPSG code detected from the file
    native_crs    = models.CharField(max_length=20, blank=True)

    # ── POINT_CLOUD fields ────────────────────────────────────────────────────
    # laspy-extracted metadata (JSON: point_count, min/max XYZ, CRS, etc.)
    point_cloud_meta = models.JSONField(null=True, blank=True)
    # Potree-format output directory path (relative to MEDIA_ROOT)
    potree_path   = models.CharField(max_length=500, blank=True)

    # ── MESH_3D fields ────────────────────────────────────────────────────────
    # Path to 3D Tiles tileset.json or processed mesh entry point
    tiles_path    = models.CharField(max_length=500, blank=True)

    status        = models.CharField(max_length=12, choices=STATUS_CHOICES, default=PENDING)
    error         = models.TextField(blank=True)
    is_visible    = models.BooleanField(default=True)
    opacity       = models.FloatField(default=0.9)

    uploaded_by   = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name='drone_datasets',
    )
    created_at    = models.DateTimeField(auto_now_add=True)
    updated_at    = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['-created_at']
        indexes  = [models.Index(fields=['organisation', 'data_type', 'status'])]

    def __str__(self):
        return f"{self.name} [{self.data_type}] — {self.organisation}"


class DroneUploadSession(models.Model):
    """
    Tracks an in-progress resumable chunked upload for a drone dataset.

    Flow:
      1. Client POSTs to /core/drone/upload/initiate/ → receives upload_id + chunk_size
      2. Client PUTs each chunk to /core/drone/upload/{upload_id}/chunk/{index}/
         — can be interrupted and resumed: re-GET the session to find which chunks are missing
      3. Client POSTs to /core/drone/upload/{upload_id}/complete/ → Celery assembles + processes

    Chunk files are stored at:
      {MEDIA_ROOT}/drone-chunks/{upload_id}/{index:06d}.part
    and deleted once assembly is complete.
    """
    import uuid as _uuid

    UPLOADING  = 'UPLOADING'
    ASSEMBLING = 'ASSEMBLING'
    DONE       = 'DONE'
    FAILED     = 'FAILED'
    STATUS_CHOICES = [
        (UPLOADING,  'Chunks uploading'),
        (ASSEMBLING, 'Assembling chunks'),
        (DONE,       'Assembly complete'),
        (FAILED,     'Failed'),
    ]

    CHUNK_SIZE_DEFAULT = 10 * 1024 * 1024   # 10 MB

    upload_id      = models.UUIDField(default=_uuid.uuid4, unique=True, editable=False)
    original_filename = models.CharField(max_length=500)
    total_size     = models.BigIntegerField(help_text='Total file size in bytes')
    chunk_size     = models.IntegerField(default=CHUNK_SIZE_DEFAULT)
    total_chunks   = models.IntegerField()
    # Sorted list of received chunk indices (0-based)
    received_chunks = models.JSONField(default=list)

    # Dataset metadata (replicated from the upload form)
    name           = models.CharField(max_length=255)
    description    = models.TextField(blank=True)
    data_type      = models.CharField(max_length=15, choices=DroneDataset.DATA_TYPE_CHOICES)
    organisation   = models.ForeignKey(
        'accounts.Organisation', on_delete=models.CASCADE, related_name='+',
    )
    project        = models.ForeignKey(
        'survey_projects.SurveyProject', on_delete=models.SET_NULL,
        null=True, blank=True, related_name='+',
    )
    folder         = models.ForeignKey(
        'survey_projects.ProjectLayerFolder', on_delete=models.SET_NULL,
        null=True, blank=True, related_name='+',
    )
    uploaded_by    = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name='+',
    )

    # Result
    status         = models.CharField(max_length=12, choices=STATUS_CHOICES, default=UPLOADING)
    error          = models.TextField(blank=True)
    dataset        = models.OneToOneField(
        DroneDataset, on_delete=models.SET_NULL,
        null=True, blank=True, related_name='upload_session',
    )

    created_at     = models.DateTimeField(auto_now_add=True)
    # Sessions expire after 48 h; a Celery beat task prunes them
    expires_at     = models.DateTimeField()

    class Meta:
        ordering = ['-created_at']
        indexes  = [models.Index(fields=['upload_id']),
                    models.Index(fields=['uploaded_by', 'status'])]

    def __str__(self):
        done = len(self.received_chunks)
        return f'UploadSession({self.upload_id}, {done}/{self.total_chunks} chunks, {self.status})'

    def chunk_dir(self) -> str:
        import os
        from django.conf import settings as _s
        return os.path.join(_s.MEDIA_ROOT, 'drone-chunks', str(self.upload_id))

    def chunk_path(self, index: int) -> str:
        import os
        return os.path.join(self.chunk_dir(), f'{index:06d}.part')

    @property
    def progress_pct(self) -> int:
        if not self.total_chunks:
            return 0
        return round(len(self.received_chunks) * 100 / self.total_chunks)

    @property
    def missing_chunks(self) -> list:
        received = set(self.received_chunks)
        return [i for i in range(self.total_chunks) if i not in received]

