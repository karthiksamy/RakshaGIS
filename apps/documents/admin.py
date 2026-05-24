from django.contrib import admin
from .models import Document


@admin.register(Document)
class DocumentAdmin(admin.ModelAdmin):
    list_display = ['title', 'category', 'project', 'uploaded_by', 'ai_processed', 'uploaded_at']
    list_filter = ['category', 'ai_processed']
    search_fields = ['title', 'project__project_number']
    readonly_fields = ['uploaded_by', 'uploaded_at', 'file_size', 'mime_type', 'ai_summary', 'extracted_text']
