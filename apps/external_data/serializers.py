from rest_framework import serializers
from .models import ExternalDatabase, ExternalLayer


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
            'id_column', 'label_column', 'include_columns',
            'office_filter_field',
            'style', 'min_zoom', 'is_active', 'display_order',
            'feature_count', 'bbox', 'last_synced_at',
            'created_at',
        ]
        read_only_fields = ['id', 'feature_count', 'bbox', 'last_synced_at', 'created_at']
