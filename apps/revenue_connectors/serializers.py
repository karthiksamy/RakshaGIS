from rest_framework import serializers
from .models import RevenuePortalConnector, ParcelRevenueLink


class RevenuePortalConnectorSerializer(serializers.ModelSerializer):
    portal_type_display = serializers.CharField(source='get_portal_type_display', read_only=True)
    auth_type_display   = serializers.CharField(source='get_auth_type_display',   read_only=True)
    test_status_display = serializers.CharField(source='get_test_status_display', read_only=True)
    state_name          = serializers.CharField(source='state.name',              read_only=True)
    organisation_name   = serializers.CharField(source='organisation.name',       read_only=True)
    created_by_name     = serializers.CharField(source='created_by.get_full_name', read_only=True)

    class Meta:
        model  = RevenuePortalConnector
        fields = [
            'id', 'name', 'portal_type', 'portal_type_display',
            'state', 'state_name', 'organisation', 'organisation_name',
            'base_url', 'layer_name',
            'auth_type', 'auth_type_display',
            'api_key', 'username', 'password',
            'extra_params', 'is_active',
            'test_status', 'test_status_display', 'test_message', 'last_tested_at',
            'created_by', 'created_by_name', 'created_at', 'updated_at',
        ]
        read_only_fields = ['created_by', 'created_at', 'updated_at',
                            'test_status', 'test_message', 'last_tested_at']
        extra_kwargs = {
            'password': {'write_only': True},
            'api_key':  {'write_only': True},
        }


class ParcelRevenueLinkSerializer(serializers.ModelSerializer):
    connector_name    = serializers.CharField(source='connector.name',                   read_only=True)
    portal_type       = serializers.CharField(source='connector.portal_type',            read_only=True)
    portal_type_display = serializers.CharField(
        source='connector.get_portal_type_display', read_only=True)
    parcel_name       = serializers.SerializerMethodField()

    class Meta:
        model  = ParcelRevenueLink
        fields = [
            'id', 'defence_parcel', 'parcel_name',
            'connector', 'connector_name', 'portal_type', 'portal_type_display',
            'remote_survey_number', 'remote_owner', 'remote_area_ha', 'remote_land_type',
            'raw_attributes',
            'overlap_area_ha', 'overlap_pct',
            'discrepancy_flag', 'discrepancy_notes',
            'fetched_at',
        ]
        read_only_fields = fields

    def get_parcel_name(self, obj) -> str | None:
        try:
            return str(obj.defence_parcel)
        except Exception:
            return None
