from django.contrib import admin
from .models import ChatSession, ChatMessage, AITask


class ChatMessageInline(admin.TabularInline):
    model = ChatMessage
    extra = 0
    readonly_fields = ['role', 'content', 'timestamp']


@admin.register(ChatSession)
class ChatSessionAdmin(admin.ModelAdmin):
    list_display = ['id', 'user', 'title', 'created_at']
    inlines = [ChatMessageInline]


@admin.register(AITask)
class AITaskAdmin(admin.ModelAdmin):
    list_display = ['task_type', 'status', 'requested_by', 'created_at', 'completed_at']
    list_filter = ['task_type', 'status']
    readonly_fields = ['input_data', 'result', 'error_message', 'created_at', 'completed_at']
