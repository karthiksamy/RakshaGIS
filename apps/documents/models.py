from django.db import models
from django.conf import settings


def document_upload_path(instance, filename):
    from apps.core.folder_manager import document_upload_path as _path
    return _path(instance, filename)


class Document(models.Model):
    SURVEY_REPORT = 'SURVEY_REPORT'
    INSPECTION_REPORT = 'INSPECTION_REPORT'
    REVENUE_EXTRACT = 'REVENUE_EXTRACT'
    SKETCH = 'SKETCH'
    PHOTO = 'PHOTO'
    OTHER = 'OTHER'

    CATEGORY_CHOICES = [
        (SURVEY_REPORT, 'Survey Report'),
        (INSPECTION_REPORT, 'Inspection Report'),
        (REVENUE_EXTRACT, 'Revenue Extract'),
        (SKETCH, 'Sketch / Drawing'),
        (PHOTO, 'Photograph'),
        (OTHER, 'Other'),
    ]

    project = models.ForeignKey(
        'survey_projects.SurveyProject', on_delete=models.CASCADE, related_name='documents'
    )
    title = models.CharField(max_length=200)
    category = models.CharField(max_length=30, choices=CATEGORY_CHOICES, default=OTHER)
    file = models.FileField(upload_to=document_upload_path)
    file_size = models.PositiveIntegerField(null=True, blank=True)
    mime_type = models.CharField(max_length=100, blank=True)

    # Versioning
    version = models.PositiveSmallIntegerField(default=1)
    parent = models.ForeignKey(
        'self', null=True, blank=True,
        on_delete=models.SET_NULL, related_name='revisions',
        help_text='Previous version of this document'
    )

    # AI-populated fields
    ai_summary = models.TextField(blank=True)
    extracted_text = models.TextField(blank=True)
    ai_processed = models.BooleanField(default=False)

    uploaded_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name='uploaded_documents'
    )
    uploaded_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['-uploaded_at']
        indexes = [
            models.Index(fields=['project', 'category']),
        ]

    def __str__(self):
        return f"{self.title} ({self.get_category_display()})"
