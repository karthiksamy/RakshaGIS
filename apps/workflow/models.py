from django.conf import settings
from django.db import models


class WorkflowStep(models.Model):
    FORWARD   = 'FORWARD'    # SDO forwards draft to Checker
    RE_FORWARD = 'RE_FORWARD' # SDO re-forwards after return
    CHECK     = 'CHECK'      # Checker sends to Approver
    RETURN    = 'RETURN'     # Checker or Approver returns for revision
    APPROVE   = 'APPROVE'    # Approver approves
    PUBLISH   = 'PUBLISH'    # DEO Admin publishes

    ACTION_CHOICES = [
        (FORWARD,    'Forwarded for Checking'),
        (RE_FORWARD, 'Re-forwarded after Revision'),
        (CHECK,      'Sent to Approver'),
        (RETURN,     'Returned for Revision'),
        (APPROVE,    'Approved'),
        (PUBLISH,    'Published'),
    ]

    project = models.ForeignKey(
        'survey_projects.SurveyProject', on_delete=models.CASCADE, related_name='workflow_steps',
        null=True, blank=True,
    )
    # Workflow is primarily tracked at the survey-area level
    survey_area = models.ForeignKey(
        'survey_projects.SurveyArea', on_delete=models.CASCADE, related_name='workflow_steps',
        null=True, blank=True,
    )
    action = models.CharField(max_length=12, choices=ACTION_CHOICES)
    actor = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name='workflow_actions'
    )
    remarks = models.TextField(blank=True)
    timestamp = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['timestamp']

    def __str__(self):
        target = self.survey_area or self.project
        return f"{target} — {self.get_action_display()} by {self.actor}"


class AuditLog(models.Model):
    CREATE = 'CREATE'
    UPDATE = 'UPDATE'
    DELETE = 'DELETE'

    ACTION_CHOICES = [
        (CREATE, 'Created'),
        (UPDATE, 'Updated'),
        (DELETE, 'Deleted'),
    ]

    user = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL,
        null=True, related_name='audit_logs'
    )
    action = models.CharField(max_length=10, choices=ACTION_CHOICES)
    model_name = models.CharField(max_length=100)
    object_id = models.CharField(max_length=50)
    object_repr = models.CharField(max_length=200, blank=True)
    changes = models.JSONField(default=dict)
    ip_address = models.GenericIPAddressField(null=True, blank=True)
    timestamp = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['-timestamp']
        indexes = [
            models.Index(fields=['model_name', 'object_id']),
            models.Index(fields=['user', 'timestamp']),
        ]

    def __str__(self):
        return f"{self.get_action_display()} {self.model_name}:{self.object_id} by {self.user}"


class Notification(models.Model):
    WORKFLOW = 'WORKFLOW'
    SYSTEM = 'SYSTEM'
    AI = 'AI'

    TYPE_CHOICES = [
        (WORKFLOW, 'Workflow Update'),
        (SYSTEM, 'System'),
        (AI, 'AI Task'),
    ]

    recipient = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name='notifications'
    )
    title = models.CharField(max_length=200)
    message = models.TextField()
    notification_type = models.CharField(max_length=10, choices=TYPE_CHOICES, default=WORKFLOW)
    project = models.ForeignKey(
        'survey_projects.SurveyProject', on_delete=models.SET_NULL,
        null=True, blank=True, related_name='notifications'
    )
    is_read = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['-created_at']
        indexes = [
            models.Index(fields=['recipient', 'is_read']),
        ]

    def __str__(self):
        return f"[{self.get_notification_type_display()}] {self.title} → {self.recipient}"


class DisputeReport(models.Model):
    """Records the result of a spatial overlap check run before a survey-area submission."""
    CLEAN        = 'CLEAN'
    HAS_DISPUTES = 'HAS_DISPUTES'
    STATUS_CHOICES = [(CLEAN, 'Clean'), (HAS_DISPUTES, 'Has Disputes')]

    survey_area   = models.ForeignKey(
        'survey_projects.SurveyArea', on_delete=models.CASCADE, related_name='dispute_reports'
    )
    checked_at    = models.DateTimeField(auto_now_add=True)
    checked_by    = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, related_name='+'
    )
    status        = models.CharField(max_length=15, choices=STATUS_CHOICES, default=CLEAN)
    # List of dicts: source_feature_id, source_layer, target_feature_id, target_layer,
    # target_project, target_org, overlap_sqm
    disputes      = models.JSONField(default=list)
    acknowledged  = models.BooleanField(default=False)
    acknowledged_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True, related_name='+'
    )
    acknowledged_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ['-checked_at']

    def __str__(self):
        return f'DisputeReport({self.survey_area}, {self.status}, {self.checked_at:%Y-%m-%d})'
