from django.contrib import admin

from .models import (
    EncroachmentRecord, EncroachmentAttachment,
    FieldDiaryEntry, DPREquipmentUsage,
    EquipmentCategory, EquipmentItem, EquipmentIssue, EquipmentMaintenance,
    SubmissionChecklist,
)


class EncroachmentAttachmentInline(admin.TabularInline):
    model  = EncroachmentAttachment
    extra  = 0
    fields = ['file', 'file_type', 'description', 'uploaded_by', 'uploaded_at']
    readonly_fields = ['uploaded_by', 'uploaded_at']


@admin.register(EncroachmentRecord)
class EncroachmentRecordAdmin(admin.ModelAdmin):
    list_display  = ['id', 'encroacher_name', 'encroachment_type', 'status',
                     'organisation', 'detected_date', 'area_sqm']
    list_filter   = ['status', 'encroachment_type', 'organisation']
    search_fields = ['encroacher_name', 'notice_ref', 'case_ref']
    inlines       = [EncroachmentAttachmentInline]
    readonly_fields = ['created_by', 'created_at', 'updated_at']


class DPREquipmentUsageInline(admin.TabularInline):
    model  = DPREquipmentUsage
    extra  = 0
    fields = ['equipment', 'hours_used', 'notes']


@admin.register(FieldDiaryEntry)
class FieldDiaryEntryAdmin(admin.ModelAdmin):
    list_display  = ['id', 'date', 'surveyor', 'survey_area', 'progress_pct',
                     'submitted_at', 'approved_at']
    list_filter   = ['weather', 'survey_area__project__organisation']
    search_fields = ['surveyor__username', 'work_description']
    inlines       = [DPREquipmentUsageInline]
    readonly_fields = ['created_by', 'created_at', 'updated_at', 'submitted_at',
                       'approved_by', 'approved_at']


@admin.register(EquipmentCategory)
class EquipmentCategoryAdmin(admin.ModelAdmin):
    list_display = ['name', 'sort_order']
    ordering     = ['sort_order', 'name']


class EquipmentIssueInline(admin.TabularInline):
    model   = EquipmentIssue
    extra   = 0
    fields  = ['issued_to', 'issued_date', 'expected_return_date',
                'actual_return_date', 'condition_at_return']
    readonly_fields = ['created_at']


class EquipmentMaintenanceInline(admin.TabularInline):
    model   = EquipmentMaintenance
    extra   = 0
    fields  = ['maintenance_type', 'maintenance_date', 'performed_by_name',
                'next_due_date', 'certificate_ref']
    readonly_fields = ['created_at']


@admin.register(EquipmentItem)
class EquipmentItemAdmin(admin.ModelAdmin):
    list_display  = ['name', 'category', 'status', 'owned_by', 'current_holder',
                     'calibration_due', 'asset_tag', 'serial_number']
    list_filter   = ['status', 'category', 'owned_by']
    search_fields = ['name', 'serial_number', 'asset_tag', 'make', 'model']
    inlines       = [EquipmentIssueInline, EquipmentMaintenanceInline]
    readonly_fields = ['created_by', 'created_at', 'updated_at', 'current_holder', 'status']


@admin.register(EquipmentIssue)
class EquipmentIssueAdmin(admin.ModelAdmin):
    list_display  = ['equipment', 'issued_to', 'issued_date', 'expected_return_date',
                     'actual_return_date', 'condition_at_return']
    list_filter   = ['condition_at_return']
    search_fields = ['equipment__name', 'issued_to__username']
    readonly_fields = ['created_at']


@admin.register(EquipmentMaintenance)
class EquipmentMaintenanceAdmin(admin.ModelAdmin):
    list_display  = ['equipment', 'maintenance_type', 'maintenance_date',
                     'performed_by_name', 'next_due_date']
    list_filter   = ['maintenance_type']
    search_fields = ['equipment__name', 'performed_by_name', 'certificate_ref']
    readonly_fields = ['created_at']


@admin.register(SubmissionChecklist)
class SubmissionChecklistAdmin(admin.ModelAdmin):
    list_display  = ['survey_area', 'checked_by', 'checked_at', 'all_passed',
                     'blocking_count', 'warning_count', 'acknowledged_at']
    list_filter   = ['all_passed']
    readonly_fields = list_display + ['checks', 'acknowledged_by']
