from django.db import models
from django.conf import settings


class ReportSchedule(models.Model):
    DAILY = 'DAILY'
    WEEKLY = 'WEEKLY'
    MONTHLY = 'MONTHLY'

    FREQUENCY_CHOICES = [
        (DAILY, 'Daily'),
        (WEEKLY, 'Weekly'),
        (MONTHLY, 'Monthly'),
    ]

    STATUS_SUMMARY   = 'STATUS_SUMMARY'
    FEATURE_EXPORT   = 'FEATURE_EXPORT'
    ACTIVITY_LOG     = 'ACTIVITY_LOG'
    TERRAIN_SUMMARY  = 'TERRAIN_SUMMARY'

    REPORT_TYPE_CHOICES = [
        (STATUS_SUMMARY,  'Project Status Summary'),
        (FEATURE_EXPORT,  'Feature Data Export'),
        (ACTIVITY_LOG,    'User Activity Log'),
        (TERRAIN_SUMMARY, 'Terrain Analysis Summary'),
    ]

    name = models.CharField(max_length=200)
    report_type = models.CharField(max_length=20, choices=REPORT_TYPE_CHOICES)
    frequency = models.CharField(max_length=10, choices=FREQUENCY_CHOICES, default=WEEKLY)
    recipients = models.TextField(help_text='Comma-separated email addresses')
    organisation = models.ForeignKey(
        'accounts.Organisation', on_delete=models.CASCADE, related_name='report_schedules'
    )
    is_active = models.BooleanField(default=True)
    filters = models.JSONField(default=dict, blank=True)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, related_name='report_schedules'
    )
    created_at = models.DateTimeField(auto_now_add=True)
    last_sent = models.DateTimeField(null=True, blank=True)
    next_run = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ['name']
        indexes = [models.Index(fields=['is_active', 'next_run'])]

    def __str__(self):
        return f"{self.name} ({self.get_frequency_display()})"
