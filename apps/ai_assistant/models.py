from django.db import models
from django.conf import settings


class ChatSession(models.Model):
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name='chat_sessions'
    )
    title = models.CharField(max_length=200, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['-updated_at']

    def __str__(self):
        return f"Chat {self.id} — {self.user}"


class ChatMessage(models.Model):
    USER = 'USER'
    ASSISTANT = 'ASSISTANT'

    ROLE_CHOICES = [
        (USER, 'User'),
        (ASSISTANT, 'Assistant'),
    ]

    session = models.ForeignKey(ChatSession, on_delete=models.CASCADE, related_name='messages')
    role = models.CharField(max_length=10, choices=ROLE_CHOICES)
    content = models.TextField()
    timestamp = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['timestamp']

    def __str__(self):
        return f"[{self.role}] {self.content[:60]}"


class AITask(models.Model):
    PENDING = 'PENDING'
    RUNNING = 'RUNNING'
    DONE = 'DONE'
    FAILED = 'FAILED'

    STATUS_CHOICES = [
        (PENDING, 'Pending'),
        (RUNNING, 'Running'),
        (DONE, 'Done'),
        (FAILED, 'Failed'),
    ]

    REPORT_GENERATION = 'REPORT_GENERATION'
    PDF_EXTRACTION = 'PDF_EXTRACTION'
    ATTRIBUTE_VALIDATION = 'ATTRIBUTE_VALIDATION'

    TASK_TYPE_CHOICES = [
        (REPORT_GENERATION, 'Report Generation'),
        (PDF_EXTRACTION, 'PDF Text Extraction & Summary'),
        (ATTRIBUTE_VALIDATION, 'Attribute Validation'),
    ]

    task_type = models.CharField(max_length=30, choices=TASK_TYPE_CHOICES)
    status = models.CharField(max_length=10, choices=STATUS_CHOICES, default=PENDING)
    requested_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, related_name='ai_tasks'
    )
    input_data = models.JSONField(default=dict)
    result = models.TextField(blank=True)
    error_message = models.TextField(blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    completed_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ['-created_at']

    def __str__(self):
        return f"{self.get_task_type_display()} — {self.status}"
