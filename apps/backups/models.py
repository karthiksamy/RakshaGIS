from django.conf import settings
from django.db import models


class BackupJob(models.Model):
    """Tracks a single backup run — manual or scheduled."""

    FULL    = 'FULL'
    COMMAND = 'COMMAND'   # All orgs under one PDDE command
    OFFICE  = 'OFFICE'    # Single DEO / CEO / ADEO

    TYPE_CHOICES = [
        (FULL,    'Full Database'),
        (COMMAND, 'Command (PDDE subtree)'),
        (OFFICE,  'Office (single org)'),
    ]

    PENDING  = 'PENDING'
    RUNNING  = 'RUNNING'
    DONE     = 'DONE'
    FAILED   = 'FAILED'
    STATUS_CHOICES = [(s, s) for s in (PENDING, RUNNING, DONE, FAILED)]

    backup_type  = models.CharField(max_length=10, choices=TYPE_CHOICES)
    org          = models.ForeignKey(
        'accounts.Organisation', on_delete=models.SET_NULL,
        null=True, blank=True, related_name='backup_jobs',
        help_text='Target organisation for COMMAND or OFFICE backups.',
    )
    status       = models.CharField(max_length=10, choices=STATUS_CHOICES, default=PENDING)
    # Relative path from BACKUP_DIR
    file_path    = models.CharField(max_length=500, blank=True)
    file_size    = models.BigIntegerField(null=True, blank=True)
    encrypted    = models.BooleanField(default=True)
    # Summary counts: {records, features, documents, orgs, ...}
    result       = models.JSONField(default=dict)
    error_log    = models.TextField(blank=True)
    notes        = models.TextField(blank=True)
    created_by   = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL,
        null=True, related_name='backup_jobs',
    )
    schedule     = models.ForeignKey(
        'BackupSchedule', on_delete=models.SET_NULL,
        null=True, blank=True, related_name='jobs',
    )
    created_at   = models.DateTimeField(auto_now_add=True)
    completed_at = models.DateTimeField(null=True, blank=True)
    expires_at   = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ['-created_at']

    def __str__(self):
        org_label = f' ({self.org.code})' if self.org_id else ''
        return f'Backup {self.backup_type}{org_label} [{self.status}] {self.created_at:%Y-%m-%d}'

    @property
    def file_size_human(self) -> str:
        if not self.file_size:
            return '—'
        for unit in ('B', 'KB', 'MB', 'GB'):
            if self.file_size < 1024:
                return f'{self.file_size:.1f} {unit}'
            self.file_size /= 1024
        return f'{self.file_size:.1f} TB'


class BackupSchedule(models.Model):
    """Configures automated periodic backups executed via Celery Beat."""

    DAILY   = 'DAILY'
    WEEKLY  = 'WEEKLY'
    MONTHLY = 'MONTHLY'

    FREQ_CHOICES = [
        (DAILY,   'Daily'),
        (WEEKLY,  'Weekly (Sunday)'),
        (MONTHLY, 'Monthly (1st)'),
    ]

    name         = models.CharField(max_length=100)
    backup_type  = models.CharField(max_length=10, choices=BackupJob.TYPE_CHOICES)
    org          = models.ForeignKey(
        'accounts.Organisation', on_delete=models.SET_NULL,
        null=True, blank=True, related_name='backup_schedules',
    )
    frequency    = models.CharField(max_length=10, choices=FREQ_CHOICES, default=DAILY)
    # UTC hour to run (0-23)
    run_hour     = models.PositiveSmallIntegerField(default=2, help_text='UTC hour (0–23)')
    encrypted    = models.BooleanField(default=True)
    retention_days = models.PositiveIntegerField(
        default=30, help_text='Delete backups older than this many days.'
    )
    is_active    = models.BooleanField(default=True)
    last_run     = models.DateTimeField(null=True, blank=True)
    created_by   = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL,
        null=True, related_name='backup_schedules',
    )
    created_at   = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['name']

    def __str__(self):
        org_label = f' — {self.org.code}' if self.org_id else ''
        return f'{self.name} ({self.frequency}{org_label})'
