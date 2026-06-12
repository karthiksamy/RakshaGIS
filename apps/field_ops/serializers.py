from django.utils import timezone
from rest_framework import serializers

from .models import (
    EncroachmentRecord, EncroachmentAttachment,
    FieldDiaryEntry, DPREquipmentUsage,
    EquipmentCategory, EquipmentItem, EquipmentIssue, EquipmentMaintenance,
    SubmissionChecklist,
)


# ─────────────────────────────────────────────────────────────────────────────
# Encroachment
# ─────────────────────────────────────────────────────────────────────────────

class EncroachmentAttachmentSerializer(serializers.ModelSerializer):
    file_type_display = serializers.CharField(source='get_file_type_display', read_only=True)
    uploaded_by_name  = serializers.CharField(source='uploaded_by.get_full_name', read_only=True)

    class Meta:
        model  = EncroachmentAttachment
        fields = [
            'id', 'encroachment', 'file', 'file_type', 'file_type_display',
            'description', 'uploaded_by', 'uploaded_by_name', 'uploaded_at',
        ]
        read_only_fields = ['uploaded_by', 'uploaded_at']


class EncroachmentRecordSerializer(serializers.ModelSerializer):
    encroachment_type_display = serializers.CharField(
        source='get_encroachment_type_display', read_only=True)
    status_display    = serializers.CharField(source='get_status_display', read_only=True)
    organisation_name = serializers.CharField(source='organisation.name', read_only=True)
    detected_by_name  = serializers.CharField(source='detected_by.get_full_name', read_only=True)
    created_by_name   = serializers.CharField(source='created_by.get_full_name', read_only=True)
    parcel_name       = serializers.SerializerMethodField()
    attachments       = EncroachmentAttachmentSerializer(many=True, read_only=True)

    class Meta:
        model  = EncroachmentRecord
        fields = [
            'id',
            'organisation', 'organisation_name',
            'defence_parcel', 'parcel_name',
            'survey_project', 'gis_feature',
            'encroachment_type', 'encroachment_type_display',
            'encroacher_name', 'encroacher_address', 'encroacher_contact',
            'area_sqm',
            'detected_date', 'detected_by', 'detected_by_name',
            'status', 'status_display',
            'notice_date', 'notice_ref',
            'eviction_date', 'case_ref',
            'remarks',
            'attachments',
            'created_by', 'created_by_name', 'created_at', 'updated_at',
        ]
        read_only_fields = ['created_by', 'created_at', 'updated_at']

    def get_parcel_name(self, obj) -> str | None:
        try:
            return str(obj.defence_parcel) if obj.defence_parcel else None
        except Exception:
            return None


# ─────────────────────────────────────────────────────────────────────────────
# Field Diary / DPR
# ─────────────────────────────────────────────────────────────────────────────

class DPREquipmentUsageSerializer(serializers.ModelSerializer):
    equipment_name = serializers.CharField(source='equipment.name', read_only=True)

    class Meta:
        model  = DPREquipmentUsage
        fields = ['id', 'equipment', 'equipment_name', 'hours_used', 'notes']


class FieldDiaryEntrySerializer(serializers.ModelSerializer):
    weather_display      = serializers.CharField(source='get_weather_display', read_only=True)
    surveyor_name        = serializers.CharField(source='surveyor.get_full_name', read_only=True)
    survey_area_name     = serializers.CharField(source='survey_area.name', read_only=True)
    approved_by_name     = serializers.CharField(source='approved_by.get_full_name', read_only=True)
    created_by_name      = serializers.CharField(source='created_by.get_full_name', read_only=True)
    equipment_usage      = DPREquipmentUsageSerializer(
        source='dprequipmentusage_set', many=True, read_only=True)
    is_submitted         = serializers.SerializerMethodField()
    is_approved          = serializers.SerializerMethodField()

    class Meta:
        model  = FieldDiaryEntry
        fields = [
            'id',
            'survey_area', 'survey_area_name',
            'surveyor', 'surveyor_name',
            'date', 'weather', 'weather_display',
            'station_points_set', 'station_points_target',
            'work_description', 'difficulties_faced', 'next_day_plan', 'remarks',
            'manpower_count', 'manpower_details',
            'photographs_taken', 'progress_pct',
            'equipment_usage',
            'submitted_at', 'is_submitted',
            'approved_by', 'approved_by_name', 'approved_at', 'is_approved',
            'created_by', 'created_by_name', 'created_at', 'updated_at',
        ]
        read_only_fields = [
            'created_by', 'created_at', 'updated_at',
            'submitted_at', 'approved_by', 'approved_at',
        ]

    def get_is_submitted(self, obj) -> bool:
        return obj.submitted_at is not None

    def get_is_approved(self, obj) -> bool:
        return obj.approved_at is not None


# ─────────────────────────────────────────────────────────────────────────────
# Equipment
# ─────────────────────────────────────────────────────────────────────────────

class EquipmentCategorySerializer(serializers.ModelSerializer):
    item_count = serializers.IntegerField(source='items.count', read_only=True)

    class Meta:
        model  = EquipmentCategory
        fields = ['id', 'name', 'description', 'sort_order', 'item_count']


