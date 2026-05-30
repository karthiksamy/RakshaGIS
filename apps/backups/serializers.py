from rest_framework import serializers
from .models import BackupJob, BackupSchedule


class BackupJobSerializer(serializers.ModelSerializer):
    org_name = serializers.CharField(source='org.name', read_only=True)
    org_code = serializers.CharField(source='org.code', read_only=True)
    org_level = serializers.CharField(source='org.level', read_only=True)
    created_by_name = serializers.CharField(source='created_by.username', read_only=True)
    file_size_human = serializers.SerializerMethodField()

    class Meta:
        model = BackupJob
        fields = [
            'id', 'backup_type', 'org', 'org_name', 'org_code', 'org_level',
            'status', 'file_path', 'file_size', 'file_size_human',
            'encrypted', 'result', 'error_log', 'notes',
            'created_by', 'created_by_name', 'schedule',
            'created_at', 'completed_at', 'expires_at',
        ]
        read_only_fields = [
            'status', 'file_path', 'file_size', 'result', 'error_log',
            'created_by', 'created_at', 'completed_at', 'expires_at',
        ]

    def get_file_size_human(self, obj):
        n = obj.file_size
        if not n:
            return '—'
        for unit in ('B', 'KB', 'MB', 'GB'):
            if n < 1024:
                return f'{n:.1f} {unit}'
            n /= 1024
        return f'{n:.1f} TB'


class BackupScheduleSerializer(serializers.ModelSerializer):
    org_name = serializers.CharField(source='org.name', read_only=True)
    org_code = serializers.CharField(source='org.code', read_only=True)
    created_by_name = serializers.CharField(source='created_by.username', read_only=True)
    recent_job_status = serializers.SerializerMethodField()

    class Meta:
        model = BackupSchedule
        fields = [
            'id', 'name', 'backup_type', 'org', 'org_name', 'org_code',
            'frequency', 'run_hour', 'encrypted', 'retention_days',
            'is_active', 'last_run', 'created_by', 'created_by_name',
            'created_at', 'recent_job_status',
        ]
        read_only_fields = ['created_by', 'created_at', 'last_run']

    def get_recent_job_status(self, obj):
        last = obj.jobs.order_by('-created_at').first()
        return last.status if last else None
