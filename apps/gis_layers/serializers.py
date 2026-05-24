from rest_framework_gis.serializers import GeoFeatureModelSerializer
from rest_framework import serializers
from .models import State, District, Taluk, Village, RevenueMap


class StateSerializer(GeoFeatureModelSerializer):
    class Meta:
        model = State
        geo_field = 'geometry'
        fields = ['id', 'name', 'code']


class DistrictSerializer(GeoFeatureModelSerializer):
    state_name = serializers.CharField(source='state.name', read_only=True)

    class Meta:
        model = District
        geo_field = 'geometry'
        fields = ['id', 'name', 'code', 'state', 'state_name']


class TalukSerializer(GeoFeatureModelSerializer):
    district_name = serializers.CharField(source='district.name', read_only=True)

    class Meta:
        model = Taluk
        geo_field = 'geometry'
        fields = ['id', 'name', 'code', 'district', 'district_name']


class VillageSerializer(GeoFeatureModelSerializer):
    taluk_name = serializers.CharField(source='taluk.name', read_only=True)

    class Meta:
        model = Village
        geo_field = 'geometry'
        fields = ['id', 'name', 'code', 'taluk', 'taluk_name']


class RevenueMapSerializer(GeoFeatureModelSerializer):
    village_name = serializers.CharField(source='village.name', read_only=True)

    class Meta:
        model = RevenueMap
        geo_field = 'geometry'
        fields = ['id', 'survey_number', 'village', 'village_name',
                  'area_hectares', 'classification', 'notes']
