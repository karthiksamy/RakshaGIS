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


class GISFeature(models.Model):
    POINT = 'POINT'
    LINE = 'LINE'
    POLYGON = 'POLYGON'

    GEOMETRY_TYPE_CHOICES = [
        (POINT, 'Point'),
        (LINE, 'Line'),
        (POLYGON, 'Polygon'),
    ]

    project = models.ForeignKey(SurveyProject, on_delete=models.CASCADE, related_name='features')
    feature_id = models.CharField(max_length=50, blank=True)
    layer_name = models.CharField(max_length=64, validators=[validate_layer_name])
    geometry_type = models.CharField(max_length=10, choices=GEOMETRY_TYPE_CHOICES)
    geometry = gis_models.GeometryField(srid=4326)
    attributes = models.JSONField(default=dict)
    is_deleted = models.BooleanField(default=False)

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
    file               = models.FileField(upload_to=_shapefile_upload_path)
    layer_name         = models.CharField(max_length=64, validators=[validate_layer_name])
    attribute_template = models.ForeignKey(
        AttributeTemplate, null=True, blank=True,
        on_delete=models.SET_NULL, related_name='imports',
        help_text='Optional: validate imported attributes against this template'
    )
    status             = models.CharField(max_length=10, choices=STATUS_CHOICES, default=PENDING)
    feature_count      = models.PositiveIntegerField(null=True, blank=True)
    error              = models.TextField(blank=True)
    created_by         = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name='shapefile_imports'
    )
    created_at         = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['-created_at']

    def __str__(self):
        return f"{self.layer_name} → {self.project.project_number} [{self.status}]"
