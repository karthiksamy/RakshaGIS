from django.contrib.gis import admin
from .models import SurveyProject, GISFeature, DefenceParcel


class GISFeatureInline(admin.TabularInline):
    model = GISFeature
    extra = 0
    fields = ['feature_id', 'layer_name', 'geometry_type', 'attributes', 'is_deleted']


@admin.register(SurveyProject)
class SurveyProjectAdmin(admin.GISModelAdmin):
    list_display = ['project_number', 'name', 'survey_type', 'priority', 'organisation', 'status', 'created_at']
    list_filter = ['status', 'survey_type', 'priority', 'organisation__level', 'state']
    search_fields = ['project_number', 'name']
    readonly_fields = ['created_by', 'created_at', 'updated_at']
    inlines = [GISFeatureInline]

    def save_model(self, request, obj, form, change):
        if not change:
            obj.created_by = request.user
        super().save_model(request, obj, form, change)


@admin.register(GISFeature)
class GISFeatureAdmin(admin.GISModelAdmin):
    list_display = ['feature_id', 'layer_name', 'geometry_type', 'project', 'is_deleted', 'created_at']
    list_filter = ['geometry_type', 'is_deleted', 'layer_name']
    search_fields = ['feature_id', 'layer_name', 'project__project_number']


@admin.register(DefenceParcel)
class DefenceParcelAdmin(admin.GISModelAdmin):
    list_display = ['parcel_id', 'name', 'category', 'classification', 'organisation', 'area_hectares']
    list_filter = ['category', 'classification', 'state']
    search_fields = ['parcel_id', 'name']
    filter_horizontal = ['revenue_maps']
