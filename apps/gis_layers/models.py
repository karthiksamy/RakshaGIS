from django.conf import settings
from django.contrib.gis.db import models


class State(models.Model):
    name = models.CharField(max_length=100)
    code = models.CharField(max_length=5, unique=True)
    geometry = models.MultiPolygonField(srid=4326, null=True, blank=True)

    def __str__(self):
        return self.name


class District(models.Model):
    name = models.CharField(max_length=100)
    code = models.CharField(max_length=10, unique=True)
    state = models.ForeignKey(State, on_delete=models.PROTECT, related_name='districts')
    geometry = models.MultiPolygonField(srid=4326, null=True, blank=True)

    def __str__(self):
        return f"{self.name}, {self.state.name}"


class Taluk(models.Model):
    name = models.CharField(max_length=100)
    code = models.CharField(max_length=15, unique=True)
    district = models.ForeignKey(District, on_delete=models.PROTECT, related_name='taluks')
    geometry = models.MultiPolygonField(srid=4326, null=True, blank=True)

    def __str__(self):
        return f"{self.name}, {self.district.name}"


class Village(models.Model):
    name = models.CharField(max_length=100)
    code = models.CharField(max_length=20, unique=True)
    taluk = models.ForeignKey(Taluk, on_delete=models.PROTECT, related_name='villages')
    geometry = models.MultiPolygonField(srid=4326, null=True, blank=True)

    def __str__(self):
        return f"{self.name}, {self.taluk.name}"


class RevenueMap(models.Model):
    survey_number = models.CharField(max_length=50)
    village = models.ForeignKey(Village, on_delete=models.PROTECT, related_name='revenue_maps')
    geometry = models.MultiPolygonField(srid=4326, null=True, blank=True)
    area_hectares = models.DecimalField(max_digits=12, decimal_places=4, null=True, blank=True)
    classification = models.CharField(max_length=100, blank=True)
    notes = models.TextField(blank=True)

    class Meta:
        unique_together = ['survey_number', 'village']

    def __str__(self):
        return f"Survey {self.survey_number} — {self.village.name}"


class BoundaryImportJob(models.Model):
    PENDING = 'PENDING'
    RUNNING = 'RUNNING'
    DONE = 'DONE'
    FAILED = 'FAILED'
    STATUS_CHOICES = [(s, s) for s in (PENDING, RUNNING, DONE, FAILED)]

    LEVEL_CHOICES = [
        ('state', 'State'),
        ('district', 'District'),
        ('taluk', 'Taluk'),
        ('village', 'Village'),
    ]

    level = models.CharField(max_length=10, choices=LEVEL_CHOICES)
    file = models.FileField(upload_to='boundary_imports/')
    name_field = models.CharField(max_length=64, default='NAME')
    code_field = models.CharField(max_length=64, default='CODE')
    parent_code_field = models.CharField(max_length=64, blank=True, default='')
    spatial_parent = models.BooleanField(default=False)
    clear_existing = models.BooleanField(default=False)
    status = models.CharField(max_length=10, choices=STATUS_CHOICES, default=PENDING)
    result = models.JSONField(null=True, blank=True)
    error_log = models.TextField(blank=True)
    uploaded_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, related_name='+'
    )
    created_at = models.DateTimeField(auto_now_add=True)
    completed_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ['-created_at']

    def __str__(self):
        return f'BoundaryImport({self.level}, {self.status}, {self.created_at:%Y-%m-%d})'
