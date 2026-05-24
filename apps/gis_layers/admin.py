from django.contrib.gis import admin
from .models import State, District, Taluk, Village, RevenueMap


@admin.register(State)
class StateAdmin(admin.GISModelAdmin):
    list_display = ['name', 'code']
    search_fields = ['name', 'code']


@admin.register(District)
class DistrictAdmin(admin.GISModelAdmin):
    list_display = ['name', 'code', 'state']
    list_filter = ['state']
    search_fields = ['name', 'code']


@admin.register(Taluk)
class TalukAdmin(admin.GISModelAdmin):
    list_display = ['name', 'code', 'district']
    list_filter = ['district__state']
    search_fields = ['name', 'code']


@admin.register(Village)
class VillageAdmin(admin.GISModelAdmin):
    list_display = ['name', 'code', 'taluk']
    list_filter = ['taluk__district__state']
    search_fields = ['name', 'code']


@admin.register(RevenueMap)
class RevenueMapAdmin(admin.GISModelAdmin):
    list_display = ['survey_number', 'village', 'area_hectares', 'classification']
    list_filter = ['village__taluk__district__state', 'classification']
    search_fields = ['survey_number']
