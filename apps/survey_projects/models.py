import re

from django.contrib.gis.db import models as gis_models
from django.core.exceptions import ValidationError
from django.db import models
from django.conf import settings


def validate_layer_name(value):
    """Layer/folder names: letter-start, alphanumeric + underscore, max 64 chars."""
    if not re.fullmatch(r'[A-Za-z][A-Za-z0-9_]{0,63}', value):
        raise ValidationError(
            'Layer name must start with a letter, contain only letters, digits, or '
            'underscores, and be at most 64 characters.'
        )


class SurveyProject(models.Model):
    # Status choices
    DRAFT = 'DRAFT'
    SUBMITTED = 'SUBMITTED'
    UNDER_REVIEW = 'UNDER_REVIEW'
    APPROVED = 'APPROVED'
    PUBLISHED = 'PUBLISHED'
    RETURNED = 'RETURNED'   # replaces REJECTED — sent back for revision

    STATUS_CHOICES = [
        (DRAFT, 'Draft'),
        (SUBMITTED, 'Submitted for Checking'),
        (UNDER_REVIEW, 'Under Review'),
        (APPROVED, 'Approved'),
        (PUBLISHED, 'Published'),
        (RETURNED, 'Returned for Revision'),
    ]

    # Survey type choices
    BOUNDARY = 'BOUNDARY'
    TOPOGRAPHIC = 'TOPOGRAPHIC'
    CANTONMENT = 'CANTONMENT'
    REVENUE = 'REVENUE'
    LAYOUT = 'LAYOUT'
    OTHER_TYPE = 'OTHER'

    SURVEY_TYPE_CHOICES = [
        (BOUNDARY, 'Boundary Survey'),
        (TOPOGRAPHIC, 'Topographic Survey'),
        (CANTONMENT, 'Cantonment Survey'),
        (REVENUE, 'Revenue Survey'),
        (LAYOUT, 'Layout / Sub-division'),
        (OTHER_TYPE, 'Other'),
    ]

    # Priority choices
    LOW = 'LOW'
    NORMAL = 'NORMAL'
    HIGH = 'HIGH'
    URGENT = 'URGENT'

    PRIORITY_CHOICES = [
        (LOW, 'Low'),
        (NORMAL, 'Normal'),
        (HIGH, 'High'),
        (URGENT, 'Urgent'),
    ]

    name = models.CharField(max_length=200)
    project_number = models.CharField(max_length=50, unique=True)
    description = models.TextField(blank=True)
    survey_type = models.CharField(max_length=15, choices=SURVEY_TYPE_CHOICES, default=BOUNDARY)
    priority = models.CharField(max_length=10, choices=PRIORITY_CHOICES, default=NORMAL)
    organisation = models.ForeignKey(
        'accounts.Organisation', on_delete=models.PROTECT, related_name='projects'
    )
    status = models.CharField(max_length=20, choices=STATUS_CHOICES, default=DRAFT)

    # Administrative hierarchy linkage
    state = models.ForeignKey('gis_layers.State', on_delete=models.SET_NULL, null=True, blank=True)
    district = models.ForeignKey('gis_layers.District', on_delete=models.SET_NULL, null=True, blank=True)
    taluk = models.ForeignKey('gis_layers.Taluk', on_delete=models.SET_NULL, null=True, blank=True)
    village = models.ForeignKey('gis_layers.Village', on_delete=models.SET_NULL, null=True, blank=True)

    extent = gis_models.PolygonField(srid=4326, null=True, blank=True)
    total_area_hectares = models.DecimalField(max_digits=14, decimal_places=4, null=True, blank=True)

    # When False, this project's published data is hidden from higher levels (PDDE/DGDE).
    # The owning office still sees it. Toggled by DEO/ADEO/CEO admins.
    map_enabled = models.BooleanField(default=True)

    start_date = models.DateField(null=True, blank=True)
    target_date = models.DateField(null=True, blank=True)

    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name='created_projects'
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['-created_at']
        indexes = [
            models.Index(fields=['status', 'organisation']),
            models.Index(fields=['organisation', 'created_at']),
        ]

    def __str__(self):
        return f"{self.project_number} — {self.name}"


