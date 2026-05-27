from rest_framework import serializers
from .models import ReportSchedule


class ReportScheduleSerializer(serializers.ModelSerializer):
    report_type_display = serializers.CharField(source='get_report_type_display', read_only=True)
    frequency_display = serializers.CharField(source='get_frequency_display', read_only=True)
    organisation_name = serializers.CharField(source='organisation.name', read_only=True)
    created_by_name = serializers.CharField(source='created_by.get_full_name', read_only=True)

    class Meta:
        model = ReportSchedule
        fields = [
            'id', 'name', 'report_type', 'report_type_display',
            'frequency', 'frequency_display',
            'recipients', 'organisation', 'organisation_name',
            'is_active', 'filters',
            'created_by', 'created_by_name',
            'created_at', 'last_sent', 'next_run',
        ]
        read_only_fields = ['created_by', 'created_at', 'last_sent']
