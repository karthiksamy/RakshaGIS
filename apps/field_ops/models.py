"""
Field Operations
================
Four modules that address the highest-impact gaps in daily DGDE survey workflow:

  1. EncroachmentRecord / EncroachmentAttachment
     — Formal register of encroachments on defence land with full lifecycle tracking.

  2. FieldDiaryEntry / DPREquipmentUsage
     — Daily Progress Report (DPR) capturing site work, manpower, and equipment used.

  3. EquipmentCategory / EquipmentItem / EquipmentIssue / EquipmentMaintenance
     — Survey equipment register: inventory, issue/return log, calibration tracking.
     All data is local (PostgreSQL) — works fully on dedicated lease-line networks
     with no internet dependency.

  4. SubmissionChecklist
     — Auto-computed pre-submission gate for SurveyAreas. Surveyor runs the check;
     must acknowledge any blocking failures before the submit button enables.
"""
from django.conf import settings
from django.core.validators import MaxValueValidator
from django.db import models


# ─────────────────────────────────────────────────────────────────────────────
# 1. ENCROACHMENT REGISTER
# ─────────────────────────────────────────────────────────────────────────────

class EncroachmentRecord(models.Model):
    TYPE_OCCUPATION   = 'OCCUPATION'
    TYPE_CULTIVATION  = 'CULTIVATION'
    TYPE_CONSTRUCTION = 'CONSTRUCTION'
    TYPE_COMMERCIAL   = 'COMMERCIAL'
    TYPE_MINING       = 'MINING'
    TYPE_OTHER        = 'OTHER'
    TYPE_CHOICES = [
        (TYPE_OCCUPATION,   'Unauthorized Occupation'),
        (TYPE_CULTIVATION,  'Cultivation'),
        (TYPE_CONSTRUCTION, 'Unauthorized Construction'),
        (TYPE_COMMERCIAL,   'Commercial Encroachment'),
        (TYPE_MINING,       'Mining / Quarrying'),
        (TYPE_OTHER,        'Other'),
    ]

    STATUS_DETECTED      = 'DETECTED'
    STATUS_NOTICE_SERVED = 'NOTICE_SERVED'
    STATUS_LEGAL_ACTION  = 'LEGAL_ACTION'
    STATUS_EVICTED       = 'EVICTED'
    STATUS_REGULARISED   = 'REGULARISED'
    STATUS_CLOSED        = 'CLOSED'
    STATUS_CHOICES = [
        (STATUS_DETECTED,      'Detected'),
        (STATUS_NOTICE_SERVED, 'Notice Served'),
        (STATUS_LEGAL_ACTION,  'Legal Action Initiated'),
        (STATUS_EVICTED,       'Evicted'),
        (STATUS_REGULARISED,   'Regularised'),
        (STATUS_CLOSED,        'Closed'),
    ]

    organisation   = models.ForeignKey('accounts.Organisation', on_delete=models.CASCADE,
                         related_name='encroachments')
    defence_parcel = models.ForeignKey('survey_projects.DefenceParcel',
                         on_delete=models.SET_NULL, null=True, blank=True,
                         related_name='encroachments')
    survey_project = models.ForeignKey('survey_projects.SurveyProject',
                         on_delete=models.SET_NULL, null=True, blank=True,
                         related_name='encroachments')
    gis_feature    = models.ForeignKey('survey_projects.GISFeature',
                         on_delete=models.SET_NULL, null=True, blank=True,
                         related_name='encroachments',
                         help_text='Mapped GIS polygon of the encroached area')

    encroachment_type  = models.CharField(max_length=20, choices=TYPE_CHOICES)
    encroacher_name    = models.CharField(max_length=300)
    encroacher_address = models.TextField(blank=True)
    encroacher_contact = models.CharField(max_length=100, blank=True)
    area_sqm           = models.DecimalField(max_digits=14, decimal_places=2,
                             null=True, blank=True,
                             help_text='Encroached area in square metres')

    detected_date = models.DateField()
    detected_by   = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.SET_NULL,
                        null=True, related_name='encroachments_detected')

    status        = models.CharField(max_length=20, choices=STATUS_CHOICES,
                        default=STATUS_DETECTED)
    notice_date   = models.DateField(null=True, blank=True)
    notice_ref    = models.CharField(max_length=200, blank=True,
                        help_text='Notice number / reference')
    eviction_date = models.DateField(null=True, blank=True)
    case_ref      = models.CharField(max_length=200, blank=True,
                        help_text='Court case or file reference number')
    remarks       = models.TextField(blank=True)

    created_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.SET_NULL,
                     null=True, related_name='+')
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['-detected_date', '-created_at']
        indexes = [
            models.Index(fields=['organisation', 'status']),
            models.Index(fields=['defence_parcel']),
            models.Index(fields=['detected_date']),
        ]

    def __str__(self):
        return (f'Encroachment #{self.pk} — {self.encroacher_name}'
                f' ({self.get_status_display()})')