class ProjectLayerFolder(models.Model):
    COMMON    = 'COMMON'
    BOUNDARY  = 'BOUNDARY'
    PHASE     = 'PHASE'
    ZONE      = 'ZONE'
    YEAR      = 'YEAR'
    VERSION   = 'VERSION'
    DOC       = 'DOC'
    SHAPEFILE = 'SHAPEFILE'
    RASTER    = 'RASTER'
    OTHERS    = 'OTHERS'

    TYPE_CHOICES = [
        (COMMON,    'Common Layer'),
        (BOUNDARY,  'Admin Boundary'),
        (PHASE,     'Phase'),
        (ZONE,      'Pockets'),
        (YEAR,      'Year'),
        (VERSION,   'Version'),
        (DOC,       'Document Folder'),
        (SHAPEFILE, 'Shape Files Folder'),
        (RASTER,    'Raster / GeoTIFF Folder'),
        (OTHERS,    'Others'),
    ]

    # Leaf-level folder types — these get file leaves in the tree
    LEAF_TYPES = (DOC, SHAPEFILE, RASTER)

    project     = models.ForeignKey(SurveyProject, on_delete=models.CASCADE, related_name='folders')
    parent      = models.ForeignKey('self', null=True, blank=True, on_delete=models.CASCADE, related_name='children')
    name        = models.CharField(max_length=200)
    folder_type = models.CharField(max_length=10, choices=TYPE_CHOICES)
    year        = models.PositiveSmallIntegerField(null=True, blank=True)
    is_final    = models.BooleanField(default=False)
    order       = models.PositiveSmallIntegerField(default=0)
    created_by  = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True)
    created_at  = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['order', 'name']

    def __str__(self):
        return f"{self.project.project_number} / {self.name}"


class SurveyArea(models.Model):
    """
    A named geographic/survey work unit within a project.
    Workflow (submit → check → approve) is performed at this level,
    not at the project level.
    """
    DRAFT        = 'DRAFT'
    SUBMITTED    = 'SUBMITTED'
    UNDER_REVIEW = 'UNDER_REVIEW'
    APPROVED     = 'APPROVED'
    PUBLISHED    = 'PUBLISHED'
    RETURNED     = 'RETURNED'

    STATUS_CHOICES = [
        (DRAFT,        'Draft'),
        (SUBMITTED,    'Submitted for Checking'),
        (UNDER_REVIEW, 'Under Review'),
        (APPROVED,     'Approved'),
        (PUBLISHED,    'Published'),
        (RETURNED,     'Returned for Revision'),
    ]

    project     = models.ForeignKey(SurveyProject, on_delete=models.CASCADE, related_name='survey_areas')
    name        = models.CharField(max_length=200)
    area_code   = models.CharField(max_length=50, blank=True)
    description = models.TextField(blank=True)
    # Optional link to the root layer folder for this area's GIS data
    folder      = models.OneToOneField(
        'ProjectLayerFolder', on_delete=models.SET_NULL, null=True, blank=True,
        related_name='survey_area_link',
    )
    assigned_to = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True,
        related_name='assigned_survey_areas',
    )
    status      = models.CharField(max_length=20, choices=STATUS_CHOICES, default=DRAFT)
    # When False, this area's published data is hidden from higher levels (PDDE/DGDE).
    # The owning office still sees it. Toggled by DEO/ADEO/CEO admins.
    map_enabled = models.BooleanField(default=True)
    created_by  = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True,
        related_name='created_survey_areas',
    )
    created_at  = models.DateTimeField(auto_now_add=True)
    updated_at  = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['name']
        unique_together = [('project', 'name')]
        indexes = [
            models.Index(fields=['project', 'status']),
        ]

    def __str__(self):
        return f"{self.project.project_number} / {self.name}"


