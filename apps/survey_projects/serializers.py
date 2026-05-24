from rest_framework import serializers
from rest_framework_gis.serializers import GeoFeatureModelSerializer
from .models import SurveyProject, GISFeature, DefenceParcel, AttributeTemplate, ShapefileImport


class SurveyProjectSerializer(serializers.ModelSerializer):
    created_by_name = serializers.CharField(source='created_by.get_full_name', read_only=True)
    organisation_name = serializers.CharField(source='organisation.name', read_only=True)
    status_display = serializers.CharField(source='get_status_display', read_only=True)
    survey_type_display = serializers.CharField(source='get_survey_type_display', read_only=True)
    priority_display = serializers.CharField(source='get_priority_display', read_only=True)

    class Meta:
        model = SurveyProject
        fields = [
            'id', 'name', 'project_number', 'description',
            'survey_type', 'survey_type_display',
            'priority', 'priority_display',
            'organisation', 'organisation_name',
            'status', 'status_display',
            'state', 'district', 'taluk', 'village',
            'total_area_hectares', 'start_date', 'target_date',
            'created_by', 'created_by_name', 'created_at', 'updated_at',
        ]
        read_only_fields = ['created_by', 'created_at', 'updated_at', 'status']


class GISFeatureSerializer(GeoFeatureModelSerializer):
    created_by_name = serializers.CharField(source='created_by.get_full_name', read_only=True)

    class Meta:
        model = GISFeature
        geo_field = 'geometry'
        fields = [
            'id', 'project', 'feature_id', 'layer_name', 'geometry_type',
            'attributes', 'is_deleted',
            'created_by', 'created_by_name', 'created_at', 'updated_at',
        ]
        read_only_fields = ['created_by', 'created_at', 'updated_at']


class DefenceParcelSerializer(GeoFeatureModelSerializer):
    organisation_name = serializers.CharField(source='organisation.name', read_only=True)
    category_display = serializers.CharField(source='get_category_display', read_only=True)
    classification_display = serializers.CharField(source='get_classification_display', read_only=True)
    state_name = serializers.CharField(source='state.name', read_only=True)
    district_name = serializers.CharField(source='district.name', read_only=True)

    class Meta:
        model = DefenceParcel
        geo_field = 'geometry'
        fields = [
            'id', 'parcel_id', 'name',
            'category', 'category_display',
            'classification', 'classification_display',
            'organisation', 'organisation_name',
            'state', 'state_name', 'district', 'district_name', 'taluk', 'village',
            'area_hectares',
            'revenue_maps', 'survey_project',
            'encumbrance_notes', 'remarks',
            'created_at', 'updated_at',
        ]
        read_only_fields = ['created_at', 'updated_at']


class AttributeTemplateSerializer(serializers.ModelSerializer):
    organisation_name = serializers.CharField(source='organisation.name', read_only=True)
    created_by_name   = serializers.CharField(source='created_by.get_full_name', read_only=True)

    class Meta:
        model = AttributeTemplate
        fields = [
            'id', 'organisation', 'organisation_name',
            'layer_name', 'description', 'fields',
            'created_by', 'created_by_name', 'created_at', 'updated_at',
        ]
        read_only_fields = ['id', 'created_by', 'created_at', 'updated_at']


class ShapefileImportSerializer(serializers.ModelSerializer):
    created_by_name = serializers.CharField(source='created_by.get_full_name', read_only=True)
    status_display  = serializers.CharField(source='get_status_display', read_only=True)

    class Meta:
        model = ShapefileImport
        fields = [
            'id', 'project', 'file', 'layer_name',
            'attribute_template', 'status', 'status_display',
            'feature_count', 'error',
            'created_by', 'created_by_name', 'created_at',
        ]
        read_only_fields = ['id', 'status', 'feature_count', 'error', 'created_by', 'created_at']