class EquipmentMaintenanceSerializer(serializers.ModelSerializer):
    maintenance_type_display = serializers.CharField(
        source='get_maintenance_type_display', read_only=True)
    recorded_by_name = serializers.CharField(source='recorded_by.get_full_name', read_only=True)

    class Meta:
        model  = EquipmentMaintenance
        fields = [
            'id', 'equipment',
            'maintenance_type', 'maintenance_type_display',
            'maintenance_date', 'performed_by_name',
            'cost', 'next_due_date', 'certificate_ref', 'notes',
            'recorded_by', 'recorded_by_name', 'created_at',
        ]
        read_only_fields = ['recorded_by', 'created_at']


class EquipmentIssueSerializer(serializers.ModelSerializer):
    issued_to_name   = serializers.CharField(source='issued_to.get_full_name', read_only=True)
    issued_by_name   = serializers.CharField(source='issued_by.get_full_name', read_only=True)
    returned_to_name = serializers.CharField(source='returned_to.get_full_name', read_only=True)
    equipment_name   = serializers.CharField(source='equipment.name', read_only=True)
    project_name     = serializers.CharField(source='issued_for_project.name', read_only=True)
    is_outstanding   = serializers.SerializerMethodField()

    class Meta:
        model  = EquipmentIssue
        fields = [
            'id', 'equipment', 'equipment_name',
            'issued_to', 'issued_to_name',
            'issued_for_project', 'project_name',
            'issued_date', 'expected_return_date',
            'issued_by', 'issued_by_name',
            'condition_at_issue',
            'actual_return_date', 'is_outstanding',
            'returned_to', 'returned_to_name',
            'condition_at_return',
            'remarks', 'created_at',
        ]
        read_only_fields = ['issued_by', 'created_at']

    def get_is_outstanding(self, obj) -> bool:
        return obj.actual_return_date is None


class EquipmentItemSerializer(serializers.ModelSerializer):
    status_display        = serializers.CharField(source='get_status_display', read_only=True)
    category_name         = serializers.CharField(source='category.name', read_only=True)
    owned_by_name         = serializers.CharField(source='owned_by.name', read_only=True)
    current_holder_name   = serializers.CharField(
        source='current_holder.get_full_name', read_only=True)
    created_by_name       = serializers.CharField(source='created_by.get_full_name', read_only=True)
    calibration_overdue   = serializers.SerializerMethodField()
    warranty_expired      = serializers.SerializerMethodField()
    active_issue          = serializers.SerializerMethodField()
    recent_maintenance    = EquipmentMaintenanceSerializer(
        source='maintenance_records', many=True, read_only=True)

    class Meta:
        model  = EquipmentItem
        fields = [
            'id', 'category', 'category_name',
            'name', 'make', 'model', 'serial_number', 'asset_tag',
            'owned_by', 'owned_by_name',
            'current_holder', 'current_holder_name',
            'status', 'status_display',
            'purchase_date', 'warranty_expiry', 'warranty_expired',
            'calibration_due', 'calibration_overdue',
            'location_note', 'notes',
            'active_issue',
            'recent_maintenance',
            'created_by', 'created_by_name', 'created_at', 'updated_at',
        ]
        read_only_fields = ['created_by', 'created_at', 'updated_at', 'status', 'current_holder']

    def get_calibration_overdue(self, obj) -> bool:
        if obj.calibration_due is None:
            return False
        return obj.calibration_due < timezone.now().date()

    def get_warranty_expired(self, obj) -> bool:
        if obj.warranty_expiry is None:
            return False
        return obj.warranty_expiry < timezone.now().date()

    def get_active_issue(self, obj) -> dict | None:
        issue = obj.issues.filter(actual_return_date__isnull=True).first()
        if issue is None:
            return None
        return {
            'id': issue.id,
            'issued_to': str(issue.issued_to),
            'issued_date': str(issue.issued_date),
            'expected_return_date': str(issue.expected_return_date) if issue.expected_return_date else None,
        }


# ─────────────────────────────────────────────────────────────────────────────
# Pre-Submission Checklist
# ─────────────────────────────────────────────────────────────────────────────

class SubmissionChecklistSerializer(serializers.ModelSerializer):
    checked_by_name     = serializers.CharField(source='checked_by.get_full_name', read_only=True)
    acknowledged_by_name = serializers.CharField(
        source='acknowledged_by.get_full_name', read_only=True)
    survey_area_name    = serializers.CharField(source='survey_area.name', read_only=True)
    can_submit          = serializers.SerializerMethodField()

    class Meta:
        model  = SubmissionChecklist
        fields = [
            'id', 'survey_area', 'survey_area_name',
            'checked_by', 'checked_by_name', 'checked_at',
            'checks', 'all_passed', 'blocking_count', 'warning_count',
            'can_submit',
            'acknowledged_by', 'acknowledged_by_name', 'acknowledged_at',
        ]
        read_only_fields = fields

    def get_can_submit(self, obj) -> bool:
        """True when all errors pass, OR user has acknowledged remaining warnings."""
        if obj.all_passed:
            return True
        if obj.blocking_count == 0 and obj.warning_count > 0:
            return obj.acknowledged_at is not None
        return False