class ProjectShare(models.Model):
    """CEO/ADEO grants a specific DEO org read-only view access to one of their projects."""
    project      = models.ForeignKey(SurveyProject, on_delete=models.CASCADE, related_name='shares')
    granted_to   = models.ForeignKey(
        'accounts.Organisation', on_delete=models.CASCADE, related_name='shared_projects'
    )
    granted_by   = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, related_name='granted_shares'
    )
    created_at   = models.DateTimeField(auto_now_add=True)

    class Meta:
        unique_together = [('project', 'granted_to')]

    def __str__(self):
        return f"{self.project.project_number} → {self.granted_to.code}"


class GISFeature(models.Model):
    POINT = 'POINT'
    LINE = 'LINE'
    POLYGON = 'POLYGON'

    GEOMETRY_TYPE_CHOICES = [
        (POINT, 'Point'),
        (LINE, 'Line'),
        (POLYGON, 'Polygon'),
    ]

    project    = models.ForeignKey(SurveyProject, on_delete=models.CASCADE, related_name='features')
    folder     = models.ForeignKey(
        ProjectLayerFolder, null=True, blank=True,
        on_delete=models.SET_NULL, related_name='features'
    )
    feature_id = models.CharField(max_length=50, blank=True)
    layer_name = models.CharField(max_length=64, validators=[validate_layer_name])
    geometry_type = models.CharField(max_length=10, choices=GEOMETRY_TYPE_CHOICES)
    geometry = gis_models.GeometryField(srid=4326)
    attributes = models.JSONField(default=dict)
    is_deleted = models.BooleanField(default=False)
    # When True, this dataset is visible to the parent DEO office (and its subtree)
    # even though it belongs to a subordinate CEO/ADEO org. Default True = opt-out model.
    deo_visible = models.BooleanField(
        default=True,
        help_text='Allow the parent DEO office to view this feature in the Map Viewer.'
    )

    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name='created_features'
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['layer_name', 'id']
        indexes = [
            models.Index(fields=['project', 'layer_name']),
            models.Index(fields=['project', 'is_deleted']),
            models.Index(fields=['folder', 'is_deleted']),
            models.Index(fields=['project', 'deo_visible', 'is_deleted']),
        ]

    def __str__(self):
        return f"{self.layer_name} [{self.geometry_type}] — {self.project.project_number}"


