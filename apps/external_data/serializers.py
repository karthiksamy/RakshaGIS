from rest_framework import serializers
from .models import ExternalDatabase, ExternalLayer, GISServerConnection, GISServerLayer


class ExternalDatabaseSerializer(serializers.ModelSerializer):
    layer_count  = serializers.SerializerMethodField()
    password_set = serializers.SerializerMethodField()

    class Meta:
        model  = ExternalDatabase
        fields = [
            'id', 'name', 'host', 'port', 'database', 'schema',
            'username', 'password',
            'is_active', 'description',
            'test_status', 'test_message', 'last_tested_at', 'last_sync_at',
            'layer_count', 'password_set',
            'created_at', 'updated_at',
        ]
        extra_kwargs = {
            'password': {'write_only': True, 'required': False},
        }

    def get_layer_count(self, obj):
        return obj.layers.filter(is_active=True).count()

    def get_password_set(self, obj):
        return bool(obj.password)

    def to_representation(self, instance):
        rep = super().to_representation(instance)
        # Never expose the password in responses
        rep.pop('password', None)
        return rep


class ExternalLayerSerializer(serializers.ModelSerializer):
    database_name = serializers.CharField(source='database.name', read_only=True)

    class Meta:
        model  = ExternalLayer
        fields = [
            'id', 'database', 'database_name',
            'table_name', 'schema_name', 'display_name', 'description',
            'geometry_column', 'geometry_type', 'srid',
            'id_column', 'label_column', 'include_columns', 'analysis_columns',
            'cantonment_scope',
            'office_filter_field', 'level_filter_fields',
            'style', 'inside_render_type', 'classification_field', 'classification_colors',
            'min_zoom', 'is_active', 'display_order',
            'feature_count', 'bbox', 'last_synced_at',
            'created_at',
        ]
        read_only_fields = ['id', 'feature_count', 'bbox', 'last_synced_at', 'created_at']
        extra_kwargs = {
            'level_filter_fields': {'required': False},
            'office_filter_field': {'required': False},
            'classification_field': {'required': False},
            'classification_colors': {'required': False},
            'cantonment_scope': {'required': False},
            'inside_render_type': {'required': False},
        }


class GISServerConnectionSerializer(serializers.ModelSerializer):
    layer_count  = serializers.SerializerMethodField()
    password_set = serializers.SerializerMethodField()
    token_set    = serializers.SerializerMethodField()
    server_type_display = serializers.CharField(source='get_server_type_display', read_only=True)

    class Meta:
        model  = GISServerConnection
        fields = [
            'id', 'name', 'server_type', 'server_type_display',
            'base_url', 'auth_type',
            'username', 'password', 'token',
            'is_active', 'description',
            'test_status', 'test_message', 'last_tested_at',
            'layer_count', 'password_set', 'token_set',
            'created_at', 'updated_at',
        ]
        extra_kwargs = {
            'password': {'write_only': True, 'required': False},
            'token':    {'write_only': True, 'required': False},
        }

    def get_layer_count(self, obj):
        return obj.layers.filter(is_active=True).count()

    def get_password_set(self, obj):
        return bool(obj.password)

    def get_token_set(self, obj):
        return bool(obj.token)

    def to_representation(self, instance):
        rep = super().to_representation(instance)
        rep.pop('password', None)
        rep.pop('token', None)
        return rep


class GISServerLayerSerializer(serializers.ModelSerializer):
    connection_name   = serializers.CharField(source='connection.name', read_only=True)
    server_type       = serializers.CharField(source='connection.server_type', read_only=True)
    protocol_display  = serializers.CharField(source='get_protocol_display', read_only=True)
    is_vector         = serializers.BooleanField(read_only=True)
    is_tile           = serializers.BooleanField(read_only=True)
    organisation_name = serializers.CharField(source='organisation.name', read_only=True, default=None)

    class Meta:
        model  = GISServerLayer
        fields = [
            'id', 'connection', 'connection_name', 'server_type',
            'protocol', 'protocol_display', 'layer_name', 'display_name', 'description',
            # Raster options
            'wms_version', 'wms_format', 'wms_params', 'wmts_matrix_set', 'arcgis_map_params',
            # Vector options
            'wfs_version', 'wfs_output_fmt', 'arcgis_query_suffix', 'geometry_type',
            # Style — same fields as ExternalLayer
            'style', 'classification_field', 'classification_colors',
            # Display
            'opacity', 'min_zoom', 'is_active', 'display_order',
            'feature_count', 'bbox', 'last_synced_at',
            'is_vector', 'is_tile',
            # Org scoping (read-only; set automatically on create)
            'organisation', 'organisation_name',
            'created_at',
        ]
        read_only_fields = [
            'id', 'connection_name', 'server_type', 'protocol_display',
            'is_vector', 'is_tile', 'feature_count', 'bbox', 'last_synced_at',
            'organisation', 'organisation_name', 'created_at',
        ]
