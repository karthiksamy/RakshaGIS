from django.contrib import admin
from .models import WorkflowStep, AuditLog, Notification


@admin.register(WorkflowStep)
class WorkflowStepAdmin(admin.ModelAdmin):
    list_display = ['project', 'action', 'actor', 'timestamp']
    list_filter = ['action']
    search_fields = ['project__project_number', 'actor__username']
    readonly_fields = ['project', 'action', 'actor', 'remarks', 'timestamp']


@admin.register(AuditLog)
class AuditLogAdmin(admin.ModelAdmin):
    list_display = ['action', 'model_name', 'object_id', 'user', 'ip_address', 'timestamp']
    list_filter = ['action', 'model_name']
    search_fields = ['model_name', 'object_repr', 'user__username']
    readonly_fields = ['action', 'model_name', 'object_id', 'object_repr', 'changes', 'user', 'ip_address', 'timestamp']


@admin.register(Notification)
class NotificationAdmin(admin.ModelAdmin):
    list_display = ['title', 'recipient', 'notification_type', 'is_read', 'created_at']
    list_filter = ['notification_type', 'is_read']
    search_fields = ['title', 'recipient__username']
    readonly_fields = ['title', 'message', 'notification_type', 'project', 'recipient', 'created_at']