class EncroachmentAttachment(models.Model):
    TYPE_PHOTO  = 'PHOTO'
    TYPE_NOTICE = 'NOTICE'
    TYPE_COURT  = 'COURT_ORDER'
    TYPE_SKETCH = 'SKETCH'
    TYPE_OTHER  = 'OTHER'
    TYPE_CHOICES = [
        (TYPE_PHOTO,  'Site Photograph'),
        (TYPE_NOTICE, 'Notice / Letter'),
        (TYPE_COURT,  'Court Order'),
        (TYPE_SKETCH, 'Site Sketch'),
        (TYPE_OTHER,  'Other Document'),
    ]

    encroachment = models.ForeignKey(EncroachmentRecord, on_delete=models.CASCADE,
                       related_name='attachments')
    file         = models.FileField(upload_to='encroachments/attachments/%Y/%m/')
    file_type    = models.CharField(max_length=20, choices=TYPE_CHOICES, default=TYPE_OTHER)
    description  = models.CharField(max_length=300, blank=True)
    uploaded_by  = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.SET_NULL,
                       null=True, related_name='+')
    uploaded_at  = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['uploaded_at']

    def __str__(self):
        return f'{self.get_file_type_display()} for Encroachment #{self.encroachment_id}'


# ─────────────────────────────────────────────────────────────────────────────
# 2. FIELD DIARY / DAILY PROGRESS REPORT
# ─────────────────────────────────────────────────────────────────────────────

class FieldDiaryEntry(models.Model):
    WEATHER_CLEAR         = 'CLEAR'
    WEATHER_PARTLY_CLOUDY = 'PARTLY_CLOUDY'
    WEATHER_CLOUDY        = 'CLOUDY'
    WEATHER_RAINY         = 'RAINY'
    WEATHER_FOGGY         = 'FOGGY'
    WEATHER_WINDY         = 'WINDY'
    WEATHER_CHOICES = [
        (WEATHER_CLEAR,         'Clear / Sunny'),
        (WEATHER_PARTLY_CLOUDY, 'Partly Cloudy'),
        (WEATHER_CLOUDY,        'Overcast'),
        (WEATHER_RAINY,         'Rainy'),
        (WEATHER_FOGGY,         'Foggy'),
        (WEATHER_WINDY,         'Windy'),
    ]

    survey_area  = models.ForeignKey('survey_projects.SurveyArea', on_delete=models.CASCADE,
                       related_name='diary_entries')
    surveyor     = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE,
                       related_name='diary_entries')
    date         = models.DateField()
    weather      = models.CharField(max_length=20, choices=WEATHER_CHOICES,
                       default=WEATHER_CLEAR)

    station_points_set    = models.PositiveSmallIntegerField(default=0,
                                help_text='Station points set today')
    station_points_target = models.PositiveSmallIntegerField(default=0,
                                help_text='Target station points for the day')

    work_description   = models.TextField(help_text='Survey work carried out today')
    difficulties_faced = models.TextField(blank=True)
    next_day_plan      = models.TextField(blank=True)
    remarks            = models.TextField(blank=True)

    manpower_count   = models.PositiveSmallIntegerField(default=0,
                           help_text='Total field personnel present')
    manpower_details = models.JSONField(default=list, blank=True,
                           help_text='[{"name": "Ramu", "role": "Chain Man"}]')

    photographs_taken = models.PositiveSmallIntegerField(default=0)
    progress_pct      = models.PositiveSmallIntegerField(default=0,
                            validators=[MaxValueValidator(100)],
                            help_text='Cumulative survey area completion (%)')

    equipment_used = models.ManyToManyField('field_ops.EquipmentItem',
                         through='field_ops.DPREquipmentUsage',
                         related_name='diary_entries', blank=True)

    submitted_at = models.DateTimeField(null=True, blank=True,
                       help_text='When surveyor submitted this DPR')
    approved_by  = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.SET_NULL,
                       null=True, blank=True, related_name='approved_dprs')
    approved_at  = models.DateTimeField(null=True, blank=True)

    created_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.SET_NULL,
                     null=True, related_name='+')
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['-date', '-created_at']
        unique_together = [['survey_area', 'surveyor', 'date']]
        indexes = [
            models.Index(fields=['survey_area', 'date']),
            models.Index(fields=['surveyor', 'date']),
            models.Index(fields=['submitted_at']),
        ]

    def __str__(self):
        return f'DPR {self.date} — {self.surveyor} — SurveyArea #{self.survey_area_id}'