class DefenceParcel(models.Model):
    CANTONMENT = 'CANTONMENT'
    RANGE = 'RANGE'
    AIRFIELD = 'AIRFIELD'
    DEPOT = 'DEPOT'
    TRAINING_AREA = 'TRAINING_AREA'
    HOSPITAL = 'HOSPITAL'
    OFFICE = 'OFFICE'
    RESIDENTIAL = 'RESIDENTIAL'
    OTHER = 'OTHER'

    CATEGORY_CHOICES = [
        (CANTONMENT, 'Cantonment'),
        (RANGE, 'Firing / Training Range'),
        (AIRFIELD, 'Airfield / Helipad'),
        (DEPOT, 'Depot / Storehouse'),
        (TRAINING_AREA, 'Training Area'),
        (HOSPITAL, 'Military Hospital'),
        (OFFICE, 'Office / HQ'),
        (RESIDENTIAL, 'Residential Colony'),
        (OTHER, 'Other'),
    ]

    UNCLASSIFIED = 'UNCLASSIFIED'
    RESTRICTED = 'RESTRICTED'
    CONFIDENTIAL = 'CONFIDENTIAL'
    SECRET = 'SECRET'

    CLASSIFICATION_CHOICES = [
        (UNCLASSIFIED, 'Unclassified'),
        (RESTRICTED, 'Restricted'),
        (CONFIDENTIAL, 'Confidential'),
        (SECRET, 'Secret'),
    ]

    parcel_id = models.CharField(max_length=50, unique=True)
    name = models.CharField(max_length=200)
    category = models.CharField(max_length=20, choices=CATEGORY_CHOICES)
    classification = models.CharField(max_length=15, choices=CLASSIFICATION_CHOICES, default=UNCLASSIFIED)
    organisation = models.ForeignKey(
        'accounts.Organisation', on_delete=models.PROTECT, related_name='parcels'
    )

    # Administrative hierarchy
    state = models.ForeignKey('gis_layers.State', on_delete=models.PROTECT)
    district = models.ForeignKey('gis_layers.District', on_delete=models.PROTECT)
    taluk = models.ForeignKey('gis_layers.Taluk', on_delete=models.SET_NULL, null=True, blank=True)
    village = models.ForeignKey('gis_layers.Village', on_delete=models.SET_NULL, null=True, blank=True)

    # Spatial
    geometry = gis_models.MultiPolygonField(srid=4326)
    area_hectares = models.DecimalField(max_digits=14, decimal_places=4)

    # Linkages
    revenue_maps = models.ManyToManyField('gis_layers.RevenueMap', blank=True, related_name='parcels')
    survey_project = models.ForeignKey(
        SurveyProject, on_delete=models.SET_NULL,
        null=True, blank=True, related_name='parcels',
        help_text='Most recent survey project that defined this parcel boundary'
    )

    encumbrance_notes = models.TextField(blank=True)
    remarks = models.TextField(blank=True)

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['parcel_id']
        indexes = [
            models.Index(fields=['organisation', 'category']),
            models.Index(fields=['state', 'district']),
        ]

    def __str__(self):
        return f"{self.parcel_id} — {self.name} ({self.get_category_display()})"


class AttributeTemplate(models.Model):
    """
    Defines the custom attribute schema for a named GIS layer within an organisation.
    SDO/Surveyor fills these attributes when adding features or importing shapefiles.

    `fields` is a list of field definitions, e.g.:
    [
      {"name": "survey_no",  "type": "string",  "required": true,  "label": "Survey No",  "max_length": 50},
      {"name": "area_sqm",   "type": "decimal", "required": true,  "label": "Area (sq.m)"},
      {"name": "land_type",  "type": "choice",  "required": false, "label": "Land Type",
       "choices": ["Agricultural", "Forest", "Cantonment", "Urban"]},
      {"name": "remarks",    "type": "string",  "required": false, "label": "Remarks"}
    ]

    Supported field types: string, integer, decimal, date, boolean, choice
    """

    organisation = models.ForeignKey(
        'accounts.Organisation', on_delete=models.CASCADE, related_name='attribute_templates'
    )
    layer_name  = models.CharField(max_length=64, validators=[validate_layer_name])
    description = models.CharField(max_length=200, blank=True)
    fields      = models.JSONField(
        default=list,
        help_text='Ordered list of field definition objects (see model docstring).'
    )
    created_by  = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name='attribute_templates'
    )
    created_at  = models.DateTimeField(auto_now_add=True)
    updated_at  = models.DateTimeField(auto_now=True)

    class Meta:
        unique_together = [('organisation', 'layer_name')]
        ordering = ['layer_name']

    def __str__(self):
        return f"{self.organisation.code} / {self.layer_name}"


def _shapefile_upload_path(instance, filename):
    from apps.core.folder_manager import get_project_rel_path
    return f"{get_project_rel_path(instance.project)}/shapefiles/{filename}"


