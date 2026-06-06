from rest_framework import serializers
from rest_framework_gis.serializers import GeoFeatureModelSerializer
from rest_framework_gis.fields import GeometryField
from .models import (
    SurveyProject, SurveyArea, GISFeature, DefenceParcel, AttributeTemplate,
    ShapefileImport, ProjectLayerFolder, ProjectShare, GeoTiffLayer,
    FeatureAttachment, ProjectMilestone, QGISUploadLog, TemporaryLayer,
    SurveyAreaAccessRequest, ReviewAnnotation, TopologyRule,
)


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
            'status', 'status_display', 'map_enabled',
            'state', 'district', 'taluk', 'village',
            'total_area_hectares', 'start_date', 'target_date',
            'created_by', 'created_by_name', 'created_at', 'updated_at',
        ]
        read_only_fields = ['project_number', 'created_by', 'created_at', 'updated_at', 'status', 'map_enabled']
        extra_kwargs = {'organisation': {'required': False}}


class SurveyAreaSerializer(serializers.ModelSerializer):
    assigned_to_name = serializers.CharField(source='assigned_to.get_full_name', read_only=True)
    created_by_name  = serializers.CharField(source='created_by.get_full_name', read_only=True)
    status_display   = serializers.CharField(source='get_status_display', read_only=True)
    folder_name      = serializers.CharField(source='folder.name', read_only=True)

    class Meta:
        model  = SurveyArea
        fields = [
            'id', 'project', 'name', 'area_code', 'description',
            'folder', 'folder_name',
            'assigned_to', 'assigned_to_name',
            'status', 'status_display', 'map_enabled',
            'created_by', 'created_by_name', 'created_at', 'updated_at',
        ]
        read_only_fields = ['created_by', 'created_at', 'updated_at', 'status', 'map_enabled']


class ProjectLayerFolderSerializer(serializers.ModelSerializer):
    children = serializers.SerializerMethodField()
    folder_type_display = serializers.CharField(source='get_folder_type_display', read_only=True)

    class Meta:
        model = ProjectLayerFolder
        fields = [
            'id', 'project', 'parent', 'name', 'folder_type', 'folder_type_display',
            'year', 'is_final', 'order', 'created_by', 'created_at', 'children',
        ]
        read_only_fields = ['created_by', 'created_at']

    def get_children(self, obj):
        return ProjectLayerFolderSerializer(obj.children.all(), many=True).data


class ProjectShareSerializer(serializers.ModelSerializer):
    project_name    = serializers.CharField(source='project.name', read_only=True)
    granted_to_name = serializers.CharField(source='granted_to.name', read_only=True)

    class Meta:
        model = ProjectShare
        fields = ['id', 'project', 'project_name', 'granted_to', 'granted_to_name', 'granted_by', 'created_at']
        read_only_fields = ['granted_by', 'created_at']


class _FolderPKField(serializers.PrimaryKeyRelatedField):
    """Accept any folder pk; silently return None when the folder no longer exists.

    folder is null=True/blank=True/on_delete=SET_NULL on GISFeature, so saving
    with folder=None is always safe.  Raising a 400 here would discard the whole
    feature — a stale folder id (e.g. after a DB reset or folder deletion) must
    not cause data loss.
    """
    def to_internal_value(self, data):
        try:
            return super().to_internal_value(data)
        except serializers.ValidationError:
            return None


