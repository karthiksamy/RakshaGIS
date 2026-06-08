from rest_framework import serializers
from .models import BasemapConfig, BrandingConfig, DroneDataset


class BrandingConfigSerializer(serializers.ModelSerializer):
    class Meta:
        model = BrandingConfig
        fields = ['app_title', 'app_subtitle', 'login_tagline',
                  'primary_color', 'logo_url', 'updated_at']
        read_only_fields = ['updated_at']


class BasemapConfigSerializer(serializers.ModelSerializer):
    provider_display  = serializers.CharField(source='get_provider_display', read_only=True)
    created_by_name   = serializers.CharField(source='created_by.get_full_name', read_only=True)
    cog_url           = serializers.SerializerMethodField()
    organisation_name = serializers.CharField(source='organisation.name', read_only=True, default=None)

    class Meta:
        model = BasemapConfig
        fields = [
            'id', 'name', 'provider', 'provider_display',
            'url_template', 'api_key', 'attribution',
            'is_active', 'is_default', 'is_system',
            'organisation', 'organisation_name',
            # LOCAL_COG fields
            'cog_status', 'cog_error', 'cog_url',
            'bounds_west', 'bounds_south', 'bounds_east', 'bounds_north',
            'created_by', 'created_by_name', 'created_at',
        ]
        read_only_fields = [
            'id', 'is_system', 'created_by', 'created_at',
            'cog_status', 'cog_error', 'cog_url',
            'bounds_west', 'bounds_south', 'bounds_east', 'bounds_north',
            'organisation_name',
        ]

    def get_cog_url(self, obj):
        if not obj.cog_file:
            return None
        request = self.context.get('request')
        if request:
            return request.build_absolute_uri(obj.cog_file.url)
        return obj.cog_file.url


class DroneDatasetSerializer(serializers.ModelSerializer):
    data_type_display  = serializers.CharField(source='get_data_type_display', read_only=True)
    status_display     = serializers.CharField(source='get_status_display', read_only=True)
    uploaded_by_name   = serializers.CharField(source='uploaded_by.get_full_name', read_only=True)
    organisation_name  = serializers.CharField(source='organisation.name', read_only=True)
    cog_url            = serializers.SerializerMethodField()
    file_url           = serializers.SerializerMethodField()
    potree_url         = serializers.SerializerMethodField()
    tiles_url          = serializers.SerializerMethodField()

    class Meta:
        model = DroneDataset
        fields = [
            'id', 'name', 'description', 'data_type', 'data_type_display',
            'organisation', 'organisation_name',
            'project', 'folder',
            'file_url', 'file_size', 'original_filename',
            'cog_url',
            'bounds_west', 'bounds_south', 'bounds_east', 'bounds_north',
            'native_crs',
            'point_cloud_meta',
            'potree_url', 'tiles_url',
            'status', 'status_display', 'error',
            'is_visible', 'opacity',
            'uploaded_by', 'uploaded_by_name',
            'created_at', 'updated_at',
        ]
        read_only_fields = [
            'id', 'cog_url', 'file_url', 'potree_url', 'tiles_url',
            'bounds_west', 'bounds_south', 'bounds_east', 'bounds_north',
            'native_crs', 'point_cloud_meta',
            'status', 'error', 'file_size',
            'uploaded_by', 'uploaded_by_name', 'organisation_name',
            'data_type_display', 'status_display',
            'created_at', 'updated_at',
        ]

    def _abs_url(self, file_field):
        if not file_field:
            return None
        request = self.context.get('request')
        if request:
            return request.build_absolute_uri(file_field.url)
        return file_field.url

    def get_cog_url(self, obj):
        return self._abs_url(obj.cog_file) if obj.cog_file else None

    def get_file_url(self, obj):
        return self._abs_url(obj.file) if obj.file else None

    def get_potree_url(self, obj):
        if not obj.potree_path:
            return None
        from django.conf import settings
        import os
        rel = obj.potree_path
        request = self.context.get('request')
        media_url = settings.MEDIA_URL.rstrip('/')
        url = f"{media_url}/{rel}/cloud.js"
        return request.build_absolute_uri(url) if request else url

    def get_tiles_url(self, obj):
        if not obj.tiles_path:
            return None
        from django.conf import settings
        request = self.context.get('request')
        media_url = settings.MEDIA_URL.rstrip('/')
        url = f"{media_url}/{obj.tiles_path}"
        return request.build_absolute_uri(url) if request else url
