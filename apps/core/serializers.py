from rest_framework import serializers
from .models import BasemapConfig, BrandingConfig


class BrandingConfigSerializer(serializers.ModelSerializer):
    class Meta:
        model = BrandingConfig
        fields = ['app_title', 'app_subtitle', 'login_tagline',
                  'primary_color', 'logo_url', 'updated_at']
        read_only_fields = ['updated_at']


class BasemapConfigSerializer(serializers.ModelSerializer):
    provider_display  = serializers.CharField(source='get_provider_display', read_only=True)
    created_by_name   = serializers.CharField(source='created_by.get_full_name', read_only=True)

    class Meta:
        model = BasemapConfig
        fields = [
            'id', 'name', 'provider', 'provider_display',
            'url_template', 'attribution',
            'is_active', 'is_default', 'is_system',
            'created_by', 'created_by_name', 'created_at',
        ]
        read_only_fields = ['id', 'is_system', 'created_by', 'created_at']