class ShapefileImport(models.Model):
    """Tracks a single shapefile (.zip) upload and its async import into GISFeature rows."""

    PENDING = 'PENDING'
    RUNNING = 'RUNNING'
    DONE    = 'DONE'
    FAILED  = 'FAILED'

    STATUS_CHOICES = [
        (PENDING, 'Pending'),
        (RUNNING, 'Running'),
        (DONE,    'Done'),
        (FAILED,  'Failed'),
    ]

    project            = models.ForeignKey(
        SurveyProject, on_delete=models.CASCADE, related_name='shapefile_imports'
    )
    folder             = models.ForeignKey(
        'ProjectLayerFolder', null=True, blank=True,
        on_delete=models.SET_NULL, related_name='shapefile_imports',
    )
    file               = models.FileField(upload_to=_shapefile_upload_path)
    layer_name         = models.CharField(max_length=64, validators=[validate_layer_name])
    attribute_template = models.ForeignKey(
        AttributeTemplate, null=True, blank=True,
        on_delete=models.SET_NULL, related_name='imports',
        help_text='Optional: validate imported attributes against this template'
    )
    status             = models.CharField(max_length=10, choices=STATUS_CHOICES, default=PENDING)
    # Propagated onto every GISFeature created by this import (see import_shapefile task).
    deo_visible        = models.BooleanField(
        default=True,
        help_text='Allow the parent DEO office to view the features imported from this file.'
    )
    feature_count      = models.PositiveIntegerField(null=True, blank=True)
    columns            = models.JSONField(default=list, blank=True,
                             help_text='Attribute column names detected in the source file')
    error              = models.TextField(blank=True)
    ai_processed       = models.BooleanField(default=False)
    ai_summary         = models.TextField(blank=True)
    created_by         = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name='shapefile_imports'
    )
    created_at         = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['-created_at']

    def __str__(self):
        return f"{self.layer_name} → {self.project.project_number} [{self.status}]"


def _geotiff_upload_path(instance, filename):
    from apps.core.folder_manager import get_project_rel_path
    return f"{get_project_rel_path(instance.project)}/geotiffs/{filename}"


class GeoTiffLayer(models.Model):
    """Drone survey GeoTiff uploaded by SDO/Surveyor. Converted to COG async by Celery."""

    PENDING = 'PENDING'
    PROCESSING = 'PROCESSING'
    DONE = 'DONE'
    FAILED = 'FAILED'

    STATUS_CHOICES = [
        (PENDING, 'Pending'),
        (PROCESSING, 'Processing'),
        (DONE, 'Done'),
        (FAILED, 'Failed'),
    ]

    project     = models.ForeignKey(SurveyProject, on_delete=models.CASCADE, related_name='geotiff_layers')
    folder      = models.ForeignKey(
        ProjectLayerFolder, null=True, blank=True,
        on_delete=models.SET_NULL, related_name='geotiff_layers'
    )
    name        = models.CharField(max_length=200)
    file        = models.FileField(upload_to=_geotiff_upload_path)
    cog_file    = models.FileField(upload_to=_geotiff_upload_path, blank=True)
    status      = models.CharField(max_length=15, choices=STATUS_CHOICES, default=PENDING)
    error       = models.TextField(blank=True)
    is_visible  = models.BooleanField(default=True)
    deo_visible = models.BooleanField(
        default=True,
        help_text='Allow the parent DEO office to view this raster in the Map Viewer.'
    )
    opacity     = models.FloatField(default=0.8)
    created_by  = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name='geotiff_layers')
    created_at  = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['-created_at']

    def __str__(self):
        return f"{self.name} — {self.project.project_number} [{self.status}]"


# ── Feature Attachments ───────────────────────────────────────────────────────

def _attachment_upload_path(instance, filename):
    return f"features/{instance.feature.project_id}/{instance.feature_id}/attachments/{filename}"


class FeatureAttachment(models.Model):
    feature = models.ForeignKey(GISFeature, on_delete=models.CASCADE, related_name='attachments')
    file = models.FileField(upload_to=_attachment_upload_path)
    original_filename = models.CharField(max_length=255)
    file_size = models.PositiveIntegerField(default=0)
    file_type = models.CharField(max_length=10, blank=True)  # image, pdf, doc
    caption = models.CharField(max_length=500, blank=True)
    uploaded_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL,
        null=True, related_name='feature_attachments'
    )
    uploaded_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['-uploaded_at']

    def __str__(self):
        return f"{self.original_filename} → feature {self.feature_id}"


