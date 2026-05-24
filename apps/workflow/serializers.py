from rest_framework import serializers
from .models import WorkflowStep, AuditLog, Notification


class WorkflowStepSerializer(serializers.ModelSerializer):
    actor_name = serializers.CharField(source='actor.get_full_name', read_only=True)
    action_display = serializers.CharField(source='get_action_display', read_only=True)

    class Meta:
        model = WorkflowStep
        fields = ['id', 'project', 'action', 'action_display', 'actor', 'actor_name', 'remarks', 'timestamp']
        read_only_fields = ['actor', 'timestamp']


class WorkflowTransitionSerializer(serializers.Serializer):
    remarks = serializers.CharField(required=False, allow_blank=True, default='')


class AuditLogSerializer(serializers.ModelSerializer):
    user_name = serializers.CharField(source='user.get_full_name', read_only=True)
    action_display = serializers.CharField(source='get_action_display', read_only=True)

    class Meta:
        model = AuditLog
        fields = [
            'id', 'user', 'user_name', 'action', 'action_display',
            'model_name', 'object_id', 'object_repr', 'changes',
            'ip_address', 'timestamp',
        ]
        read_only_fields = fields


class NotificationSerializer(serializers.ModelSerializer):
    notification_type_display = serializers.CharField(source='get_notification_type_display', read_only=True)
    project_number = serializers.CharField(source='project.project_number', read_only=True)

    class Meta:
        model = Notification
        fields = [
            'id', 'title', 'message',
            'notification_type', 'notification_type_display',
            'project', 'project_number',
            'is_read', 'created_at',
        ]
        read_only_fields = ['title', 'message', 'notification_type', 'project', 'created_at']