class DPREquipmentUsage(models.Model):
    """Records which equipment was used in a DPR and for how long."""
    diary_entry = models.ForeignKey(FieldDiaryEntry, on_delete=models.CASCADE)
    equipment   = models.ForeignKey('field_ops.EquipmentItem', on_delete=models.CASCADE)
    hours_used  = models.DecimalField(max_digits=5, decimal_places=1, null=True, blank=True)
    notes       = models.CharField(max_length=200, blank=True)

    class Meta:
        unique_together = [['diary_entry', 'equipment']]

    def __str__(self):
        return f'{self.equipment} used in DPR #{self.diary_entry_id}'


# ─────────────────────────────────────────────────────────────────────────────
# 3. SURVEY EQUIPMENT REGISTER
# ─────────────────────────────────────────────────────────────────────────────

class EquipmentCategory(models.Model):
    """
    E.g. Total Station, GPS Receiver, Drone, Auto Level, Theodolite,
    Prismatic Compass, GNSS Receiver, Steel Tape, EDM.
    """
    name        = models.CharField(max_length=100, unique=True)
    description = models.TextField(blank=True)
    sort_order  = models.PositiveSmallIntegerField(default=0)

    class Meta:
        ordering = ['sort_order', 'name']
        verbose_name_plural = 'Equipment categories'

    def __str__(self):
        return self.name


class EquipmentItem(models.Model):
    """
    Individual piece of survey equipment in the organisation's inventory.
    Status and current_holder are updated automatically on issue/return.
    All data stored in local PostgreSQL — no internet required.
    """
    STATUS_AVAILABLE   = 'AVAILABLE'
    STATUS_ISSUED      = 'ISSUED'
    STATUS_MAINTENANCE = 'MAINTENANCE'
    STATUS_CONDEMNED   = 'CONDEMNED'
    STATUS_CHOICES = [
        (STATUS_AVAILABLE,   'Available'),
        (STATUS_ISSUED,      'Issued / In Use'),
        (STATUS_MAINTENANCE, 'Under Maintenance'),
        (STATUS_CONDEMNED,   'Condemned / Written Off'),
    ]

    category       = models.ForeignKey(EquipmentCategory, on_delete=models.PROTECT,
                         related_name='items')
    name           = models.CharField(max_length=200,
                         help_text='e.g. "Leica TS16 Total Station Unit-2"')
    make           = models.CharField(max_length=100, blank=True)
    model          = models.CharField(max_length=100, blank=True)
    serial_number  = models.CharField(max_length=200, blank=True)
    asset_tag      = models.CharField(max_length=100, blank=True,
                         help_text='Organisation asset register tag / sticker number')

    owned_by       = models.ForeignKey('accounts.Organisation', on_delete=models.CASCADE,
                         related_name='equipment_items')
    current_holder = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.SET_NULL,
                         null=True, blank=True, related_name='held_equipment',
                         help_text='Who currently has this item (null = in store)')

    status          = models.CharField(max_length=20, choices=STATUS_CHOICES,
                          default=STATUS_AVAILABLE)
    purchase_date   = models.DateField(null=True, blank=True)
    warranty_expiry = models.DateField(null=True, blank=True)
    calibration_due = models.DateField(null=True, blank=True,
                          help_text='Next calibration certificate due date')
    location_note   = models.CharField(max_length=300, blank=True,
                          help_text='Storage location when not issued (room / almirah / shelf)')
    notes           = models.TextField(blank=True)

    created_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.SET_NULL,
                     null=True, related_name='+')
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['category', 'name']
        indexes = [
            models.Index(fields=['owned_by', 'status']),
            models.Index(fields=['calibration_due']),
            models.Index(fields=['current_holder']),
        ]

    def __str__(self):
        tag = self.asset_tag or self.serial_number or '—'
        return f'{self.name} [{tag}]'