class GISFeatureSerializer(serializers.ModelSerializer):
    created_by_name = serializers.CharField(source='created_by.get_full_name', read_only=True)
    geometry = GeometryField()
    # Override to remove validate_layer_name — layer_name is a plain text label
    # stored in a text column, not used as a SQL identifier, so strict naming is not needed
    layer_name = serializers.CharField(max_length=200)
    folder = _FolderPKField(queryset=ProjectLayerFolder.objects.all(), allow_null=True, required=False)

    class Meta:
        model = GISFeature
        fields = [
            'id', 'project', 'folder', 'feature_id', 'layer_name', 'geometry_type',
            'geometry', 'attributes', 'is_deleted', 'deo_visible',
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
    folder_name     = serializers.CharField(source='folder.name', read_only=True)

    class Meta:
        model = ShapefileImport
        fields = [
            'id', 'project', 'folder', 'folder_name', 'file', 'layer_name',
            'attribute_template', 'status', 'status_display', 'deo_visible',
            'feature_count', 'columns', 'error',
            'ai_processed', 'ai_summary',
            'created_by', 'created_by_name', 'created_at',
        ]
        read_only_fields = ['id', 'status', 'feature_count', 'columns', 'error',
                            'ai_processed', 'ai_summary', 'created_by', 'created_at']


class BufferParcelSerializer(serializers.ModelSerializer):
    organisation_name      = serializers.CharField(source='organisation.name', read_only=True)
    category_display       = serializers.CharField(source='get_category_display', read_only=True)
    classification_display = serializers.CharField(source='get_classification_display', read_only=True)
    state_name             = serializers.CharField(source='state.name', read_only=True)
    district_name          = serializers.CharField(source='district.name', read_only=True)
    geometry               = serializers.SerializerMethodField()

    class Meta:
        model = DefenceParcel
        fields = [
            'id', 'parcel_id', 'name',
            'category', 'category_display',
            'classification', 'classification_display',
            'area_hectares', 'state_name', 'district_name', 'organisation_name',
            'geometry',
        ]

    def get_geometry(self, obj):
        import json
        return json.loads(obj.geometry.geojson)


class GeoTiffLayerSerializer(serializers.ModelSerializer):
    created_by_name = serializers.CharField(source='created_by.get_full_name', read_only=True)
    status_display  = serializers.CharField(source='get_status_display', read_only=True)
    folder_name     = serializers.CharField(source='folder.name', read_only=True)
    cog_url         = serializers.SerializerMethodField()

    class Meta:
        model = GeoTiffLayer
        fields = [
            'id', 'project', 'folder', 'folder_name', 'name', 'file',
            'cog_file', 'cog_url', 'status', 'status_display', 'error',
            'is_visible', 'deo_visible', 'opacity',
            'created_by', 'created_by_name', 'created_at',
        ]
        read_only_fields = ['id', 'cog_file', 'status', 'error', 'created_by', 'created_at']

    def get_cog_url(self, obj):
        if obj.cog_file:
            request = self.context.get('request')
            if request:
                return request.build_absolute_uri(obj.cog_file.url)
            return obj.cog_file.url
        return None


class FeatureAttachmentSerializer(serializers.ModelSerializer):
    file_url = serializers.SerializerMethodField()
    uploaded_by_name = serializers.CharField(source='uploaded_by.get_full_name', read_only=True)

    class Meta:
        model = FeatureAttachment
        fields = [
            'id', 'feature', 'file', 'file_url', 'original_filename',
            'file_size', 'file_type', 'caption',
            'uploaded_by', 'uploaded_by_name', 'uploaded_at',
        ]
        read_only_fields = ['id', 'original_filename', 'file_size', 'file_type', 'uploaded_by', 'uploaded_at']

    def get_file_url(self, obj):
        request = self.context.get('request')
        if obj.file and request:
            return request.build_absolute_uri(obj.file.url)
        return obj.file.url if obj.file else None


class ProjectMilestoneSerializer(serializers.ModelSerializer):
    status_display = serializers.CharField(source='get_status_display', read_only=True)
    assignee_name = serializers.CharField(source='assignee.get_full_name', read_only=True)
    created_by_name = serializers.CharField(source='created_by.get_full_name', read_only=True)
    progress_pct = serializers.SerializerMethodField()

    class Meta:
        model = ProjectMilestone
        fields = [
            'id', 'project', 'name', 'description',
            'start_date', 'due_date', 'completed_date',
            'status', 'status_display', 'order',
            'assignee', 'assignee_name',
            'progress_pct',
            'created_by', 'created_by_name', 'created_at',
        ]
        read_only_fields = ['created_by', 'created_at']

    def get_progress_pct(self, obj):
        import datetime
        if obj.status == 'COMPLETED':
            return 100
        if not obj.start_date:
            return 0
        today = datetime.date.today()
        total = (obj.due_date - obj.start_date).days
        if total <= 0:
            return 0
        elapsed = (today - obj.start_date).days
        return min(100, max(0, int(elapsed / total * 100)))


class QGISUploadLogSerializer(serializers.ModelSerializer):
    uploaded_by_name = serializers.CharField(source='uploaded_by.get_full_name', read_only=True)
    project_number   = serializers.CharField(source='project.project_number', read_only=True)
    folder_name      = serializers.CharField(source='folder.name', read_only=True)

    class Meta:
        model  = QGISUploadLog
        fields = [
            'id', 'project', 'project_number', 'folder', 'folder_name',
            'filename', 'original_path', 'file_size',
            'algorithm_id', 'module_name',
            'status', 'error_message',
            'uploaded_by', 'uploaded_by_name', 'uploaded_at',
        ]
        read_only_fields = ['id', 'uploaded_at']


class TemporaryLayerSerializer(serializers.ModelSerializer):
    uploaded_by_name    = serializers.CharField(source='uploaded_by.get_full_name', read_only=True)
    file_format_display = serializers.CharField(source='get_file_format_display', read_only=True)
    purpose_type_display     = serializers.CharField(source='get_purpose_type_display', read_only=True)
    land_rights_type_display = serializers.CharField(source='get_land_rights_type_display', read_only=True)
    effective_purpose        = serializers.CharField(read_only=True)
    effective_land_rights    = serializers.CharField(read_only=True)

    class Meta:
        model  = TemporaryLayer
        fields = [
            'id', 'name', 'purpose',
            'purpose_type', 'purpose_type_display', 'purpose_other',
            'land_rights_type', 'land_rights_type_display', 'land_rights_other',
            'effective_purpose', 'effective_land_rights',
            'description',
            'file_format', 'file_format_display',
            'file', 'geojson', 'feature_count',
            'analysis_result', 'deo_visible',
            'uploaded_by', 'uploaded_by_name', 'created_at',
        ]
        read_only_fields = [
            'id', 'file_format', 'geojson', 'feature_count',
            'analysis_result',
            'uploaded_by', 'uploaded_by_name', 'created_at',
            'purpose_type_display', 'land_rights_type_display',
            'effective_purpose', 'effective_land_rights',
        ]


class SurveyAreaAccessRequestSerializer(serializers.ModelSerializer):
    requested_by_name  = serializers.CharField(source='requested_by.get_full_name',  read_only=True)
    reviewed_by_name   = serializers.CharField(source='reviewed_by.get_full_name',   read_only=True)
    requesting_org_name = serializers.CharField(source='requesting_org.name',        read_only=True)
    survey_area_name   = serializers.CharField(source='survey_area.name',            read_only=True)
    project_name       = serializers.CharField(source='survey_area.project.name',    read_only=True)
    project_id         = serializers.IntegerField(source='survey_area.project_id',   read_only=True)
    target_org_name    = serializers.CharField(
        source='survey_area.project.organisation.name', read_only=True
    )
    status_display     = serializers.CharField(source='get_status_display',          read_only=True)

    class Meta:
        model  = SurveyAreaAccessRequest
        fields = [
            'id', 'survey_area', 'survey_area_name', 'project_name', 'project_id',
            'requested_by', 'requested_by_name',
            'requesting_org', 'requesting_org_name',
            'target_org_name',
            'reason', 'status', 'status_display',
            'reviewed_by', 'reviewed_by_name', 'reviewed_at', 'review_remarks',
            'created_at',
        ]
        read_only_fields = [
            'id', 'requested_by', 'requesting_org', 'status',
            'reviewed_by', 'reviewed_at', 'created_at',
        ]


class ReviewAnnotationSerializer(GeoFeatureModelSerializer):
    created_by_name = serializers.CharField(source='created_by.get_full_name', read_only=True, default='')
    annotation_type_display = serializers.CharField(source='get_annotation_type_display', read_only=True)

    class Meta:
        model = ReviewAnnotation
        geo_field = 'geometry'
        fields = [
            'id', 'survey_area', 'annotation_type', 'annotation_type_display',
            'comment', 'color', 'is_resolved',
            'created_by', 'created_by_name', 'created_at', 'updated_at',
        ]
        read_only_fields = ['id', 'created_by', 'created_at', 'updated_at']


class TopologyRuleSerializer(serializers.ModelSerializer):
    rule_type_display = serializers.CharField(source='get_rule_type_display', read_only=True)
    created_by_name = serializers.CharField(source='created_by.get_full_name', read_only=True, default='')

    class Meta:
        model = TopologyRule
        fields = [
            'id', 'project', 'rule_type', 'rule_type_display',
            'layer_a', 'layer_b', 'tolerance', 'description',
            'is_active', 'created_by', 'created_by_name', 'created_at',
        ]
        read_only_fields = ['id', 'created_by', 'created_at']
