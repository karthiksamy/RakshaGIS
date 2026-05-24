from rest_framework import serializers
from .models import Document


class DocumentSerializer(serializers.ModelSerializer):
    uploaded_by_name = serializers.CharField(source='uploaded_by.get_full_name', read_only=True)
    category_display = serializers.CharField(source='get_category_display', read_only=True)
    file_url = serializers.SerializerMethodField()

    class Meta:
        model = Document
        fields = [
            'id', 'project', 'title', 'category', 'category_display',
            'file', 'file_url', 'file_size', 'mime_type',
            'ai_summary', 'extracted_text', 'ai_processed',
            'uploaded_by', 'uploaded_by_name', 'uploaded_at',
        ]
        read_only_fields = ['uploaded_by', 'uploaded_at', 'ai_summary', 'extracted_text', 'ai_processed']

    def get_file_url(self, obj):
        request = self.context.get('request')
        if obj.file and request:
            return request.build_absolute_uri(obj.file.url)
        return None

    def create(self, validated_data):
        file = validated_data.get('file')
        if file:
            validated_data['file_size'] = file.size
            validated_data['mime_type'] = getattr(file, 'content_type', '')
        return super().create(validated_data)