# ── Project Milestones (Gantt) ────────────────────────────────────────────────

class ProjectMilestone(models.Model):
    PENDING = 'PENDING'
    IN_PROGRESS = 'IN_PROGRESS'
    COMPLETED = 'COMPLETED'
    DELAYED = 'DELAYED'

    STATUS_CHOICES = [
        (PENDING, 'Pending'),
        (IN_PROGRESS, 'In Progress'),
        (COMPLETED, 'Completed'),
        (DELAYED, 'Delayed'),
    ]

    project = models.ForeignKey(SurveyProject, on_delete=models.CASCADE, related_name='milestones')
    name = models.CharField(max_length=200)
    description = models.TextField(blank=True)
    start_date = models.DateField(null=True, blank=True)
    due_date = models.DateField()
    completed_date = models.DateField(null=True, blank=True)
    status = models.CharField(max_length=15, choices=STATUS_CHOICES, default=PENDING)
    assignee = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL,
        null=True, blank=True, related_name='milestones'
    )
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name='created_milestones'
    )
    order = models.PositiveSmallIntegerField(default=0)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['due_date', 'order']
        indexes = [models.Index(fields=['project', 'due_date'])]

    def __str__(self):
        return f"{self.project.project_number} / {self.name}"


class QGISUploadLog(models.Model):
    """
    Server-side record of every file uploaded by the QGIS Sync plugin.
    Used for history tracking, duplicate detection, and audit.
    """

    SUCCESS   = 'SUCCESS'
    FAILED    = 'FAILED'
    SKIPPED   = 'SKIPPED'

    STATUS_CHOICES = [
        (SUCCESS, 'Success'),
        (FAILED,  'Failed'),
        (SKIPPED, 'Skipped (duplicate)'),
    ]

    project     = models.ForeignKey(
        SurveyProject, on_delete=models.CASCADE, related_name='qgis_uploads'
    )
    folder      = models.ForeignKey(
        ProjectLayerFolder, null=True, blank=True,
        on_delete=models.SET_NULL, related_name='qgis_uploads'
    )
    filename        = models.CharField(max_length=255)
    original_path   = models.CharField(max_length=1000, blank=True,
                         help_text='Full file path on the QGIS workstation')
    file_size       = models.PositiveBigIntegerField(default=0)
    algorithm_id    = models.CharField(max_length=200, blank=True,
                         help_text='QGIS Processing algorithm that generated the file')
    module_name     = models.CharField(max_length=200, blank=True,
                         help_text='Module name resolved for folder routing')
    status          = models.CharField(max_length=10, choices=STATUS_CHOICES, default=SUCCESS)
    error_message   = models.TextField(blank=True)
    uploaded_by     = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL,
        null=True, related_name='qgis_uploads'
    )
    uploaded_at     = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['-uploaded_at']
        indexes  = [models.Index(fields=['project', 'uploaded_at'])]

    def __str__(self):
        return f"{self.filename} → {self.project.project_number} [{self.status}]"


class SurveyAreaAccessRequest(models.Model):
    """
    A DEO/CEO/ADEO user requests read-only access to a specific survey area
    that belongs to another org (sibling under the same PDDE).
    The target org's admin approves or rejects.
    """
    PENDING  = 'PENDING'
    APPROVED = 'APPROVED'
    REJECTED = 'REJECTED'

    STATUS_CHOICES = [
        (PENDING,  'Pending Review'),
        (APPROVED, 'Approved'),
        (REJECTED, 'Rejected'),
    ]

    survey_area    = models.ForeignKey(
        SurveyArea, on_delete=models.CASCADE, related_name='access_requests'
    )
    requested_by   = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE,
        related_name='area_access_requests_sent'
    )
    requesting_org = models.ForeignKey(
        'accounts.Organisation', on_delete=models.CASCADE,
        related_name='area_access_requests_sent'
    )
    reason         = models.TextField(blank=True, help_text='Why access is needed')
    status         = models.CharField(max_length=10, choices=STATUS_CHOICES, default=PENDING)
    reviewed_by    = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True,
        on_delete=models.SET_NULL, related_name='area_access_requests_reviewed'
    )
    reviewed_at    = models.DateTimeField(null=True, blank=True)
    review_remarks = models.TextField(blank=True)
    created_at     = models.DateTimeField(auto_now_add=True)

    class Meta:
        unique_together = [('survey_area', 'requesting_org')]
        ordering = ['-created_at']

    def __str__(self):
        return f"{self.requesting_org.code} → {self.survey_area} [{self.status}]"


