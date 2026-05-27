from rest_framework import serializers
from .models import ChatSession, ChatMessage, AITask, LLMConfig


class ChatMessageSerializer(serializers.ModelSerializer):
    class Meta:
        model = ChatMessage
        fields = ['id', 'session', 'role', 'content', 'timestamp']
        read_only_fields = ['role', 'timestamp']


class ChatSessionSerializer(serializers.ModelSerializer):
    messages = ChatMessageSerializer(many=True, read_only=True)
    message_count = serializers.IntegerField(source='messages.count', read_only=True)

    class Meta:
        model = ChatSession
        fields = ['id', 'title', 'message_count', 'messages', 'created_at', 'updated_at']
        read_only_fields = ['created_at', 'updated_at']


class ChatInputSerializer(serializers.Serializer):
    message = serializers.CharField()


class LLMConfigSerializer(serializers.ModelSerializer):
    provider_display = serializers.CharField(source='get_provider_display', read_only=True)
    updated_by_name  = serializers.CharField(source='updated_by.get_full_name', read_only=True)

    class Meta:
        model = LLMConfig
        fields = [
            'id', 'name', 'provider', 'provider_display',
            'base_url', 'model_name', 'api_key', 'timeout',
            'is_active', 'notes',
            'updated_by', 'updated_by_name', 'updated_at', 'created_at',
        ]
        read_only_fields = ['updated_by', 'updated_at', 'created_at']
        extra_kwargs = {
            'api_key': {'write_only': False},  # show masked value in GET
        }

    def to_representation(self, instance):
        data = super().to_representation(instance)
        # Mask API key in list/retrieve — show last 4 chars only
        key = data.get('api_key', '')
        if key:
            data['api_key'] = '•' * max(0, len(key) - 4) + key[-4:]
        return data


class AITaskSerializer(serializers.ModelSerializer):
    task_type_display = serializers.CharField(source='get_task_type_display', read_only=True)
    status_display = serializers.CharField(source='get_status_display', read_only=True)
    requested_by_name = serializers.CharField(source='requested_by.get_full_name', read_only=True)

    class Meta:
        model = AITask
        fields = [
            'id', 'task_type', 'task_type_display', 'status', 'status_display',
            'requested_by', 'requested_by_name', 'input_data',
            'result', 'error_message', 'created_at', 'completed_at',
        ]
        read_only_fields = fields
