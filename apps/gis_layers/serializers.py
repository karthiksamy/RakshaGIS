from rest_framework import serializers
from .models import State, District, Taluk, Village, RevenueMap, BoundaryImportJob


class StateSerializer(serializers.ModelSerializer):
    class Meta:
        model = State
        fields = ['id', 'name', 'code']
        extra_kwargs = {'geometry': {'required': False}}


class DistrictSerializer(serializers.ModelSerializer):
    state_name = serializers.CharField(source='state.name', read_only=True)

    class Meta:
        model = District
        fields = ['id', 'name', 'code', 'state', 'state_name']
        extra_kwargs = {'geometry': {'required': False}}


class TalukSerializer(serializers.ModelSerializer):
    district_name = serializers.CharField(source='district.name', read_only=True)

    class Meta:
        model = Taluk
        fields = ['id', 'name', 'code', 'district', 'district_name']
        extra_kwargs = {'geometry': {'required': False}}


class VillageSerializer(serializers.ModelSerializer):
    taluk_name = serializers.CharField(source='taluk.name', read_only=True)

    class Meta:
        model = Village
        fields = ['id', 'name', 'code', 'taluk', 'taluk_name']
        extra_kwargs = {'geometry': {'required': False}}


class RevenueMapSerializer(serializers.ModelSerializer):
    village_name = serializers.CharField(source='village.name', read_only=True)

    class Meta:
        model = RevenueMap
        fields = ['id', 'survey_number', 'village', 'village_name',
                  'area_hectares', 'classification', 'notes']
        extra_kwargs = {'geometry': {'required': False}}


class BoundaryImportJobSerializer(serializers.ModelSerializer):
    uploaded_by_name = serializers.CharField(source='uploaded_by.username', read_only=True)

    class Meta:
        model = BoundaryImportJob
        fields = [
            'id', 'level', 'file', 'name_field', 'code_field',
            'parent_code_field', 'spatial_parent', 'clear_existing',
            'status', 'result', 'error_log', 'uploaded_by', 'uploaded_by_name',
            'created_at', 'completed_at',
        ]
        read_only_fields = ['status', 'result', 'error_log', 'uploaded_by',
                            'uploaded_by_name', 'created_at', 'completed_at']