class TemporaryLayer(models.Model):
    """User-uploaded scratch layers (KML/KMZ/GeoJSON/Shapefile ZIP) for ad-hoc map viewing.
    Stored separately from project GISFeature data — no project association required.
    """
    KML       = 'kml'
    KMZ       = 'kmz'
    GEOJSON   = 'geojson'
    SHAPEFILE = 'shapefile'

    FORMAT_CHOICES = [
        (KML,       'KML'),
        (KMZ,       'KMZ'),
        (GEOJSON,   'GeoJSON'),
        (SHAPEFILE, 'Shapefile (ZIP)'),
    ]

    # Purpose choices
    PURPOSE_NOC   = 'NOC_WORKING_PERMISSION'
    PURPOSE_PM    = 'PM_GATI_SHAKTI'
    PURPOSE_OTHER = 'OTHER'
    PURPOSE_CHOICES = [
        (PURPOSE_NOC,   'NOC Working Permission'),
        (PURPOSE_PM,    'PM GatiShakti'),
        (PURPOSE_OTHER, 'Other'),
    ]

    # Land rights choices
    LR_LICENSE    = 'LICENSE'
    LR_LEASE      = 'LEASE'
    LR_PERMANENT  = 'PERMANENT_TRANSFER'
    LR_OTHER      = 'OTHER'
    LAND_RIGHTS_CHOICES = [
        (LR_LICENSE,   'License'),
        (LR_LEASE,     'Lease'),
        (LR_PERMANENT, 'Permanent Transfer'),
        (LR_OTHER,     'Other'),
    ]

    name             = models.CharField(max_length=200)
    purpose          = models.CharField(max_length=500, blank=True)   # legacy free-text, kept for compat
    purpose_type     = models.CharField(max_length=50, blank=True, choices=PURPOSE_CHOICES)
    purpose_other    = models.CharField(max_length=500, blank=True)
    land_rights_type = models.CharField(max_length=50, blank=True, choices=LAND_RIGHTS_CHOICES)
    land_rights_other= models.CharField(max_length=500, blank=True)
    description      = models.TextField(blank=True)
    file_format      = models.CharField(max_length=20, choices=FORMAT_CHOICES)
    file             = models.FileField(upload_to='temp_layers/')
    geojson          = models.JSONField(null=True, blank=True)
    feature_count    = models.IntegerField(default=0)
    analysis_result  = models.JSONField(null=True, blank=True)
    # Temp layers are uploader-scoped by default. When True, a CEO/ADEO uploader's
    # temp layer is also visible to the parent DEO office (and its subtree).
    deo_visible      = models.BooleanField(
        default=True,
        help_text='Allow the parent DEO office to view this temporary layer.'
    )
    uploaded_by      = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE,
        related_name='temp_layers'
    )
    created_at    = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['-created_at']

    def __str__(self):
        return f"{self.name} [{self.file_format}] by {self.uploaded_by}"

    @property
    def effective_purpose(self):
        if self.purpose_type == self.PURPOSE_OTHER:
            return self.purpose_other
        return dict(self.PURPOSE_CHOICES).get(self.purpose_type, self.purpose or '')

    @property
    def effective_land_rights(self):
        if self.land_rights_type == self.LR_OTHER:
            return self.land_rights_other
        return dict(self.LAND_RIGHTS_CHOICES).get(self.land_rights_type, '')