class EquipmentIssue(models.Model):
    """Issue/return log entry — one row per issue transaction."""
    CONDITION_GOOD             = 'GOOD'
    CONDITION_FAIR             = 'FAIR'
    CONDITION_NEEDS_ATTENTION  = 'NEEDS_ATTENTION'
    CONDITION_DAMAGED          = 'DAMAGED'
    CONDITION_LOST             = 'LOST'

    ISSUE_CONDITION_CHOICES = [
        (CONDITION_GOOD,            'Good'),
        (CONDITION_FAIR,            'Fair / Minor wear'),
        (CONDITION_NEEDS_ATTENTION, 'Needs Attention'),
    ]
    RETURN_CONDITION_CHOICES = [
        (CONDITION_GOOD,    'Good'),
        (CONDITION_FAIR,    'Fair / Minor wear'),
        (CONDITION_DAMAGED, 'Damaged'),
        (CONDITION_LOST,    'Lost'),
    ]

    equipment            = models.ForeignKey(EquipmentItem, on_delete=models.CASCADE,
                               related_name='issues')
    issued_to            = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE,
                               related_name='equipment_issues')
    issued_for_project   = models.ForeignKey('survey_projects.SurveyProject',
                               on_delete=models.SET_NULL, null=True, blank=True,
                               related_name='equipment_issues')
    issued_date          = models.DateField()
    expected_return_date = models.DateField(null=True, blank=True)
    issued_by            = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.SET_NULL,
                               null=True, related_name='equipment_issued')
    condition_at_issue   = models.CharField(max_length=20,
                               choices=ISSUE_CONDITION_CHOICES, default=CONDITION_GOOD)

    actual_return_date  = models.DateField(null=True, blank=True,
                              help_text='Null = still with user')
    returned_to         = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.SET_NULL,
                              null=True, blank=True, related_name='equipment_received')
    condition_at_return = models.CharField(max_length=20, blank=True,
                              choices=RETURN_CONDITION_CHOICES)
    remarks             = models.TextField(blank=True)

    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['-issued_date', '-created_at']
        indexes = [
            models.Index(fields=['equipment', 'actual_return_date']),
            models.Index(fields=['issued_to', 'actual_return_date']),
        ]

    def __str__(self):
        returned = self.actual_return_date or 'outstanding'
        return f'{self.equipment} → {self.issued_to} ({self.issued_date} / {returned})'


class EquipmentMaintenance(models.Model):
    TYPE_CALIBRATION = 'CALIBRATION'
    TYPE_REPAIR      = 'REPAIR'
    TYPE_SERVICE     = 'SERVICE'
    TYPE_INSPECTION  = 'INSPECTION'
    TYPE_CHOICES = [
        (TYPE_CALIBRATION, 'Calibration'),
        (TYPE_REPAIR,      'Repair'),
        (TYPE_SERVICE,     'Periodic Service'),
        (TYPE_INSPECTION,  'Inspection'),
    ]

    equipment         = models.ForeignKey(EquipmentItem, on_delete=models.CASCADE,
                            related_name='maintenance_records')
    maintenance_type  = models.CharField(max_length=20, choices=TYPE_CHOICES)
    maintenance_date  = models.DateField()
    performed_by_name = models.CharField(max_length=200,
                            help_text='Technician or vendor name (local or external)')
    cost              = models.DecimalField(max_digits=12, decimal_places=2,
                            null=True, blank=True)
    next_due_date     = models.DateField(null=True, blank=True)
    certificate_ref   = models.CharField(max_length=200, blank=True,
                            help_text='Calibration certificate number or service report ref')
    notes             = models.TextField(blank=True)
    recorded_by       = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.SET_NULL,
                            null=True, related_name='+')
    created_at        = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['-maintenance_date']
        indexes = [
            models.Index(fields=['equipment', 'maintenance_type']),
            models.Index(fields=['next_due_date']),
        ]

    def __str__(self):
        return (f'{self.get_maintenance_type_display()} — {self.equipment}'
                f' ({self.maintenance_date})')


# ─────────────────────────────────────────────────────────────────────────────
# 4. PRE-SUBMISSION AUTO-CHECKLIST
# ─────────────────────────────────────────────────────────────────────────────

class SubmissionChecklist(models.Model):
    """
    Auto-computed pre-submission checklist for a SurveyArea.

    The compute_checklist API endpoint runs all checks and saves one record.
    The latest record is always the authoritative result.
    Surveyors must acknowledge any ERROR-severity failures before the
    frontend enables the submit button.

    checks JSON schema:
    {
      "check_name": {
        "passed": true|false,
        "severity": "ERROR"|"WARN",
        "message": "human-readable explanation"
      },
      ...
    }
    """
    survey_area    = models.ForeignKey('survey_projects.SurveyArea', on_delete=models.CASCADE,
                         related_name='submission_checklists')
    checked_by     = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.SET_NULL,
                         null=True, related_name='+')
    checked_at     = models.DateTimeField(auto_now_add=True)

    checks         = models.JSONField(default=dict)
    all_passed     = models.BooleanField(default=False)
    blocking_count = models.PositiveSmallIntegerField(default=0,
                         help_text='Number of ERROR-severity failed checks')
    warning_count  = models.PositiveSmallIntegerField(default=0,
                         help_text='Number of WARN-severity failed checks')

    acknowledged_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.SET_NULL,
                          null=True, blank=True, related_name='+',
                          help_text='User who acknowledged warnings and chose to proceed')
    acknowledged_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ['-checked_at']
        indexes  = [models.Index(fields=['survey_area', 'checked_at'])]

    def __str__(self):
        status = 'PASS' if self.all_passed else f'FAIL({self.blocking_count} errors)'
        return f'Checklist SurveyArea#{self.survey_area_id} [{status}] {self.checked_at:%Y-%m-%d %H:%M}'
